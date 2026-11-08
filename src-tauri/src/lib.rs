pub mod commands;
pub mod dsp;
pub mod importers;
pub mod sampler;
pub mod scheduler;
pub mod schemas;

use commands::QlEngineController;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(QlEngineController::new())
        .invoke_handler(tauri::generate_handler![
            commands::play,
            commands::pause,
            commands::stop,
            commands::set_bpm,
            commands::set_swing,
            commands::update_pattern,
            commands::update_mixer_graph,
            commands::get_engine_status,
            commands::import_flp_file,
            commands::load_sample_file,
            commands::export_wav_file,
            commands::get_audio_settings,
            commands::set_audio_buffer_size,
            commands::toggle_fullscreen,
            commands::toggle_maximize,
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
}
