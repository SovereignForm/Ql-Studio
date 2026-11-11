//! QL STUDIO — Tauri v2 IPC Commands, `hound` WAV Sampler & Audio Stream Controller
//!
//! Exposes `#[tauri::command]` endpoints (`play`, `pause`, `stop`, `set_bpm`, `set_swing`,
//! `update_pattern`, `update_mixer_graph`, `get_engine_status`, `import_flp_file`,
//! `load_sample_file`, `export_wav_file`, `get_audio_settings`, `set_audio_buffer_size`)
//! and configures `cpal` with `BufferSize::Fixed(1024)` for crackle-free PipeWire/ALSA playback.

use crate::dsp::{
    compute_rbj_biquad_coeffs, verify_acyclic_routing_graph, DagVerificationReport,
};
use crate::importers::flp::{parse_flp_file, QlProjectPayload};
use crate::sampler::{
    ensure_starter_drum_wav_files, load_wav_file_resampled, write_stereo_wav_file,
    LoadedSampleSummary, SharedStereoPcm, MAX_SAMPLE_SLOTS,
};
use crate::scheduler::{NativeLookaheadScheduler, RealTimeAudioEngine};
use crate::plugins::{PluginHostManager, SharedPluginHost};
use crate::schemas::{
    AudioScheduledEventKind, AudioSettingsSnapshot, EngineStatusSnapshot, PlayMode, PlaybackClockSnapshot, PluginDescriptor,
    PluginInstanceSummary, PpqResolution, QlChannel, QlMixerSend, QlMixerState, QlPattern,
    QlPlaylistState, RealTimeCommand, ScheduledAudioEventPod, TimeSignature, TimeStretchResult,
    WaveformShape, MAX_MIXER_INSERTS, MAX_MIXER_SENDS,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::{Consumer, Producer, RingBuffer};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::State;

pub const DEFAULT_HARDWARE_BUFFER_FRAMES: u32 = 1024;

pub struct SharedLookaheadState {
    pub scheduler: NativeLookaheadScheduler,
    pub pattern: QlPattern,
    pub channels: Vec<QlChannel>,
    pub event_producer: Producer<ScheduledAudioEventPod>,
    pub command_producer: Producer<RealTimeCommand>,
    pub sample_producer: Producer<(u8, SharedStereoPcm)>,
    pub sample_gc_consumer: Consumer<SharedStereoPcm>,
    pub loaded_samples: [Option<SharedStereoPcm>; MAX_SAMPLE_SLOTS],
    pub device_name: String,
    pub buffer_size_frames: u32,
    pub audio_stream_active: bool,
}

pub struct QlEngineController {
    pub shared: Arc<Mutex<SharedLookaheadState>>,
    pub is_playing_atomic: Arc<AtomicBool>,
    pub current_frame_estimate: Arc<AtomicU64>,
    pub hardware_latency_frames: Arc<AtomicU64>,
    pub plugin_host: SharedPluginHost,
    pub midi_manager: Arc<Mutex<crate::midi::MidiManager>>,
    pub audio_recorder: Arc<Mutex<crate::audio_record::AudioRecorderManager>>,
    _cpal_stream: Mutex<Option<Box<dyn Send + Sync>>>,
}

struct StreamHolder(#[allow(dead_code)] cpal::Stream);
// SAFETY: Stream handle is retained on the controller to keep the audio callback alive
unsafe impl Send for StreamHolder {}
unsafe impl Sync for StreamHolder {}

impl QlEngineController {
    pub fn new() -> Self {
        let (event_producer, event_consumer) = RingBuffer::<ScheduledAudioEventPod>::new(8192);
        let (command_producer, command_consumer) = RingBuffer::<RealTimeCommand>::new(1024);
        let (sample_producer, sample_consumer) = RingBuffer::<(u8, SharedStereoPcm)>::new(64);
        let (sample_gc_producer, sample_gc_consumer) = RingBuffer::<SharedStereoPcm>::new(64);

        let (midi_event_producer, midi_event_consumer) = RingBuffer::<ScheduledAudioEventPod>::new(2048);
        let (midi_cmd_producer, midi_cmd_consumer) = RingBuffer::<RealTimeCommand>::new(512);
        let (monitor_producer, monitor_consumer) = RingBuffer::<f32>::new(8192);

        let is_playing_atomic = Arc::new(AtomicBool::new(false));
        let current_frame_estimate = Arc::new(AtomicU64::new(0));
        let hardware_latency_frames = Arc::new(AtomicU64::new(DEFAULT_HARDWARE_BUFFER_FRAMES as u64));

        let (sample_rate, device_name, actual_buf_frames, stream_holder) =
            Self::try_spawn_cpal_stream(
                DEFAULT_HARDWARE_BUFFER_FRAMES,
                event_consumer,
                command_consumer,
                sample_consumer,
                sample_gc_producer,
                midi_event_consumer,
                midi_cmd_consumer,
                monitor_consumer,
                current_frame_estimate.clone(),
                hardware_latency_frames.clone(),
            );

        // Materialize starter drum kit .wav files into ../samples
        let samples_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("samples");
        ensure_starter_drum_wav_files(&samples_dir, sample_rate);

        let default_pattern = QlPattern {
            id: "pat_1".to_string(),
            index: 1,
            name: "Pattern 1".to_string(),
            color_hex: "#ff8500".to_string(),
            time_signature: TimeSignature {
                numerator: 4,
                denominator: 4,
            },
            step_count: 16,
            channel_data: HashMap::new(),
        };

        let starter_kit = crate::sampler::build_starter_drum_kit(sample_rate);
        let mut loaded_samples: [Option<SharedStereoPcm>; MAX_SAMPLE_SLOTS] =
            std::array::from_fn(|_| None);
        loaded_samples[0] = Some(starter_kit[0].clone());
        loaded_samples[1] = Some(starter_kit[1].clone());
        loaded_samples[2] = Some(starter_kit[2].clone());
        loaded_samples[3] = Some(starter_kit[3].clone());

        let shared = Arc::new(Mutex::new(SharedLookaheadState {
            scheduler: NativeLookaheadScheduler::new(
                140.0,
                PpqResolution::Ppq96,
                sample_rate,
                0.50,
            ),
            pattern: default_pattern,
            channels: Vec::new(),
            event_producer,
            command_producer,
            sample_producer,
            sample_gc_consumer,
            loaded_samples,
            device_name,
            buffer_size_frames: actual_buf_frames,
            audio_stream_active: stream_holder.is_some(),
        }));

        // Dedicated 4ms high-cadence lookahead scheduler + non-RT sample garbage collector thread
        let shared_bg = shared.clone();
        let playing_bg = is_playing_atomic.clone();
        let frame_bg = current_frame_estimate.clone();
        thread::Builder::new()
            .name("ql-studio-lookahead".to_string())
            .spawn(move || loop {
                thread::sleep(Duration::from_millis(4));
                if let Ok(mut guard) = shared_bg.lock() {
                    // Drain any retired sample buffers returned from the audio thread
                    while guard.sample_gc_consumer.pop().is_ok() {}

                    if !playing_bg.load(Ordering::Relaxed) {
                        continue;
                    }
                    let SharedLookaheadState {
                        scheduler,
                        pattern,
                        channels,
                        event_producer,
                        ..
                    } = &mut *guard;
                    let frame = frame_bg.load(Ordering::Relaxed);
                    scheduler.advance_lookahead(frame, pattern, channels, event_producer);
                }
            })
            .ok();

        let plugin_host = Arc::new(Mutex::new(PluginHostManager::new()));

        let midi_manager = Arc::new(Mutex::new(crate::midi::MidiManager::new(
            midi_event_producer,
            midi_cmd_producer,
            current_frame_estimate.clone(),
        )));

        let audio_recorder = Arc::new(Mutex::new(crate::audio_record::AudioRecorderManager::new(
            Some(monitor_producer),
        )));

        Self {
            shared,
            is_playing_atomic,
            current_frame_estimate,
            hardware_latency_frames,
            plugin_host,
            midi_manager,
            audio_recorder,
            _cpal_stream: Mutex::new(
                stream_holder.map(|s| Box::new(s) as Box<dyn Send + Sync>),
            ),
        }
    }

    fn try_spawn_cpal_stream(
        requested_buffer_frames: u32,
        event_consumer: Consumer<ScheduledAudioEventPod>,
        command_consumer: Consumer<RealTimeCommand>,
        sample_consumer: Consumer<(u8, SharedStereoPcm)>,
        sample_gc_producer: Producer<SharedStereoPcm>,
        midi_event_consumer: Consumer<ScheduledAudioEventPod>,
        midi_cmd_consumer: Consumer<RealTimeCommand>,
        monitor_consumer: Consumer<f32>,
        frame_counter: Arc<AtomicU64>,
        hardware_latency_frames: Arc<AtomicU64>,
    ) -> (u32, String, u32, Option<StreamHolder>) {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            return (
                48_000,
                "Headless / No Output Device".to_string(),
                requested_buffer_frames,
                None,
            );
        };
        let device_name = device
            .name()
            .unwrap_or_else(|_| "Default System Audio".to_string());
        let Ok(supported_config) = device.default_output_config() else {
            return (48_000, device_name, requested_buffer_frames, None);
        };

        let base_config: cpal::StreamConfig = supported_config.into();
        let sample_rate = base_config.sample_rate.0;
        let channels = base_config.channels as usize;
        let clamped_buf = requested_buffer_frames.clamp(256, 4096);

        // Configure explicit Fixed buffer size (512 or 1024 frames) to eliminate PipeWire/ALSA underrun crackle
        let fixed_config = cpal::StreamConfig {
            channels: base_config.channels,
            sample_rate: base_config.sample_rate,
            buffer_size: cpal::BufferSize::Fixed(clamped_buf),
        };

        let mut rt_engine = Box::new(
            RealTimeAudioEngine::new(sample_rate, event_consumer, command_consumer)
                .with_sample_channels(sample_consumer, sample_gc_producer)
                .with_midi(midi_event_consumer, midi_cmd_consumer)
                .with_live_monitor(monitor_consumer),
        );
        let fc_for_cb = frame_counter.clone();
        let hl_for_cb = hardware_latency_frames.clone();

        // Check whether the device supports explicit fixed buffer sizes via supported_output_configs
        let supports_fixed = device
            .supported_output_configs()
            .map(| mut configs | {
                configs.any(|r| {
                    matches!(
                        r.buffer_size(),
                        cpal::SupportedBufferSize::Range { min, max }
                            if *min <= clamped_buf && clamped_buf <= *max
                    )
                })
            })
            .unwrap_or(true);

        let chosen_config = if supports_fixed {
            fixed_config
        } else {
            base_config
        };

        let stream_res = device.build_output_stream(
            &chosen_config,
            move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                rt_engine.process_interleaved_f32(data, channels);
                fc_for_cb.store(rt_engine.current_sample_frame, Ordering::Relaxed);
                let ts = info.timestamp();
                if let Some(dur) = ts.playback.duration_since(&ts.callback) {
                    let lat_frames = (dur.as_secs_f64() * sample_rate as f64).round() as u64;
                    let total = lat_frames.max(clamped_buf as u64);
                    hl_for_cb.store(total, Ordering::Relaxed);
                } else {
                    hl_for_cb.store(clamped_buf as u64, Ordering::Relaxed);
                }
            },
            move |err| {
                eprintln!("[QlStudio Audio Stream Warning]: {err}");
            },
            None,
        );

        match stream_res {
            Ok(stream) => {
                let _ = stream.play();
                (
                    sample_rate,
                    device_name,
                    clamped_buf,
                    Some(StreamHolder(stream)),
                )
            }
            Err(_) => (sample_rate, device_name, clamped_buf, None),
        }
    }
}

