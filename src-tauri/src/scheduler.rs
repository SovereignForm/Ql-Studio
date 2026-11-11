//! QL STUDIO — Native Lookahead Scheduler, PolyBLEP Synth & Zero-Allocation `cpal` Audio Callback
//!
//! Bridges the lookahead scheduling thread and the hard real-time `cpal` audio thread
//! via lock-free `rtrb` Single-Producer Single-Consumer (SPSC) ring buffers.

use crate::dsp::{
    evaluate_slide_frequency_hz, midi_note_to_frequency_hz, process_stereo_separation_and_pan,
    PreallocatedMixerGraph,
};
use crate::sampler::{
    build_starter_drum_kit, hermite_interpolate_stereo, SharedStereoPcm, MAX_SAMPLE_SLOTS,
};
use crate::schemas::{
    AudioScheduledEventKind, PlayMode, PpqResolution, QlChannel, QlPattern, QlPlaylistState,
    RealTimeCommand, ScheduledAudioEventPod, WaveformShape, MAX_ACTIVE_VOICES, MAX_MIXER_INSERTS,
};
use rtrb::{Consumer, Producer};
use std::collections::HashMap;
use std::f64::consts::{PI, TAU};

#[derive(Clone, Copy, Debug)]
pub struct TimingMetrics {
    pub bpm: f64,
    pub ppq: PpqResolution,
    pub sample_rate: u32,
    pub seconds_per_beat: f64,
    pub seconds_per_tick: f64,
    pub samples_per_tick: f64,
    pub ticks_per_sixteenth: u32,
}

#[inline]
pub fn compute_timing_metrics(bpm: f64, ppq: PpqResolution, sample_rate: u32) -> TimingMetrics {
    let clamped_bpm = bpm.clamp(10.0, 522.0);
    let ppq_u32 = ppq.as_u32();
    let seconds_per_beat = 60.0 / clamped_bpm;
    let seconds_per_tick = seconds_per_beat / (ppq_u32 as f64);
    let samples_per_tick = seconds_per_tick * (sample_rate as f64);
    let ticks_per_sixteenth = ppq_u32 / 4;

    TimingMetrics {
        bpm: clamped_bpm,
        ppq,
        sample_rate,
        seconds_per_beat,
        seconds_per_tick,
        samples_per_tick,
        ticks_per_sixteenth,
    }
}

/// Computes FL Studio's signature odd-16th-step groove/swing tick offset:
/// - Even 16th steps (0, 2, 4, ...) remain anchored on the grid.
/// - Odd 16th steps (1, 3, 5, ...) shift continuously from 0.50 (straight) to 0.75 (heavy swing).
#[inline]
pub fn compute_swung_step_tick(
    step_index: u32,
    ppq: PpqResolution,
    global_swing_ratio: f64,
    channel_swing_multiplier: f32,
    micro_shift_ticks: u16,
) -> u32 {
    let clamped_swing = global_swing_ratio.clamp(0.50, 0.75);
    let clamped_mult = (channel_swing_multiplier.clamp(0.0, 1.0)) as f64;
    let ticks_per_step = ppq.as_u32() / 4;
    let base_tick = step_index * ticks_per_step;

    if step_index % 2 == 0 {
        return base_tick + (micro_shift_ticks as u32);
    }

    let eighth_note_ticks = (ticks_per_step * 2) as f64;
    let raw_swing_offset = (clamped_swing - 0.50) * eighth_note_ticks;
    let swung_offset = (raw_swing_offset * clamped_mult).round() as u32;
    base_tick + swung_offset + (micro_shift_ticks as u32)
}

