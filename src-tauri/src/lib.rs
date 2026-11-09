pub mod audio_record;
pub mod commands;
pub mod dsp;
pub mod importers;
pub mod midi;
pub mod plugins;
pub mod sampler;
pub mod scheduler;
pub mod schemas;
pub mod timestretch;

use commands::QlEngineController;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Fix severe stutter/lag and blank screen on Linux (WebKitGTK + NVIDIA / Wayland / DMA-BUF bug)
        // 1. Force GDK to prefer X11 (via XWayland) if available, falling back to Wayland.
        //    This completely avoids KWin Wayland EGL swapchain buffer allocation failures on NVIDIA proprietary drivers.
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11,wayland");
        }
        // 2. Disable DMA-BUF renderer to prevent black screen / buffer negotiation failures on NVIDIA.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(QlEngineController::new())
        .invoke_handler(tauri::generate_handler![
            commands::play,
            commands::pause,
            commands::stop,
            commands::set_bpm,
            commands::set_swing,
            commands::set_play_mode,
            commands::update_pattern,
            commands::update_arrangement,
            commands::update_mixer_graph,
            commands::get_engine_status,
            commands::import_flp_file,
            commands::load_sample_file,
            commands::export_wav_file,
            commands::get_audio_settings,
            commands::set_audio_buffer_size,
            commands::toggle_fullscreen,
            commands::toggle_maximize,
            commands::scan_plugins,
            commands::get_available_plugins,
            commands::load_plugin,
            commands::set_plugin_parameter,
            commands::unload_plugin,
            commands::get_loaded_plugins,
            commands::get_audio_input_devices,
            commands::start_recording,
            commands::stop_recording,
            commands::set_live_monitoring,
            commands::get_midi_input_devices,
            commands::connect_midi_device,
            commands::disconnect_midi_device,
            commands::get_midi_status,
            commands::time_stretch_audio_clip,
            commands::stretch_channel_sample,
            commands::open_plugin_gui_window,
            commands::trigger_channel_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ql Studio Tauri application");
}

#[cfg(test)]
mod tests {
    use super::dsp::{
        compute_rbj_biquad_coeffs, evaluate_slide_frequency_hz, process_stereo_separation_and_pan,
        verify_acyclic_routing_graph,
    };
    use super::sampler::{build_starter_drum_kit, load_wav_file_resampled, write_stereo_wav_file};
    use super::scheduler::{
        compute_swung_step_tick, compute_timing_metrics, NativeLookaheadScheduler,
        RealTimeAudioEngine,
    };
    use super::schemas::*;
    use rtrb::RingBuffer;
    use std::collections::HashMap;

    #[test]
    fn test_ppq_timing_and_swing_math() {
        let metrics = compute_timing_metrics(140.0, PpqResolution::Ppq96, 48_000);
        assert!((metrics.seconds_per_beat - (60.0 / 140.0)).abs() < 1e-12);
        assert_eq!(metrics.ticks_per_sixteenth, 24);

        let tick0 = compute_swung_step_tick(0, PpqResolution::Ppq96, 0.625, 1.0, 0);
        let tick1 = compute_swung_step_tick(1, PpqResolution::Ppq96, 0.625, 1.0, 0);
        assert_eq!(tick0, 0);
        assert_eq!(tick1, 30);
    }

    #[test]
    fn test_logarithmic_slide_note_midpoint() {
        let f0 = 261.625565;
        let f1 = 523.251130;
        let mid = evaluate_slide_frequency_hz(f0, f1, 2400, 4800);
        let expected_geom_mean = (f0 * f1).sqrt();
        assert!((mid - expected_geom_mean).abs() < 1e-6);
    }

    #[test]
    fn test_rbj_biquad_and_kahn_dag_mixer() {
        let band = ParametricEqBand {
            enabled: true,
            mode: BiquadFilterMode::Peaking,
            frequency_hz: 1000.0,
            gain_db: 6.0,
            q_factor: 1.0,
        };
        let coeffs = compute_rbj_biquad_coeffs(&band, 48_000.0);
        assert!((coeffs.b0 - 1.043953086990335).abs() < 1e-9);

        let (mono_l, mono_r) = process_stereo_separation_and_pan(0.8, 0.2, -1.0, 0.0);
        assert!((mono_l - 0.5).abs() < 1e-6);
        assert!((mono_r - 0.5).abs() < 1e-6);

        let cyclic_state = QlMixerState {
            master_insert_index: 0,
            inserts: vec![
                QlMixerInsert {
                    index: 0,
                    name: "Master".into(),
                    input_gain_db: 0.0,
                    fader_volume_db: 0.0,
                    pan: 0.0,
                    stereo_separation: 0.0,
                    muted: false,
                    solo: false,
                    eq_band: band,
                },
                QlMixerInsert {
                    index: 1,
                    name: "Insert 1".into(),
                    input_gain_db: 0.0,
                    fader_volume_db: 0.0,
                    pan: 0.0,
                    stereo_separation: 0.0,
                    muted: false,
                    solo: false,
                    eq_band: band,
                },
                QlMixerInsert {
                    index: 5,
                    name: "Insert 5".into(),
                    input_gain_db: 0.0,
                    fader_volume_db: 0.0,
                    pan: 0.0,
                    stereo_separation: 0.0,
                    muted: false,
                    solo: false,
                    eq_band: band,
                },
            ],
            sends: vec![
                QlMixerSend {
                    source_insert: 1,
                    target_insert: 5,
                    gain_linear: 1.0,
                    pre_fader: false,
                    sidechain_only: false,
                },
                QlMixerSend {
                    source_insert: 5,
                    target_insert: 1,
                    gain_linear: 1.0,
                    pre_fader: false,
                    sidechain_only: false,
                },
            ],
        };
        let report = verify_acyclic_routing_graph(&cyclic_state);
        assert!(!report.is_acyclic);
        assert!(report.cycle_inserts.contains(&1));
        assert!(report.cycle_inserts.contains(&5));
    }

    #[test]
    fn test_zero_allocation_audio_callback_and_hound_wav_sampler() {
        let kit = build_starter_drum_kit(48_000);
        assert!(kit[0].len() > 10_000, "808 kick buffer should be populated");

        let temp_wav = std::env::temp_dir().join("ql_studio_test_808_kick.wav");
        let flat: Vec<f32> = kit[0].iter().flat_map(|f| [f[0], f[1]]).collect();
        write_stereo_wav_file(&temp_wav, &flat, 44_100).expect("write test wav");
        let (resampled, src_sr) =
            load_wav_file_resampled(&temp_wav, 48_000).expect("load & hermite resample wav");
        assert_eq!(src_sr, 44_100);
        assert!(resampled.len() > kit[0].len());
        let _ = std::fs::remove_file(&temp_wav);

        let (mut ev_prod, ev_cons) = RingBuffer::<ScheduledAudioEventPod>::new(256);
        let (mut cmd_prod, cmd_cons) = RingBuffer::<RealTimeCommand>::new(64);

        let mut scheduler =
            NativeLookaheadScheduler::new(140.0, PpqResolution::Ppq96, 48_000, 0.625);
        scheduler.is_playing = true;

        let channel = QlChannel {
            id: "ch_lead".into(),
            index: 0,
            name: "808 Sub Kick".into(),
            color_hex: "#FF6B35".into(),
            waveform: WaveformShape::SamplerPcm,
            sample_slot: Some(0),
            pan: 0.0,
            volume_db: 0.0,
            root_midi_note: 60,
            pitch_semitones: 0,
            pitch_cents: 0,
            swing_multiplier: 1.0,
            muted: false,
            solo: false,
            assigned_mixer_insert: 1,
        };

        let mut channel_data = HashMap::new();
        channel_data.insert(
            "ch_lead".into(),
            QlChannelPatternData {
                channel_id: "ch_lead".into(),
                steps: vec![QlStep {
                    active: true,
                    velocity: 118,
                    fine_pan: 0.0,
                    pitch_offset_semitones: 0,
                    fine_pitch_cents: 0,
                    gate_ratio: 1.0,
                    shift_ticks: 0,
                }],
                notes: vec![],
            },
        );

        let pattern = QlPattern {
            id: "pat_1".into(),
            index: 1,
            name: "Main".into(),
            color_hex: "#00B4D8".into(),
            time_signature: TimeSignature {
                numerator: 4,
                denominator: 4,
            },
            step_count: 16,
            channel_data,
        };

        let scheduled = scheduler.advance_lookahead(0, &pattern, &[channel], &mut ev_prod);
        assert!(scheduled >= 1);

        cmd_prod.push(RealTimeCommand::Play).unwrap();

        let mut rt_engine = RealTimeAudioEngine::new(48_000, ev_cons, cmd_cons);
        let mut buffer = [0.0f32; 512]; // 256 stereo frames
        rt_engine.process_interleaved_f32(&mut buffer, 2);

        let peak = buffer.iter().fold(0.0f32, |acc, &x| acc.max(x.abs()));
        assert!(
            peak > 0.05,
            "Expected non-silent rendered 808 drum output, got peak={peak}"
        );

        let samples_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples");
        crate::sampler::ensure_starter_drum_wav_files(&samples_dir, 48_000);
        let (reloaded_kick, orig_sr) = crate::sampler::load_wav_file_resampled(
            &samples_dir.join("kick_808.wav"),
            48_000,
        )
        .expect("hound should decode kick_808.wav");
        assert!(reloaded_kick.len() > 10_000);
        assert_eq!(orig_sr, 48_000);
    }

    #[test]
    fn test_playlist_song_mode_lookahead_scheduling() {
        let (mut ev_prod, _ev_cons) = RingBuffer::<ScheduledAudioEventPod>::new(1024);
        let mut scheduler =
            NativeLookaheadScheduler::new(140.0, PpqResolution::Ppq96, 48_000, 0.50);
        scheduler.is_playing = true;
        scheduler.set_play_mode(PlayMode::Song);

        let channel = QlChannel {
            id: "ch_kick".into(),
            index: 0,
            name: "Kick".into(),
            color_hex: "#ff8500".into(),
            waveform: WaveformShape::SamplerPcm,
            sample_slot: Some(0),
            pan: 0.0,
            volume_db: 0.0,
            root_midi_note: 60,
            pitch_semitones: 0,
            pitch_cents: 0,
            swing_multiplier: 1.0,
            muted: false,
            solo: false,
            assigned_mixer_insert: 1,
        };

        let mut channel_data = HashMap::new();
        channel_data.insert(
            "ch_kick".into(),
            QlChannelPatternData {
                channel_id: "ch_kick".into(),
                steps: vec![QlStep {
                    active: true,
                    velocity: 120,
                    fine_pan: 0.0,
                    pitch_offset_semitones: 0,
                    fine_pitch_cents: 0,
                    gate_ratio: 1.0,
                    shift_ticks: 0,
                }],
                notes: vec![],
            },
        );

        let pat1 = QlPattern {
            id: "pat_1".into(),
            index: 1,
            name: "Pattern 1".into(),
            color_hex: "#ff8500".into(),
            time_signature: TimeSignature {
                numerator: 4,
                denominator: 4,
            },
            step_count: 16,
            channel_data: channel_data.clone(),
        };

        let pat2 = QlPattern {
            id: "pat_2".into(),
            index: 2,
            name: "Pattern 2".into(),
            color_hex: "#38bdf8".into(),
            time_signature: TimeSignature {
                numerator: 4,
                denominator: 4,
            },
            step_count: 16,
            channel_data,
        };

        let playlist = QlPlaylistState {
            tracks: vec![QlPlaylistTrack {
                index: 0,
                name: "Track 1".into(),
                color_hex: "#3b82f6".into(),
                height_px: 46,
                muted: false,
                solo: false,
            }],
            clips: vec![
                QlPlaylistClip {
                    id: "clip_1".into(),
                    track_index: 0,
                    start_tick: 0,
                    length_ticks: 384,
                    offset_ticks: 0,
                    kind: "pattern".into(),
                    reference_id: "pat_1".into(),
                    name: "Pattern 1".into(),
                    color_hex: "#ff8500".into(),
                    muted: false,
                },
                QlPlaylistClip {
                    id: "clip_2".into(),
                    track_index: 0,
                    start_tick: 384,
                    length_ticks: 384,
                    offset_ticks: 0,
                    kind: "pattern".into(),
                    reference_id: "pat_2".into(),
                    name: "Pattern 2".into(),
                    color_hex: "#38bdf8".into(),
                    muted: false,
                },
            ],
            automation_clips: vec![],
            loop_start_tick: Some(0),
            loop_end_tick: Some(768),
            play_mode: PlayMode::Song,
        };

        scheduler.update_arrangement(playlist, vec![pat1.clone(), pat2]);
        let count = scheduler.advance_lookahead(0, &pat1, &[channel], &mut ev_prod);
        assert!(count >= 1, "Song mode lookahead should schedule clips");
    }

    #[test]
    fn test_vst3_clap_plugin_host_and_dsp_processing() {
        use crate::dsp::InsertPluginSlot;
        use crate::plugins::PluginHostManager;

        let mut host = PluginHostManager::new();
        let plugins = host.scan(&[]);
        assert!(plugins.len() >= 4, "Should discover built-in studio VST3 & CLAP plugins");

        let tape_summary = host
            .load_plugin("builtin:ql_vintage_tape", "mixer_slot", 1, Some(0))
            .expect("Should load tape saturator");
        assert_eq!(tape_summary.descriptor.format, "vst3");

        host.set_parameter(&tape_summary.instance_id, 0, 12.0)
            .expect("Should set drive param");

        // Verify RealTime DSP processing in audio insert slot
        let mut slot = InsertPluginSlot {
            enabled: true,
            plugin_tag: 1, // Tape saturation
            params: [12.0, 0.5, 0.0, 1.0],
        };

        let mut left = 0.5f32;
        let mut right = 0.5f32;
        slot.process_stereo(&mut left, &mut right);
        assert!(left > 0.5, "Tape saturation with +12dB drive should increase/saturate level");
        assert!(left <= 1.0, "Saturation must smoothly soft-clip below 1.0");

        // Limiter DSP test
        let mut limiter_slot = InsertPluginSlot {
            enabled: true,
            plugin_tag: 2, // Limiter
            params: [-6.0, -0.1, 80.0, 2.0],
        };
        let mut high_l = 2.0f32;
        let mut high_r = 2.0f32;
        limiter_slot.process_stereo(&mut high_l, &mut high_r);
        assert!(high_l.abs() <= 1.0, "Limiter ceiling must catch signal exceeding threshold");
    }

    #[test]
    fn test_midi_manager_and_controller_profiles() {
        use super::midi::{MidiControllerProfile, MidiManager};
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;

        let (ev_prod, _ev_cons) = rtrb::RingBuffer::<ScheduledAudioEventPod>::new(256);
        let (cmd_prod, _cmd_cons) = rtrb::RingBuffer::<RealTimeCommand>::new(64);
        let frame_counter = Arc::new(AtomicU64::new(0));

        let mgr = MidiManager::new(ev_prod, cmd_prod, frame_counter);
        let status = mgr.get_status();
        assert_eq!(status.active_profile, MidiControllerProfile::Generic);
        assert!(status.connected_device.is_none());

        // Ports list should return gracefully without panicking even in headless environment
        let ports = mgr.list_ports();
        println!("Available MIDI ports in test: {:?}", ports.len());
    }

    #[test]
    fn test_audio_record_wav_generation() {
        use super::audio_record::AudioRecorderManager;

        let mut mgr = AudioRecorderManager::new(None);
        mgr.sample_rate = 48000;
        mgr.channels = 2;

        mgr.start_recording(96, 2);
        assert!(mgr.is_recording.load(std::sync::atomic::Ordering::Relaxed));

        // Inject simulated vocal sine wave samples
        if let Ok(mut buf) = mgr.recorded_frames.lock() {
            for i in 0..4800 {
                let sample = (i as f32 * 0.05).sin() * 0.5;
                buf.push(sample);
                buf.push(sample);
            }
        }

        let temp_dir = std::env::temp_dir().join("ql_studio_vocal_test");
        let summary = mgr
            .stop_recording(&temp_dir)
            .expect("Should stop recording and create WAV")
            .expect("Summary must exist");

        assert_eq!(summary.start_tick, 96);
        assert_eq!(summary.track_index, 2);
        assert_eq!(summary.sample_rate, 48000);
        assert_eq!(summary.frame_count, 4800);
        assert!(std::path::Path::new(&summary.file_path).exists());

        // Cleanup
        let _ = std::fs::remove_file(&summary.file_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn test_wsola_time_stretch_and_pitch_shift() {
        use super::timestretch::{pitch_shift_and_time_stretch, time_stretch_multichannel};

        // Create 0.2 second 440 Hz test sine wave (stereo, 48000 Hz)
        let sample_rate = 48000;
        let num_frames = (sample_rate as f32 * 0.2) as usize; // 9600 frames
        let mut original = Vec::with_capacity(num_frames * 2);
        for i in 0..num_frames {
            let s = (2.0 * std::f32::consts::PI * 440.0 * (i as f32 / sample_rate as f32)).sin() * 0.5;
            original.push(s);
            original.push(s);
        }

        // 1. Test 1.5x time stretch (should yield ~1.5x frames, pitch invariant)
        let stretched = time_stretch_multichannel(&original, 2, 1.5);
        let expected_frames = (num_frames as f64 * 1.5) as usize;
        let actual_frames = stretched.len() / 2;
        let frame_diff = (actual_frames as isize - expected_frames as isize).abs();
        assert!(
            frame_diff < 50,
            "Stretched frames ({actual_frames}) should match expected ({expected_frames})"
        );

        // 2. Test pitch shift +7 semitones (duration should remain ~1.0x with stretch_ratio=1.0)
        let pitch_shifted = pitch_shift_and_time_stretch(&original, 2, sample_rate, 1.0, 7.0);
        let ps_frames = pitch_shifted.len() / 2;
        let ps_diff = (ps_frames as isize - num_frames as isize).abs();
        assert!(
            ps_diff < 50,
            "Pitch shifted frames ({ps_frames}) should match original ({num_frames})"
        );
    }
}