#[tauri::command]
pub fn play(state: State<'_, QlEngineController>) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.is_playing = true;
    let _ = guard.command_producer.push(RealTimeCommand::Play);
    state.is_playing_atomic.store(true, Ordering::Release);

    let frame = state.current_frame_estimate.load(Ordering::Relaxed);
    let SharedLookaheadState {
        scheduler,
        pattern,
        channels,
        event_producer,
        ..
    } = &mut *guard;
    scheduler.advance_lookahead(frame, pattern, channels, event_producer);

    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn pause(state: State<'_, QlEngineController>) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.is_playing = false;
    let _ = guard.command_producer.push(RealTimeCommand::Pause);
    state.is_playing_atomic.store(false, Ordering::Release);
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn stop(state: State<'_, QlEngineController>) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.is_playing = false;
    guard.scheduler.next_unscheduled_tick = 0;
    let _ = guard.command_producer.push(RealTimeCommand::Stop);
    state.is_playing_atomic.store(false, Ordering::Release);
    state.current_frame_estimate.store(0, Ordering::Release);
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn set_bpm(
    bpm: f64,
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    if !(10.0..=522.0).contains(&bpm) {
        return Err(format!("BPM out of valid range (10.0..=522.0): {bpm}"));
    }
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.set_bpm(bpm);
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn set_swing(
    swing_ratio: f64,
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    if !(0.50..=0.75).contains(&swing_ratio) {
        return Err(format!(
            "Swing ratio out of valid range (0.50..=0.75): {swing_ratio}"
        ));
    }
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.set_swing(swing_ratio);
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn update_pattern(
    pattern: QlPattern,
    channels: Vec<QlChannel>,
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.pattern = pattern;
    guard.channels = channels;
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn update_mixer_graph(
    mixer: QlMixerState,
    state: State<'_, QlEngineController>,
) -> Result<DagVerificationReport, String> {
    let report = verify_acyclic_routing_graph(&mixer);
    if !report.is_acyclic {
        return Err(format!(
            "Feedback loop detected in Mixer routing graph at inserts: {:?}",
            report.cycle_inserts
        ));
    }

    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    let sample_rate = guard.scheduler.metrics.sample_rate as f64;

    for ins in &mixer.inserts {
        let eq_coeffs = compute_rbj_biquad_coeffs(&ins.eq_band, sample_rate);
        let fader_gain_linear = if ins.fader_volume_db <= -96.0 {
            0.0
        } else {
            10.0_f32.powf(ins.fader_volume_db / 20.0)
        };
        let _ = guard.command_producer.push(RealTimeCommand::SetInsertParams {
            insert_index: ins.index,
            pan: ins.pan,
            stereo_separation: ins.stereo_separation,
            fader_gain_linear,
            muted: ins.muted,
            eq_coeffs,
            eq_enabled: ins.eq_band.enabled,
        });
    }

    let mut topological_order = [0u8; MAX_MIXER_INSERTS];
    let node_count = report.topological_order.len().min(MAX_MIXER_INSERTS);
    topological_order[..node_count].copy_from_slice(&report.topological_order[..node_count]);

    let mut sends = [QlMixerSend {
        source_insert: 0,
        target_insert: 0,
        gain_linear: 0.0,
        pre_fader: false,
        sidechain_only: false,
    }; MAX_MIXER_SENDS];
    let send_count = mixer.sends.len().min(MAX_MIXER_SENDS);
    sends[..send_count].copy_from_slice(&mixer.sends[..send_count]);

    let _ = guard
        .command_producer
        .push(RealTimeCommand::UpdateRoutingSchedule {
            topological_order,
            node_count: node_count as u8,
            sends,
            send_count: send_count as u8,
        });

    Ok(report)
}

#[tauri::command]
pub fn get_engine_status(
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    let guard = state.shared.lock().map_err(|e| e.to_string())?;
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn import_flp_file(
    path: String,
    state: State<'_, QlEngineController>,
) -> Result<QlProjectPayload, String> {
    let payload = parse_flp_file(Path::new(&path))?;

    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.set_bpm(payload.bpm);
    guard.scheduler.set_swing(payload.global_swing_ratio);
    guard.channels = payload.channels.clone();
    if let Some(first_pat) = payload.patterns.first() {
        guard.pattern = first_pat.clone();
    }

    Ok(payload)
}

/// Loads a 16/24/32-bit `.wav` file via `hound`, resamples to the engine's hardware sample rate
/// using 4-point Hermite cubic interpolation, and transfers the buffer lock-free to the voice engine.
#[tauri::command]
pub fn load_sample_file(
    channel_id: serde_json::Value,
    path: String,
    state: State<'_, QlEngineController>,
) -> Result<LoadedSampleSummary, String> {
    let slot_num: usize = match channel_id {
        serde_json::Value::Number(ref n) => n.as_u64().unwrap_or(0) as usize,
        serde_json::Value::String(ref s) => {
            let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
            digits.parse::<usize>().unwrap_or(0)
        }
        _ => 0,
    };
    let slot = (slot_num).min(MAX_SAMPLE_SLOTS - 1) as u8;
    let wav_path = Path::new(&path);

    let target_sr = {
        let guard = state.shared.lock().map_err(|e| e.to_string())?;
        guard.scheduler.metrics.sample_rate
    };

    let (pcm, src_sr) = load_wav_file_resampled(wav_path, target_sr)?;
    let frame_count = pcm.len();
    let duration_ms = ((frame_count as f64) / (target_sr as f64)) * 1000.0;
    let duration_seconds = duration_ms / 1000.0;
    let sample_name = wav_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("Sample {slot}"));

    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.loaded_samples[slot as usize] = Some(pcm.clone());
    let _ = guard.sample_producer.push((slot, pcm));

    if let Some(ch) = guard
        .channels
        .iter_mut()
        .find(|c| c.index as u8 == slot || c.id.ends_with(&format!("_{slot}")))
    {
        ch.name = sample_name.clone();
        ch.sample_slot = Some(slot);
        ch.waveform = crate::schemas::WaveformShape::SamplerPcm;
    }

    Ok(LoadedSampleSummary {
        channel_id: slot as u32,
        sample_name: sample_name.clone(),
        source_path: path,
        frame_count,
        sample_rate: target_sr,
        duration_ms,
        slot_index: slot,
        name: sample_name,
        original_sample_rate: src_sr,
        engine_sample_rate: target_sr,
        channels: 2,
        duration_seconds,
    })
}

/// Offline renders `bars` bars of the current pattern and writes a 16-bit stereo `.wav` file via `hound`.
#[tauri::command]
pub fn export_wav_file(
    path: String,
    bars: u32,
    state: State<'_, QlEngineController>,
) -> Result<String, String> {
    let (bpm, ppq, sample_rate, swing, pattern, channels, loaded_samples) = {
        let guard = state.shared.lock().map_err(|e| e.to_string())?;
        (
            guard.scheduler.metrics.bpm,
            guard.scheduler.metrics.ppq,
            guard.scheduler.metrics.sample_rate,
            guard.scheduler.global_swing_ratio,
            guard.pattern.clone(),
            guard.channels.clone(),
            guard.loaded_samples.clone(),
        )
    };

    let (mut ev_prod, ev_cons) = RingBuffer::<ScheduledAudioEventPod>::new(16384);
    let (mut cmd_prod, cmd_cons) = RingBuffer::<RealTimeCommand>::new(64);
    cmd_prod.push(RealTimeCommand::Play).ok();

    let mut offline_sched = NativeLookaheadScheduler::new(bpm, ppq, sample_rate, swing);
    offline_sched.is_playing = true;
    offline_sched.lookahead_window_sec = 1.0;

    let mut offline_engine = RealTimeAudioEngine::new(sample_rate, ev_cons, cmd_cons);
    offline_engine.sample_bank = loaded_samples;

    let seconds_per_bar = (60.0 / bpm) * 4.0;
    let total_frames = ((seconds_per_bar * (bars.max(1) as f64)) * (sample_rate as f64)).round() as usize;
    let mut rendered_interleaved = vec![0.0f32; total_frames * 2];

    let chunk_frames = 512usize;
    let mut frame_cursor = 0usize;
    while frame_cursor < total_frames {
        let count = (total_frames - frame_cursor).min(chunk_frames);
        offline_sched.advance_lookahead(frame_cursor as u64, &pattern, &channels, &mut ev_prod);
        let slice = &mut rendered_interleaved[frame_cursor * 2..(frame_cursor + count) * 2];
        offline_engine.process_interleaved_f32(slice, 2);
        frame_cursor += count;
    }

    write_stereo_wav_file(Path::new(&path), &rendered_interleaved, sample_rate)?;
    Ok(path)
}

#[tauri::command]
pub fn get_audio_settings(
    state: State<'_, QlEngineController>,
) -> Result<AudioSettingsSnapshot, String> {
    let guard = state.shared.lock().map_err(|e| e.to_string())?;
    Ok(AudioSettingsSnapshot {
        device_name: guard.device_name.clone(),
        sample_rate: guard.scheduler.metrics.sample_rate,
        buffer_size_frames: guard.buffer_size_frames,
        available_buffer_sizes: vec![256, 512, 1024, 2048],
        stream_active: guard.audio_stream_active,
    })
}

#[tauri::command]
pub fn set_audio_buffer_size(
    buffer_size: Option<u32>,
    buffer_size_frames: Option<u32>,
    state: State<'_, QlEngineController>,
) -> Result<AudioSettingsSnapshot, String> {
    let raw = buffer_size.or(buffer_size_frames).unwrap_or(1024);
    let clamped = match raw {
        0..=384 => 256,
        385..=768 => 512,
        769..=1536 => 1024,
        _ => 2048,
    };

    let (event_producer, event_consumer) = RingBuffer::<ScheduledAudioEventPod>::new(8192);
    let (command_producer, command_consumer) = RingBuffer::<RealTimeCommand>::new(1024);
    let (sample_producer, sample_consumer) = RingBuffer::<(u8, SharedStereoPcm)>::new(64);
    let (sample_gc_producer, sample_gc_consumer) = RingBuffer::<SharedStereoPcm>::new(64);

    let (midi_ev_prod, midi_ev_cons) = RingBuffer::<ScheduledAudioEventPod>::new(2048);
    let (midi_cmd_prod, midi_cmd_cons) = RingBuffer::<RealTimeCommand>::new(512);
    let (monitor_prod, monitor_cons) = RingBuffer::<f32>::new(8192);

    // Drop old stream before opening reconfigured hardware stream
    if let Ok(mut stream_slot) = state._cpal_stream.lock() {
        *stream_slot = None;
    }

    let (sample_rate, device_name, actual_buf, stream_holder) =
        QlEngineController::try_spawn_cpal_stream(
            clamped,
            event_consumer,
            command_consumer,
            sample_consumer,
            sample_gc_producer,
            midi_ev_cons,
            midi_cmd_cons,
            monitor_cons,
            state.current_frame_estimate.clone(),
            state.hardware_latency_frames.clone(),
        );

    if let Ok(mm) = state.midi_manager.lock() {
        if let Ok(mut ep) = mm.event_producer.lock() {
            *ep = midi_ev_prod;
        }
        if let Ok(mut cp) = mm.command_producer.lock() {
            *cp = midi_cmd_prod;
        }
    }

    if let Ok(ar) = state.audio_recorder.lock() {
        if let Some(ref mp) = ar.monitor_producer {
            if let Ok(mut prod) = mp.lock() {
                *prod = monitor_prod;
            }
        }
    }

    let has_stream = stream_holder.is_some();
    if let Ok(mut stream_slot) = state._cpal_stream.lock() {
        *stream_slot = stream_holder.map(|s| Box::new(s) as Box<dyn Send + Sync>);
    }

    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.event_producer = event_producer;
    guard.command_producer = command_producer;
    guard.sample_producer = sample_producer;
    guard.sample_gc_consumer = sample_gc_consumer;
    guard.device_name = device_name.clone();
    guard.buffer_size_frames = actual_buf;
    guard.audio_stream_active = has_stream;
    guard.scheduler.metrics = crate::scheduler::compute_timing_metrics(
        guard.scheduler.metrics.bpm,
        guard.scheduler.metrics.ppq,
        sample_rate,
    );

    // Re-push loaded custom samples into the new stream
    {
        let SharedLookaheadState {
            loaded_samples,
            sample_producer,
            ..
        } = &mut *guard;
        for (slot, maybe_pcm) in loaded_samples.iter().enumerate() {
            if let Some(ref pcm) = maybe_pcm {
                let _ = sample_producer.push((slot as u8, pcm.clone()));
            }
        }
    }
    if guard.scheduler.is_playing {
        let _ = guard.command_producer.push(RealTimeCommand::Play);
    }

    Ok(AudioSettingsSnapshot {
        device_name,
        sample_rate,
        buffer_size_frames: actual_buf,
        available_buffer_sizes: vec![256, 512, 1024, 2048],
        stream_active: guard.audio_stream_active,
    })
}

#[tauri::command]
pub fn toggle_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!is_fullscreen).map_err(|e| e.to_string())?;
    Ok(!is_fullscreen)
}

#[tauri::command]
pub fn toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

fn snapshot_from_guard(
    guard: &SharedLookaheadState,
    state: &QlEngineController,
) -> EngineStatusSnapshot {
    let cur_frame = state.current_frame_estimate.load(Ordering::Relaxed);
    let lat_frames = state.hardware_latency_frames.load(Ordering::Relaxed);
    let audible_frame = cur_frame.saturating_sub(lat_frames);
    let samples_per_tick = guard.scheduler.metrics.samples_per_tick;
    let audible_tick = if samples_per_tick > 0.0 {
        (audible_frame as f64 / samples_per_tick).floor() as u64
    } else {
        0
    };
    let sample_rate = guard.scheduler.metrics.sample_rate;
    let estimated_latency_ms = if sample_rate > 0 {
        (lat_frames as f64 / sample_rate as f64) * 1000.0
    } else {
        0.0
    };

    EngineStatusSnapshot {
        is_playing: guard.scheduler.is_playing,
        bpm: guard.scheduler.metrics.bpm,
        ppq: guard.scheduler.metrics.ppq as u16,
        swing_ratio: guard.scheduler.global_swing_ratio,
        sample_rate,
        buffer_size_frames: guard.buffer_size_frames,
        next_unscheduled_tick: guard.scheduler.next_unscheduled_tick,
        audio_stream_active: guard.audio_stream_active,
        play_mode: guard.scheduler.play_mode,
        song_tick: audible_tick,
        audible_frame,
        estimated_latency_ms,
    }
}

#[tauri::command]
pub fn get_playback_clock(
    state: State<'_, QlEngineController>,
) -> Result<PlaybackClockSnapshot, String> {
    let cur_frame = state.current_frame_estimate.load(Ordering::Relaxed);
    let lat_frames = state.hardware_latency_frames.load(Ordering::Relaxed);
    let audible_frame = cur_frame.saturating_sub(lat_frames);
    let is_playing = state.is_playing_atomic.load(Ordering::Relaxed);

    let guard = state.shared.lock().map_err(|e| e.to_string())?;
    let sample_rate = guard.scheduler.metrics.sample_rate;
    let buffer_size_frames = guard.buffer_size_frames;
    let bpm = guard.scheduler.metrics.bpm;
    let ppq = guard.scheduler.metrics.ppq as u16;
    let samples_per_tick = guard.scheduler.metrics.samples_per_tick;

    let audible_tick = if samples_per_tick > 0.0 {
        (audible_frame as f64 / samples_per_tick).floor() as u64
    } else {
        0
    };
    let audible_time_sec = if sample_rate > 0 {
        audible_frame as f64 / sample_rate as f64
    } else {
        0.0
    };
    let estimated_latency_ms = if sample_rate > 0 {
        (lat_frames as f64 / sample_rate as f64) * 1000.0
    } else {
        0.0
    };

    Ok(PlaybackClockSnapshot {
        is_playing,
        sample_rate,
        buffer_size_frames,
        current_frame: cur_frame,
        audible_frame,
        audible_tick,
        audible_time_sec,
        estimated_latency_ms,
        bpm,
        ppq,
    })
}

#[tauri::command]
pub fn seek_tick(
    tick: u64,
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    let samples_per_tick = guard.scheduler.metrics.samples_per_tick;
    let target_frame = (tick as f64 * samples_per_tick).round() as u64;
    guard.scheduler.next_unscheduled_tick = tick;
    let _ = guard.command_producer.push(RealTimeCommand::Seek { target_frame });
    state.current_frame_estimate.store(target_frame, Ordering::Release);
    if guard.scheduler.is_playing {
        let SharedLookaheadState {
            scheduler,
            pattern,
            channels,
            event_producer,
            ..
        } = &mut *guard;
        scheduler.advance_lookahead(target_frame, pattern, channels, event_producer);
    }
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn set_play_mode(
    mode: PlayMode,
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.play_mode = mode;
    guard.scheduler.next_unscheduled_tick = 0;

    // Purge obsolete audio queue and reset hardware frame counter to 0
    // Prevents burst-scheduling thousands of expired events on mode switch
    let _ = guard.command_producer.push(RealTimeCommand::Seek { target_frame: 0 });
    state.current_frame_estimate.store(0, Ordering::Release);

    if guard.scheduler.is_playing {
        let SharedLookaheadState {
            scheduler,
            pattern,
            channels,
            event_producer,
            ..
        } = &mut *guard;
        scheduler.advance_lookahead(0, pattern, channels, event_producer);
    }

    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn update_arrangement(
    playlist: QlPlaylistState,
    patterns: Vec<QlPattern>,
    state: State<'_, QlEngineController>,
) -> Result<EngineStatusSnapshot, String> {
    let mut guard = state.shared.lock().map_err(|e| e.to_string())?;
    guard.scheduler.update_arrangement(playlist, patterns);
    Ok(snapshot_from_guard(&guard, &state))
}

#[tauri::command]
pub fn scan_plugins(
    custom_paths: Vec<String>,
    state: State<'_, QlEngineController>,
) -> Result<Vec<PluginDescriptor>, String> {
    let mut host = state.plugin_host.lock().map_err(|e| e.to_string())?;
    let discovered = host.scan(&custom_paths);
    Ok(discovered)
}

#[tauri::command]
pub fn get_available_plugins(
    state: State<'_, QlEngineController>,
) -> Result<Vec<PluginDescriptor>, String> {
    let host = state.plugin_host.lock().map_err(|e| e.to_string())?;
    Ok(host.known_plugins.clone())
}

#[tauri::command]
pub fn load_plugin(
    plugin_id: String,
    target_kind: String,
    target_index: u8,
    slot_index: Option<u8>,
    state: State<'_, QlEngineController>,
) -> Result<PluginInstanceSummary, String> {
    let summary = {
        let mut host = state.plugin_host.lock().map_err(|e| e.to_string())?;
        host.load_plugin(&plugin_id, &target_kind, target_index, slot_index)?
    };

    if target_kind == "mixer_slot" {
        if let Some(slot) = slot_index {
            let tag = match plugin_id.as_str() {
                "builtin:ql_vintage_tape" => 1,
                "builtin:ql_master_limiter" => 2,
                "builtin:ql_stereo_imager" => 3,
                "builtin:ql_studio_reverb" => 5,
                "builtin:ql_pingpong_delay" => 6,
                "builtin:ql_tube_distortion" => 7,
                "builtin:ql_poly_matrix_synth" | "builtin:ql_acid_303" => 8,
                _ => 4,
            };
            let mut params = [0.0f32; 4];
            for (i, p) in summary.parameters.iter().take(4).enumerate() {
                params[i] = p.value;
            }
            if let Ok(mut guard) = state.shared.lock() {
                let _ = guard.command_producer.push(RealTimeCommand::SetInsertPlugin {
                    insert_index: target_index,
                    slot_index: slot,
                    plugin_tag: tag,
                    params,
                    enabled: true,
                });
            }
        }
    }

    Ok(summary)
}

#[tauri::command]
pub fn set_plugin_parameter(
    instance_id: String,
    param_id: u32,
    value: f32,
    state: State<'_, QlEngineController>,
) -> Result<(), String> {
    let (target_kind, target_index, slot_index) = {
        let mut host = state.plugin_host.lock().map_err(|e| e.to_string())?;
        host.set_parameter(&instance_id, param_id, value)?;
        let inst = host.instances.get(&instance_id).ok_or("Instance missing")?;
        (inst.target_kind.clone(), inst.target_index, inst.slot_index)
    };

    if target_kind == "mixer_slot" {
        if let Some(slot) = slot_index {
            if let Ok(mut guard) = state.shared.lock() {
                let _ = guard.command_producer.push(RealTimeCommand::SetPluginParam {
                    insert_index: target_index,
                    slot_index: slot,
                    param_index: param_id as u8,
                    value,
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn unload_plugin(
    instance_id: String,
    state: State<'_, QlEngineController>,
) -> Result<(), String> {
    let (target_kind, target_index, slot_index) = {
        let mut host = state.plugin_host.lock().map_err(|e| e.to_string())?;
        let inst = host.instances.get(&instance_id).cloned().ok_or("Instance missing")?;
        host.unload_plugin(&instance_id)?;
        (inst.target_kind, inst.target_index, inst.slot_index)
    };

    if target_kind == "mixer_slot" {
        if let Some(slot) = slot_index {
            if let Ok(mut guard) = state.shared.lock() {
                let _ = guard.command_producer.push(RealTimeCommand::SetInsertPlugin {
                    insert_index: target_index,
                    slot_index: slot,
                    plugin_tag: 0,
                    params: [0.0; 4],
                    enabled: false,
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_loaded_plugins(
    state: State<'_, QlEngineController>,
) -> Result<Vec<PluginInstanceSummary>, String> {
    let host = state.plugin_host.lock().map_err(|e| e.to_string())?;
    Ok(host.get_instance_summaries())
}

#[tauri::command]
pub fn get_audio_input_devices() -> Result<Vec<crate::audio_record::AudioInputDeviceInfo>, String> {
    Ok(crate::audio_record::AudioRecorderManager::list_input_devices())
}

#[tauri::command]
pub fn start_recording(
    start_tick: u64,
    track_index: u16,
    controller: State<'_, QlEngineController>,
) -> Result<(), String> {
    let mut recorder = controller
        .audio_recorder
        .lock()
        .map_err(|e| format!("Failed to lock audio recorder: {e}"))?;
    recorder.start_recording(start_tick, track_index);
    Ok(())
}

#[tauri::command]
pub fn stop_recording(
    controller: State<'_, QlEngineController>,
) -> Result<Option<crate::audio_record::RecordedAudioSummary>, String> {
    let mut recorder = controller
        .audio_recorder
        .lock()
        .map_err(|e| format!("Failed to lock audio recorder: {e}"))?;
    let samples_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("samples");
    recorder.stop_recording(&samples_dir)
}

#[tauri::command]
pub fn set_live_monitoring(
    enabled: bool,
    controller: State<'_, QlEngineController>,
) -> Result<(), String> {
    let recorder = controller
        .audio_recorder
        .lock()
        .map_err(|e| format!("Failed to lock audio recorder: {e}"))?;
    recorder.set_live_monitoring(enabled);
    Ok(())
}

#[tauri::command]
pub fn get_midi_input_devices(
    controller: State<'_, QlEngineController>,
) -> Result<Vec<crate::midi::MidiDeviceInfo>, String> {
    let mgr = controller
        .midi_manager
        .lock()
        .map_err(|e| format!("Failed to lock midi manager: {e}"))?;
    Ok(mgr.list_ports())
}

#[tauri::command]
pub fn connect_midi_device(
    port_index: usize,
    profile: crate::midi::MidiControllerProfile,
    controller: State<'_, QlEngineController>,
) -> Result<String, String> {
    let mut mgr = controller
        .midi_manager
        .lock()
        .map_err(|e| format!("Failed to lock midi manager: {e}"))?;
    mgr.connect_port(port_index, profile)
}

#[tauri::command]
pub fn disconnect_midi_device(
    controller: State<'_, QlEngineController>,
) -> Result<(), String> {
    let mut mgr = controller
        .midi_manager
        .lock()
        .map_err(|e| format!("Failed to lock midi manager: {e}"))?;
    mgr.disconnect();
    Ok(())
}

#[tauri::command]
pub fn get_midi_status(
    controller: State<'_, QlEngineController>,
) -> Result<crate::midi::MidiStatusSnapshot, String> {
    let mgr = controller
        .midi_manager
        .lock()
        .map_err(|e| format!("Failed to lock midi manager: {e}"))?;
    Ok(mgr.get_status())
}

#[tauri::command]
pub fn time_stretch_audio_clip(
    clip_id: String,
    file_path: String,
    stretch_ratio: f64,
    pitch_shift_semitones: f64,
    controller: State<'_, QlEngineController>,
) -> Result<TimeStretchResult, String> {
    let sample_rate = {
        let guard = controller.shared.lock().map_err(|e| e.to_string())?;
        guard.scheduler.metrics.sample_rate
    };

    let src = Path::new(&file_path);
    if !src.exists() {
        return Err(format!("Audio clip source file '{}' does not exist", file_path));
    }

    let samples_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("samples");

    let (stretched_path, frame_count, duration_seconds) = crate::sampler::time_stretch_wav_file(
        src,
        &samples_dir,
        stretch_ratio,
        pitch_shift_semitones,
        sample_rate,
    )?;

    Ok(TimeStretchResult {
        clip_id,
        original_path: file_path,
        stretched_path,
        frame_count,
        duration_seconds,
        stretch_ratio,
        pitch_semitones: pitch_shift_semitones,
    })
}

#[tauri::command]
pub fn stretch_channel_sample(
    slot: u8,
    stretch_ratio: f64,
    pitch_shift_semitones: f64,
    controller: State<'_, QlEngineController>,
) -> Result<(), String> {
    let (existing_pcm, sample_rate) = {
        let guard = controller.shared.lock().map_err(|e| e.to_string())?;
        let idx = slot as usize;
        if idx >= MAX_SAMPLE_SLOTS {
            return Err(format!("Sample slot {} out of range", slot));
        }
        let pcm = guard.loaded_samples[idx]
            .clone()
            .ok_or_else(|| format!("No sample loaded in slot {}", slot))?;
        (pcm, guard.scheduler.metrics.sample_rate)
    };

    let processed = crate::sampler::process_pcm_time_stretch_and_pitch(
        &existing_pcm,
        sample_rate,
        stretch_ratio,
        pitch_shift_semitones,
    );

    let mut guard = controller.shared.lock().map_err(|e| e.to_string())?;
    guard.loaded_samples[slot as usize] = Some(processed.clone());
    let _ = guard.sample_producer.push((slot, processed));

    Ok(())
}

#[tauri::command]
pub fn trigger_channel_note(
    channel_id: String,
    midi_note: Option<u8>,
    velocity: Option<u8>,
    state: State<'_, QlEngineController>,
) -> Result<(), String> {
    let guard = state.shared.lock().map_err(|e| e.to_string())?;
    let cur_frame = state.current_frame_estimate.load(Ordering::Relaxed);

    let maybe_ch = guard.channels.iter().find(|c| c.id == channel_id);
    let (ch_index, assigned_insert, sample_slot, root_note, pan, vol_db, waveform) =
        if let Some(ch) = maybe_ch {
            (
                ch.index,
                ch.assigned_mixer_insert,
                ch.sample_slot.unwrap_or(0xFF),
                ch.root_midi_note,
                ch.pan,
                ch.volume_db,
                ch.waveform,
            )
        } else {
            (0, 1, 0, 60, 0.0, 0.0, WaveformShape::Sine)
        };

    let note = midi_note.unwrap_or(root_note);
    let vel = velocity.unwrap_or(100);
    let freq_hz = crate::dsp::midi_note_to_frequency_hz(note, 0.0);
    let vel_norm = (vel as f32) / 127.0;
    let gain_linear = (10.0_f32.powf(vol_db / 20.0) * vel_norm * 0.9).clamp(0.0, 2.0);

    let pod = ScheduledAudioEventPod {
        sample_frame: cur_frame,
        duration_frames: 48000 / 3, // 330ms audition envelope (prevents lingering drone tones)
        channel_index: ch_index,
        assigned_mixer_insert: assigned_insert,
        voice_color_group: 0,
        kind: AudioScheduledEventKind::NoteOn,
        waveform,
        sample_slot,
        root_midi_note: root_note,
        midi_note: note,
        velocity: vel,
        start_freq_hz: freq_hz,
        target_freq_hz: freq_hz,
        pan,
        gain_linear,
    };

    if let Ok(midi_mgr) = state.midi_manager.lock() {
        if let Ok(mut prod) = midi_mgr.event_producer.lock() {
            let _ = prod.push(pod);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_plugin_gui_window(
    instance_id: String,
    app_handle: tauri::AppHandle,
    controller: State<'_, QlEngineController>,
) -> Result<(), String> {
    use tauri::Manager;

    let host = controller.plugin_host.lock().map_err(|e| e.to_string())?;
    let inst = host
        .instances
        .get(&instance_id)
        .ok_or_else(|| format!("Plugin instance '{}' not found", instance_id))?;
    let plugin_title = format!("{} — Ql Studio Plugin Editor", inst.descriptor.name);

    let clean_label = format!("plugin-win-{}", instance_id.replace(':', "-").replace('_', "-"));

    if let Some(existing) = app_handle.get_webview_window(&clean_label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url_str = format!("index.html?pluginWindow={}", urlencoding_simple(&instance_id));
    let _ = tauri::WebviewWindowBuilder::new(
        &app_handle,
        &clean_label,
        tauri::WebviewUrl::App(url_str.into()),
    )
    .title(plugin_title)
    .inner_size(760.0, 540.0)
    .min_inner_size(480.0, 360.0)
    .resizable(true)
    .build();

    Ok(())
}

fn urlencoding_simple(s: &str) -> String {
    s.replace(':', "%3A").replace('_', "%5F")
}