#[inline]
fn db_to_linear(db: f32) -> f32 {
    if db <= -96.0 {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

/// PolyBLEP residual for band-limiting Sawtooth and Pulse discontinuities without heap look-up tables.
#[inline(always)]
fn poly_blep(t: f64, dt: f64) -> f64 {
    if dt <= 0.0 {
        return 0.0;
    }
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// Lookahead Scheduler running on the non-RT control/scheduler thread.
/// Resolves pattern steps & Piano Roll notes ahead by `lookahead_window_sec` (65 ms)
/// and commits `ScheduledAudioEventPod` structs into the lock-free `rtrb::Producer`.
pub struct NativeLookaheadScheduler {
    pub metrics: TimingMetrics,
    pub global_swing_ratio: f64,
    pub lookahead_window_sec: f64,
    pub next_unscheduled_tick: u64,
    pub is_playing: bool,
    pub play_mode: PlayMode,
    pub playlist: QlPlaylistState,
    pub patterns_map: HashMap<String, QlPattern>,
}

impl NativeLookaheadScheduler {
    pub fn new(bpm: f64, ppq: PpqResolution, sample_rate: u32, global_swing_ratio: f64) -> Self {
        Self {
            metrics: compute_timing_metrics(bpm, ppq, sample_rate),
            global_swing_ratio: global_swing_ratio.clamp(0.50, 0.75),
            lookahead_window_sec: 0.025, // 25 ms snappy lookahead horizon for ultra low latency
            next_unscheduled_tick: 0,
            is_playing: false,
            play_mode: PlayMode::Pattern,
            playlist: QlPlaylistState::default(),
            patterns_map: HashMap::new(),
        }
    }

    pub fn set_bpm(&mut self, bpm: f64) {
        self.metrics = compute_timing_metrics(bpm, self.metrics.ppq, self.metrics.sample_rate);
    }

    pub fn set_swing(&mut self, swing_ratio: f64) {
        self.global_swing_ratio = swing_ratio.clamp(0.50, 0.75);
    }

    pub fn set_play_mode(&mut self, mode: PlayMode) {
        self.play_mode = mode;
        self.next_unscheduled_tick = 0;
    }

    pub fn update_arrangement(&mut self, playlist: QlPlaylistState, patterns: Vec<QlPattern>) {
        self.playlist = playlist;
        self.patterns_map.clear();
        for p in patterns {
            self.patterns_map.insert(p.id.clone(), p);
        }
    }

    pub fn advance_lookahead(
        &mut self,
        current_sample_frame: u64,
        pattern: &QlPattern,
        channels: &[QlChannel],
        event_producer: &mut Producer<ScheduledAudioEventPod>,
    ) -> usize {
        if !self.is_playing {
            return 0;
        }

        let lookahead_frames =
            (self.lookahead_window_sec * (self.metrics.sample_rate as f64)).round() as u64;
        let horizon_frame = current_sample_frame.saturating_add(lookahead_frames);
        let any_solo = channels.iter().any(|ch| ch.solo);
        let mut scheduled_count = 0usize;

        if self.play_mode == PlayMode::Pattern {
            if pattern.step_count == 0 {
                return 0;
            }
            let pattern_len_ticks =
                (pattern.step_count * self.metrics.ticks_per_sixteenth).max(1) as u64;

            loop {
                let tick_sample_frame =
                    ((self.next_unscheduled_tick as f64) * self.metrics.samples_per_tick).round() as u64;
                if tick_sample_frame > horizon_frame || event_producer.is_full() {
                    break;
                }
                let local_tick = (self.next_unscheduled_tick % pattern_len_ticks) as u32;
                scheduled_count += schedule_channel_tick_events(
                    tick_sample_frame,
                    local_tick,
                    pattern,
                    channels,
                    &self.metrics,
                    self.global_swing_ratio,
                    any_solo,
                    event_producer,
                );
                self.next_unscheduled_tick += 1;
            }
        } else {
            // Song Mode arrangement
            if self.playlist.clips.is_empty() {
                return 0;
            }

            loop {
                let tick_sample_frame =
                    ((self.next_unscheduled_tick as f64) * self.metrics.samples_per_tick).round() as u64;
                if tick_sample_frame > horizon_frame || event_producer.is_full() {
                    break;
                }

                if let Some(loop_end) = self.playlist.loop_end_tick {
                    if self.next_unscheduled_tick >= loop_end {
                        self.next_unscheduled_tick = self.playlist.loop_start_tick.unwrap_or(0);
                    }
                }

                for clip in &self.playlist.clips {
                    if clip.muted {
                        continue;
                    }
                    if self.next_unscheduled_tick >= clip.start_tick
                        && self.next_unscheduled_tick < clip.start_tick + clip.length_ticks
                    {
                        if clip.kind == "pattern" {
                            let pat = self
                                .patterns_map
                                .get(&clip.reference_id)
                                .unwrap_or(pattern);
                            let pat_len =
                                (pat.step_count * self.metrics.ticks_per_sixteenth).max(1) as u64;
                            let local_tick =
                                ((self.next_unscheduled_tick - clip.start_tick + clip.offset_ticks)
                                    % pat_len) as u32;
                            scheduled_count += schedule_channel_tick_events(
                                tick_sample_frame,
                                local_tick,
                                pat,
                                channels,
                                &self.metrics,
                                self.global_swing_ratio,
                                any_solo,
                                event_producer,
                            );
                        } else if clip.kind == "audio" {
                            if self.next_unscheduled_tick == clip.start_tick {
                                if let Some(ch) = channels.iter().find(|c| c.id == clip.reference_id) {
                                    let ch_gain = db_to_linear(ch.volume_db);
                                    let sample_slot = ch.sample_slot.unwrap_or(0);
                                    let pod = ScheduledAudioEventPod {
                                        sample_frame: tick_sample_frame,
                                        duration_frames: (clip.length_ticks as f64 * self.metrics.samples_per_tick).round() as u64,
                                        channel_index: ch.index,
                                        assigned_mixer_insert: ch.assigned_mixer_insert,
                                        voice_color_group: 0,
                                        kind: AudioScheduledEventKind::NoteOn,
                                        waveform: WaveformShape::SamplerPcm,
                                        sample_slot,
                                        root_midi_note: ch.root_midi_note,
                                        midi_note: 60,
                                        velocity: 100,
                                        start_freq_hz: 261.63,
                                        target_freq_hz: 261.63,
                                        pan: ch.pan,
                                        gain_linear: ch_gain,
                                    };
                                    let _ = event_producer.push(pod);
                                    scheduled_count += 1;
                                }
                            }
                        }
                    }
                }
                self.next_unscheduled_tick += 1;
            }
        }

        scheduled_count
    }
}

#[inline]
fn schedule_channel_tick_events(
    tick_sample_frame: u64,
    local_tick: u32,
    pattern: &QlPattern,
    channels: &[QlChannel],
    metrics: &TimingMetrics,
    global_swing_ratio: f64,
    any_solo: bool,
    event_producer: &mut Producer<ScheduledAudioEventPod>,
) -> usize {
    let mut count = 0;
    for channel in channels {
        let audible = if any_solo {
            channel.solo
        } else {
            !channel.muted
        };
        if !audible {
            continue;
        }

        let Some(ch_data) = pattern.channel_data.get(&channel.id) else {
            continue;
        };

        let ch_gain = db_to_linear(channel.volume_db);
        let sample_slot = channel.sample_slot.unwrap_or_else(|| {
            if channel.waveform == WaveformShape::SamplerPcm {
                (channel.index as u8) % 4
            } else {
                0xFF
            }
        });

        // 1. Step Sequencer Events
        for (step_idx, step) in ch_data.steps.iter().enumerate() {
            if !step.active {
                continue;
            }
            let swung_tick = compute_swung_step_tick(
                step_idx as u32,
                metrics.ppq,
                global_swing_ratio,
                channel.swing_multiplier,
                step.shift_ticks,
            );
            if swung_tick == local_tick {
                let dur_ticks = ((metrics.ticks_per_sixteenth as f32) * step.gate_ratio)
                    .round()
                    .max(1.0) as f64;
                let duration_frames =
                    (dur_ticks * metrics.samples_per_tick).round().max(1.0) as u64;

                let midi_note = (channel.root_midi_note as i16
                    + channel.pitch_semitones as i16
                    + step.pitch_offset_semitones as i16)
                    .clamp(0, 127) as u8;
                let total_cents =
                    (channel.pitch_cents as f64) + (step.fine_pitch_cents as f64);
                let freq_hz = midi_note_to_frequency_hz(midi_note, total_cents);
                let vel_norm = (step.velocity.min(127) as f32) / 127.0;

                let pod = ScheduledAudioEventPod {
                    sample_frame: tick_sample_frame,
                    duration_frames,
                    channel_index: channel.index,
                    assigned_mixer_insert: channel.assigned_mixer_insert,
                    voice_color_group: 0,
                    kind: AudioScheduledEventKind::NoteOn,
                    waveform: channel.waveform,
                    sample_slot,
                    root_midi_note: channel.root_midi_note,
                    midi_note,
                    velocity: step.velocity,
                    start_freq_hz: freq_hz,
                    target_freq_hz: freq_hz,
                    pan: (channel.pan + step.fine_pan).clamp(-1.0, 1.0),
                    gain_linear: ch_gain * vel_norm,
                };
                let _ = event_producer.push(pod);
                count += 1;
            }
        }

        // 2. Piano Roll Normal & Slide Notes
        for note in &ch_data.notes {
            if note.start_tick != local_tick {
                continue;
            }

            let duration_frames = ((note.duration_ticks as f64)
                * metrics.samples_per_tick)
                .round()
                .max(1.0) as u64;
            let total_cents = (channel.pitch_cents as f64) + (note.fine_pitch_cents as f64);
            let note_freq_hz = midi_note_to_frequency_hz(note.midi_note, total_cents);
            let vel_norm = (note.velocity.min(127) as f32) / 127.0;

            if note.is_slide_note {
                let carrier_freq = ch_data
                    .notes
                    .iter()
                    .find(|n| {
                        !n.is_slide_note
                            && n.voice_color_group == note.voice_color_group
                            && n.start_tick <= note.start_tick
                            && n.start_tick + n.duration_ticks > note.start_tick
                    })
                    .map(|carrier| {
                        midi_note_to_frequency_hz(
                            carrier.midi_note,
                            (channel.pitch_cents as f64)
                                + (carrier.fine_pitch_cents as f64),
                        )
                    })
                    .unwrap_or(note_freq_hz);

                let pod = ScheduledAudioEventPod {
                    sample_frame: tick_sample_frame,
                    duration_frames,
                    channel_index: channel.index,
                    assigned_mixer_insert: channel.assigned_mixer_insert,
                    voice_color_group: note.voice_color_group,
                    kind: AudioScheduledEventKind::PitchGlide,
                    waveform: channel.waveform,
                    sample_slot,
                    root_midi_note: channel.root_midi_note,
                    midi_note: note.midi_note,
                    velocity: note.velocity,
                    start_freq_hz: carrier_freq,
                    target_freq_hz: note_freq_hz,
                    pan: (channel.pan + note.fine_pan).clamp(-1.0, 1.0),
                    gain_linear: ch_gain * vel_norm,
                };
                let _ = event_producer.push(pod);
                count += 1;
            } else {
                let pod = ScheduledAudioEventPod {
                    sample_frame: tick_sample_frame,
                    duration_frames,
                    channel_index: channel.index,
                    assigned_mixer_insert: channel.assigned_mixer_insert,
                    voice_color_group: note.voice_color_group,
                    kind: AudioScheduledEventKind::NoteOn,
                    waveform: channel.waveform,
                    sample_slot,
                    root_midi_note: channel.root_midi_note,
                    midi_note: note.midi_note,
                    velocity: note.velocity,
                    start_freq_hz: note_freq_hz,
                    target_freq_hz: note_freq_hz,
                    pan: (channel.pan + note.fine_pan).clamp(-1.0, 1.0),
                    gain_linear: ch_gain * vel_norm,
                };
                let _ = event_producer.push(pod);
                count += 1;
            }
        }
    }
    count
}

/// Fixed-size synthesis & PCM sampler voice slot (stack/struct-allocated; zero heap allocations).
#[derive(Clone, Copy)]
pub struct VoiceSlot {
    pub active: bool,
    pub channel_index: u16,
    pub assigned_mixer_insert: u8,
    pub voice_color_group: u8,
    pub waveform: WaveformShape,
    pub sample_slot: u8,
    pub phase: f64,
    pub sample_pos: f64,
    pub root_freq_hz: f64,
    pub current_freq_hz: f64,
    pub slide_start_freq_hz: f64,
    pub slide_target_freq_hz: f64,
    pub slide_elapsed_frames: u64,
    pub slide_duration_frames: u64,
    pub remaining_frames: u64,
    pub total_frames: u64,
    pub pan: f32,
    pub gain_linear: f32,
    pub rng_state: u32,
}

impl Default for VoiceSlot {
    fn default() -> Self {
        Self {
            active: false,
            channel_index: 0,
            assigned_mixer_insert: 1,
            voice_color_group: 0,
            waveform: WaveformShape::Sawtooth,
            sample_slot: 0xFF,
            phase: 0.0,
            sample_pos: 0.0,
            root_freq_hz: 261.625565,
            current_freq_hz: 440.0,
            slide_start_freq_hz: 440.0,
            slide_target_freq_hz: 440.0,
            slide_elapsed_frames: 0,
            slide_duration_frames: 0,
            remaining_frames: 0,
            total_frames: 0,
            pan: 0.0,
            gain_linear: 0.0,
            rng_state: 0x1234_5678,
        }
    }
}

impl VoiceSlot {
    #[inline(always)]
    fn next_sample(
        &mut self,
        inv_sample_rate: f64,
        sample_bank: &[Option<SharedStereoPcm>; MAX_SAMPLE_SLOTS],
    ) -> (f32, f32) {
        if self.slide_duration_frames > 0 && self.slide_elapsed_frames < self.slide_duration_frames
        {
            self.slide_elapsed_frames += 1;
            self.current_freq_hz = evaluate_slide_frequency_hz(
                self.slide_start_freq_hz,
                self.slide_target_freq_hz,
                self.slide_elapsed_frames,
                self.slide_duration_frames,
            );
        }

        // 1. Check if voice uses a loaded PCM Sample Slot
        let slot_idx = self.sample_slot as usize;
        if slot_idx < MAX_SAMPLE_SLOTS {
            if let Some(ref pcm) = sample_bank[slot_idx] {
                if (self.sample_pos as usize) >= pcm.len() {
                    self.active = false;
                    self.remaining_frames = 0;
                    return (0.0, 0.0);
                }
                let (sl, sr) = hermite_interpolate_stereo(pcm, self.sample_pos);
                let pitch_ratio = (self.current_freq_hz / self.root_freq_hz.max(20.0)).clamp(0.125, 8.0);
                self.sample_pos += pitch_ratio;

                // Smooth micro release fade on last 128 frames to prevent truncation click
                let rel_env = if self.remaining_frames < 128 {
                    let norm = (self.remaining_frames as f64) / 128.0;
                    (0.5 * (1.0 - (norm * PI).cos())) as f32
                } else {
                    1.0
                };
                return process_stereo_separation_and_pan(
                    sl * self.gain_linear * rel_env,
                    sr * self.gain_linear * rel_env,
                    0.0,
                    self.pan,
                );
            }
        }

        // 2. Band-Limited PolyBLEP Oscillator Synthesis
        let dt = (self.current_freq_hz * inv_sample_rate).clamp(0.0, 0.49);
        let osc = match self.waveform {
            WaveformShape::Sine | WaveformShape::SamplerPcm => (self.phase * TAU).sin() as f32,
            WaveformShape::Triangle => {
                let t = self.phase as f32;
                1.0 - 4.0 * (t - 0.5).abs()
            }
            WaveformShape::Sawtooth => {
                let naive = 2.0 * self.phase - 1.0;
                (naive - poly_blep(self.phase, dt)) as f32
            }
            WaveformShape::Pulse => {
                let naive = if self.phase < 0.5 { 1.0 } else { -1.0 };
                let blep = poly_blep(self.phase, dt) - poly_blep((self.phase + 0.5).fract(), dt);
                (naive + blep) as f32
            }
            WaveformShape::Noise => {
                let mut x = self.rng_state;
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                self.rng_state = x;
                ((x as f32) / (u32::MAX as f32)) * 2.0 - 1.0
            }
        };

        self.phase = (self.phase + dt).fract();

        // Click-free Raised-Cosine 96-sample Attack & 192-sample Release Envelope
        let elapsed = self.total_frames.saturating_sub(self.remaining_frames);
        let attack_env = if elapsed < 96 {
            let norm = (elapsed as f64) / 96.0;
            (0.5 * (1.0 - (norm * PI).cos())) as f32
        } else {
            1.0
        };
        let release_env = if self.remaining_frames < 192 {
            let norm = (self.remaining_frames as f64) / 192.0;
            (0.5 * (1.0 - (norm * PI).cos())) as f32
        } else {
            1.0
        };

        let sample = osc * self.gain_linear * attack_env * release_env;
        process_stereo_separation_and_pan(sample, sample, 0.0, self.pan)
    }
}

/// Hard Real-Time Audio Engine owned exclusively by the `cpal` audio output callback.
/// Contains zero heap allocations and zero deallocations during `process_interleaved_f32`.
pub struct RealTimeAudioEngine {
    pub sample_rate: u32,
    pub inv_sample_rate: f64,
    pub current_sample_frame: u64,
    pub is_playing: bool,
    pub pending_event: Option<ScheduledAudioEventPod>,
    pub voices: [VoiceSlot; MAX_ACTIVE_VOICES],
    pub sample_bank: [Option<SharedStereoPcm>; MAX_SAMPLE_SLOTS],
    pub mixer_graph: PreallocatedMixerGraph,
    pub event_consumer: Consumer<ScheduledAudioEventPod>,
    pub command_consumer: Consumer<RealTimeCommand>,
    pub sample_consumer: Option<Consumer<(u8, SharedStereoPcm)>>,
    pub sample_gc_producer: Option<Producer<SharedStereoPcm>>,
    pub midi_consumer: Option<Consumer<ScheduledAudioEventPod>>,
    pub midi_command_consumer: Option<Consumer<RealTimeCommand>>,
    pub monitor_consumer: Option<Consumer<f32>>,
}

impl RealTimeAudioEngine {
    pub fn new(
        sample_rate: u32,
        event_consumer: Consumer<ScheduledAudioEventPod>,
        command_consumer: Consumer<RealTimeCommand>,
    ) -> Self {
        let starter_kit = build_starter_drum_kit(sample_rate);
        let mut sample_bank: [Option<SharedStereoPcm>; MAX_SAMPLE_SLOTS] =
            std::array::from_fn(|_| None);
        sample_bank[0] = Some(starter_kit[0].clone());
        sample_bank[1] = Some(starter_kit[1].clone());
        sample_bank[2] = Some(starter_kit[2].clone());
        sample_bank[3] = Some(starter_kit[3].clone());

        let mut mixer_graph = PreallocatedMixerGraph::default();
        mixer_graph.rebuild_fast_send_lookup();

        Self {
            sample_rate,
            inv_sample_rate: 1.0 / (sample_rate.max(1) as f64),
            current_sample_frame: 0,
            is_playing: false,
            pending_event: None,
            voices: [VoiceSlot::default(); MAX_ACTIVE_VOICES],
            sample_bank,
            mixer_graph,
            event_consumer,
            command_consumer,
            sample_consumer: None,
            sample_gc_producer: None,
            midi_consumer: None,
            midi_command_consumer: None,
            monitor_consumer: None,
        }
    }

    pub fn with_sample_channels(
        mut self,
        sample_consumer: Consumer<(u8, SharedStereoPcm)>,
        sample_gc_producer: Producer<SharedStereoPcm>,
    ) -> Self {
        self.sample_consumer = Some(sample_consumer);
        self.sample_gc_producer = Some(sample_gc_producer);
        self
    }

    pub fn with_midi(
        mut self,
        midi_consumer: Consumer<ScheduledAudioEventPod>,
        midi_command_consumer: Consumer<RealTimeCommand>,
    ) -> Self {
        self.midi_consumer = Some(midi_consumer);
        self.midi_command_consumer = Some(midi_command_consumer);
        self
    }

    pub fn with_live_monitor(mut self, monitor_consumer: Consumer<f32>) -> Self {
        self.monitor_consumer = Some(monitor_consumer);
        self
    }

    #[inline(always)]
    fn handle_command(&mut self, cmd: RealTimeCommand) {
        match cmd {
            RealTimeCommand::Play => {
                self.is_playing = true;
            }
            RealTimeCommand::Pause => {
                self.is_playing = false;
            }
            RealTimeCommand::Stop => {
                self.is_playing = false;
                self.current_sample_frame = 0;
                self.pending_event = None;
                while self.event_consumer.pop().is_ok() {}
                for v in &mut self.voices {
                    v.active = false;
                }
            }
            RealTimeCommand::Seek { target_frame } => {
                self.current_sample_frame = target_frame;
                self.pending_event = None;
                while self.event_consumer.pop().is_ok() {}
                for v in &mut self.voices {
                    v.active = false;
                }
            }
            RealTimeCommand::SetInsertParams {
                insert_index,
                pan,
                stereo_separation,
                fader_gain_linear,
                muted,
                eq_coeffs,
                eq_enabled,
            } => {
                let idx = insert_index as usize;
                if idx < MAX_MIXER_INSERTS {
                    let strip = &mut self.mixer_graph.strips[idx];
                    strip.pan = pan;
                    strip.stereo_separation = stereo_separation;
                    strip.fader_gain_linear = fader_gain_linear;
                    strip.muted = muted;
                    strip.eq_coeffs = eq_coeffs;
                    strip.eq_enabled = eq_enabled;
                }
            }
            RealTimeCommand::UpdateRoutingSchedule {
                topological_order,
                node_count,
                sends,
                send_count,
            } => {
                self.mixer_graph.topological_order = topological_order;
                self.mixer_graph.node_count = node_count;
                self.mixer_graph.sends = sends;
                self.mixer_graph.send_count = send_count;
                self.mixer_graph.rebuild_fast_send_lookup();
            }
            RealTimeCommand::SetInsertPlugin {
                insert_index,
                slot_index,
                plugin_tag,
                params,
                enabled,
            } => {
                let ins_idx = insert_index as usize;
                let sl_idx = (slot_index as usize).min(3);
                if ins_idx < MAX_MIXER_INSERTS {
                    let slot = &mut self.mixer_graph.strips[ins_idx].plugin_slots[sl_idx];
                    slot.enabled = enabled;
                    slot.plugin_tag = plugin_tag;
                    slot.params = params;
                }
            }
            RealTimeCommand::SetPluginParam {
                insert_index,
                slot_index,
                param_index,
                value,
            } => {
                let ins_idx = insert_index as usize;
                let sl_idx = (slot_index as usize).min(3);
                let p_idx = (param_index as usize).min(3);
                if ins_idx < MAX_MIXER_INSERTS {
                    self.mixer_graph.strips[ins_idx].plugin_slots[sl_idx].params[p_idx] = value;
                }
            }
        }
    }

    #[inline(always)]
    fn drain_control_and_sample_commands(&mut self) {
        if let Some(ref mut s_cons) = self.sample_consumer {
            while let Ok((slot, new_pcm)) = s_cons.pop() {
                let idx = slot as usize;
                if idx < MAX_SAMPLE_SLOTS {
                    if let Some(old_pcm) = self.sample_bank[idx].replace(new_pcm) {
                        // Return old Arc to non-RT thread so free() never runs on audio thread
                        if let Some(ref mut gc) = self.sample_gc_producer {
                            let _ = gc.push(old_pcm);
                        }
                    }
                }
            }
        }

        while let Ok(cmd) = self.command_consumer.pop() {
            self.handle_command(cmd);
        }

        let mut cmd_batch: [Option<RealTimeCommand>; 16] = std::array::from_fn(|_| None);
        let mut cmd_count = 0;
        if let Some(ref mut midi_cmds) = self.midi_command_consumer {
            while cmd_count < 16 {
                if let Ok(cmd) = midi_cmds.pop() {
                    cmd_batch[cmd_count] = Some(cmd);
                    cmd_count += 1;
                } else {
                    break;
                }
            }
        }
        for i in 0..cmd_count {
            if let Some(cmd) = cmd_batch[i].take() {
                self.handle_command(cmd);
            }
        }
    }

    #[inline(always)]
    fn dispatch_event(&mut self, ev: ScheduledAudioEventPod) {
        match ev.kind {
            AudioScheduledEventKind::NoteOn => {
                // Re-trigger same channel voice for mono-drum cleanliness or pick free slot
                let mut target_slot = None;
                if (ev.sample_slot as usize) < MAX_SAMPLE_SLOTS {
                    for (i, v) in self.voices.iter().enumerate() {
                        if v.active && v.channel_index == ev.channel_index {
                            target_slot = Some(i);
                            break;
                        }
                    }
                }
                let slot_idx = target_slot.unwrap_or_else(|| {
                    let mut best = 0usize;
                    let mut min_rem = u64::MAX;
                    for (i, v) in self.voices.iter().enumerate() {
                        if !v.active {
                            return i;
                        }
                        if v.remaining_frames < min_rem {
                            min_rem = v.remaining_frames;
                            best = i;
                        }
                    }
                    best
                });

                let slot = &mut self.voices[slot_idx];
                let sample_len_frames = if (ev.sample_slot as usize) < MAX_SAMPLE_SLOTS {
                    self.sample_bank[ev.sample_slot as usize]
                        .as_ref()
                        .map(|b| b.len() as u64)
                        .unwrap_or(ev.duration_frames)
                } else {
                    ev.duration_frames
                };

                slot.active = true;
                slot.channel_index = ev.channel_index;
                slot.assigned_mixer_insert = ev.assigned_mixer_insert;
                slot.voice_color_group = ev.voice_color_group;
                slot.waveform = ev.waveform;
                slot.sample_slot = ev.sample_slot;
                slot.phase = 0.0;
                slot.sample_pos = 0.0;
                slot.root_freq_hz = midi_note_to_frequency_hz(ev.root_midi_note, 0.0);
                slot.current_freq_hz = ev.start_freq_hz;
                slot.slide_start_freq_hz = ev.start_freq_hz;
                slot.slide_target_freq_hz = ev.target_freq_hz;
                slot.slide_elapsed_frames = 0;
                slot.slide_duration_frames = 0;
                slot.remaining_frames = sample_len_frames.max(ev.duration_frames);
                slot.total_frames = slot.remaining_frames;
                slot.pan = ev.pan;
                slot.gain_linear = ev.gain_linear;
            }
            AudioScheduledEventKind::PitchGlide => {
                for v in &mut self.voices {
                    if v.active
                        && v.channel_index == ev.channel_index
                        && v.voice_color_group == ev.voice_color_group
                    {
                        v.slide_start_freq_hz = v.current_freq_hz;
                        v.slide_target_freq_hz = ev.target_freq_hz;
                        v.slide_elapsed_frames = 0;
                        v.slide_duration_frames = ev.duration_frames.max(1);
                    }
                }
            }
            AudioScheduledEventKind::NoteOff => {
                for v in &mut self.voices {
                    if v.active && v.channel_index == ev.channel_index {
                        v.remaining_frames = v.remaining_frames.min(192);
                    }
                }
            }
        }
    }

    /// Hard real-time render callback (`cpal` output stream).
    /// Zero heap allocations, zero mutex locks, zero syscalls.
    pub fn process_interleaved_f32(&mut self, output: &mut [f32], channels: usize) {
        self.drain_control_and_sample_commands();

        if channels == 0 {
            output.fill(0.0);
            return;
        }

        // 1. Drain incoming live hardware MIDI events immediately
        let mut ev_batch: [Option<ScheduledAudioEventPod>; 32] = std::array::from_fn(|_| None);
        let mut ev_count = 0;
        if let Some(ref mut midi_evs) = self.midi_consumer {
            while ev_count < 32 {
                if let Ok(ev) = midi_evs.pop() {
                    ev_batch[ev_count] = Some(ev);
                    ev_count += 1;
                } else {
                    break;
                }
            }
        }
        for i in 0..ev_count {
            if let Some(ev) = ev_batch[i].take() {
                self.dispatch_event(ev);
            }
        }

        // Check whether active voices or live monitor samples require processing
        let has_active_voices = self.voices.iter().any(|v| v.active);
        let has_monitor = self.monitor_consumer.as_ref().map_or(false, |m| !m.is_empty());

        if !self.is_playing && !has_active_voices && !has_monitor {
            output.fill(0.0);
            return;
        }

        for frame in output.chunks_exact_mut(channels) {
            // 2. If playing, trigger all lookahead song events scheduled at or before current_sample_frame
            if self.is_playing {
                loop {
                    if let Some(ev) = self.pending_event {
                        if ev.sample_frame <= self.current_sample_frame {
                            self.pending_event = None;
                            self.dispatch_event(ev);
                            continue;
                        } else {
                            break;
                        }
                    }
                    match self.event_consumer.pop() {
                        Ok(ev) => {
                            if ev.sample_frame <= self.current_sample_frame {
                                self.dispatch_event(ev);
                            } else {
                                self.pending_event = Some(ev);
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }

            // 3. Clear mixer buses for this frame
            self.mixer_graph.clear_buses();

            // 4. Live vocal/microphone monitoring input into Insert 1
            if let Some(ref mut mon) = self.monitor_consumer {
                if let Ok(in_sample) = mon.pop() {
                    let mic_insert = 1;
                    self.mixer_graph.buses_lr[mic_insert][0] += in_sample;
                    self.mixer_graph.buses_lr[mic_insert][1] += in_sample;
                    self.mixer_graph.bus_active[mic_insert] = true;
                }
            }

            // 5. Render active voices into their assigned Mixer Insert buses
            for voice in &mut self.voices {
                if !voice.active {
                    continue;
                }
                if voice.remaining_frames == 0 {
                    voice.active = false;
                    continue;
                }
                let (vl, vr) = voice.next_sample(self.inv_sample_rate, &self.sample_bank);
                if !voice.active {
                    continue;
                }
                voice.remaining_frames = voice.remaining_frames.saturating_sub(1);

                let insert_idx = (voice.assigned_mixer_insert as usize).min(MAX_MIXER_INSERTS - 1);
                self.mixer_graph.buses_lr[insert_idx][0] += vl;
                self.mixer_graph.buses_lr[insert_idx][1] += vr;
                self.mixer_graph.bus_active[insert_idx] = true;
            }

            // 6. Evaluate active Mixer inserts in topological order
            let (master_l, master_r) = self.mixer_graph.process_frame();

            frame[0] = master_l;
            if channels > 1 {
                frame[1] = master_r;
                for extra in &mut frame[2..] {
                    *extra = 0.0;
                }
            }

            if self.is_playing {
                self.current_sample_frame += 1;
            }
        }
    }
}
