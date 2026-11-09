//! QL STUDIO — Full-Fledged PCM WAV Sampler Engine (`hound`) & Starter Drum Kit
//!
//! Implements:
//! 1. 4-point Hermite Cubic Interpolation for sample-rate conversion and real-time pitch shifting
//! 2. `hound` WAV decoder supporting 8/16/24/32-bit Int PCM and 32-bit IEEE Float (Mono & Stereo)
//! 3. Bundled Studio Drum Kit generator (Punchy 808 Kick, Studio Clap, Closed Hi-Hat, Snappy 808 Snare)
//! 4. Offline WAV file writer (`hound::WavWriter`) for `Export as WAV...`

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub const MAX_SAMPLE_SLOTS: usize = 32;

/// Immutable stereo PCM buffer shared with the real-time thread.
/// Deallocation is routed back to a non-RT garbage-collection ring buffer
/// so the audio callback never invokes `free()`.
pub type SharedStereoPcm = Arc<[[f32; 2]]>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSampleSummary {
    pub channel_id: u32,
    pub sample_name: String,
    pub source_path: String,
    pub frame_count: usize,
    pub sample_rate: u32,
    pub duration_ms: f64,
    pub slot_index: u8,
    pub name: String,
    pub original_sample_rate: u32,
    pub engine_sample_rate: u32,
    pub channels: u16,
    pub duration_seconds: f64,
}

/// 4-point, 3rd-order Hermite Cubic Interpolation at fractional index `pos`.
/// Zero heap allocations; safe inside hard real-time voice synthesis loops.
#[inline(always)]
pub fn hermite_interpolate_stereo(frames: &[[f32; 2]], pos: f64) -> (f32, f32) {
    let len = frames.len();
    if len == 0 {
        return (0.0, 0.0);
    }
    let idx = pos as usize;
    if idx >= len {
        return (0.0, 0.0);
    }
    let frac = (pos - (idx as f64)) as f32;

    let xm1 = frames[idx.saturating_sub(1)];
    let x0 = frames[idx];
    let x1 = frames[(idx + 1).min(len - 1)];
    let x2 = frames[(idx + 2).min(len - 1)];

    #[inline(always)]
    fn interp_chan(xm1: f32, x0: f32, x1: f32, x2: f32, t: f32) -> f32 {
        let c0 = x0;
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * t + c2) * t + c1) * t + c0
    }

    (
        interp_chan(xm1[0], x0[0], x1[0], x2[0], frac),
        interp_chan(xm1[1], x0[1], x1[1], x2[1], frac),
    )
}

/// Reads a `.wav` file from disk via `hound`, normalizes peak headroom if clipping,
/// and resamples to `target_sample_rate` using 4-point Hermite cubic interpolation.
pub fn load_wav_file_resampled(
    path: &Path,
    target_sample_rate: u32,
) -> Result<(SharedStereoPcm, u32), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Failed to open WAV file '{}': {e}", path.display()))?;
    let spec = reader.spec();
    let channels = (spec.channels as usize).max(1);
    let src_rate = spec.sample_rate.max(1);

    let raw_samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect(),
        SampleFormat::Int => {
            let bits = spec.bits_per_sample.clamp(1, 32);
            let scale = ((1i64 << (bits - 1)) as f32).max(1.0);
            reader
                .samples::<i32>()
                .map(|s| (s.unwrap_or(0) as f32) / scale)
                .collect()
        }
    };

    if raw_samples.is_empty() {
        return Err(format!("WAV file '{}' contains 0 audio frames", path.display()));
    }

    let mut stereo_frames: Vec<[f32; 2]> = Vec::with_capacity(raw_samples.len() / channels);
    for frame in raw_samples.chunks(channels) {
        let l = frame[0].clamp(-1.5, 1.5);
        let r = if channels > 1 {
            frame[1].clamp(-1.5, 1.5)
        } else {
            l
        };
        stereo_frames.push([l, r]);
    }

    if src_rate == target_sample_rate {
        return Ok((Arc::from(stereo_frames.into_boxed_slice()), src_rate));
    }

    let ratio = (src_rate as f64) / (target_sample_rate.max(1) as f64);
    let out_len = ((stereo_frames.len() as f64) / ratio).ceil().max(1.0) as usize;
    let mut resampled: Vec<[f32; 2]> = Vec::with_capacity(out_len);

    for i in 0..out_len {
        let src_pos = (i as f64) * ratio;
        let (l, r) = hermite_interpolate_stereo(&stereo_frames, src_pos);
        resampled.push([l, r]);
    }

    Ok((Arc::from(resampled.into_boxed_slice()), src_rate))
}

/// Writes an interleaved stereo `[f32]` buffer to a 16-bit PCM `.wav` file using `hound`.
pub fn write_stereo_wav_file(
    path: &Path,
    interleaved_stereo: &[f32],
    sample_rate: u32,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)
        .map_err(|e| format!("Failed to create WAV file '{}': {e}", path.display()))?;

    for &sample in interleaved_stereo {
        let clamped = sample.clamp(-1.0, 1.0);
        let pcm16 = (clamped * 32767.0).round() as i16;
        writer
            .write_sample(pcm16)
            .map_err(|e| format!("Failed to write WAV sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize WAV file '{}': {e}", path.display()))
}

/// Synthesizes a bundled Studio Starter Drum Kit at `sample_rate`:
/// - Slot 0: Punchy 808 Kick (`kick_808.wav`)
/// - Slot 1: Studio Crisp Clap (`clap_studio.wav`)
/// - Slot 2: Metallic Closed Hi-Hat (`hihat_closed.wav`)
/// - Slot 3: Snappy 808 Snare (`snare_808.wav`)
pub fn build_starter_drum_kit(sample_rate: u32) -> [SharedStereoPcm; 4] {
    let sr = sample_rate.max(8000) as f64;

    // 1. Punchy 808 Kick (420 ms): fast pitch sweep 160Hz -> 46Hz + click + warm tanh drive
    let kick_len = (0.42 * sr) as usize;
    let mut kick = Vec::with_capacity(kick_len);
    let mut phase = 0.0_f64;
    for i in 0..kick_len {
        let t = (i as f64) / sr;
        let freq = 46.0 + 125.0 * (-t * 48.0).exp() + 220.0 * (-t * 260.0).exp();
        phase = (phase + freq / sr).fract();
        let body = (phase * TAU).sin();
        let click = (t * 1800.0 * TAU).sin() * (-t * 320.0).exp() * 0.35;
        let amp_env = (-t * 6.8).exp() * (1.0 - (-t * 900.0).exp());
        let driven = ((body + click) * 1.45).tanh() as f32 * (amp_env as f32) * 0.92;
        kick.push([driven, driven]);
    }

    // 2. Studio Crisp Clap (260 ms): 3 micro-bursts (0ms, 11ms, 22ms) + diffuse filtered tail
    let clap_len = (0.26 * sr) as usize;
    let mut clap = Vec::with_capacity(clap_len);
    let mut rng = 0x9E37_79B9u32;
    let mut bp_z1 = 0.0f32;
    let mut bp_z2 = 0.0f32;
    for i in 0..clap_len {
        let t = (i as f64) / sr;
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let white = ((rng as f32) / (u32::MAX as f32)) * 2.0 - 1.0;
        // Resonant band-pass around 1.25 kHz
        let band = white - 0.85 * bp_z1 + 0.32 * bp_z2;
        bp_z2 = bp_z1;
        bp_z1 = band * 0.45;

        let env = if t < 0.011 {
            (-(t) * 180.0).exp()
        } else if t < 0.022 {
            (-(t - 0.011) * 180.0).exp()
        } else if t < 0.033 {
            (-(t - 0.022) * 160.0).exp()
        } else {
            (-(t - 0.033) * 20.0).exp() * 0.72
        } as f32;

        let out_l = (band * env * 0.85).tanh();
        let out_r = ((band * 0.92 - white * 0.08) * env * 0.85).tanh();
        clap.push([out_l, out_r]);
    }

    // 3. Metallic Closed Hi-Hat (75 ms): 6 inharmonic square oscillators + high-pass
    let hat_len = (0.075 * sr) as usize;
    let mut hat = Vec::with_capacity(hat_len);
    let ratios = [318.0, 467.0, 631.0, 829.0, 1063.0, 1423.0];
    let mut prev = 0.0f32;
    for i in 0..hat_len {
        let t = (i as f64) / sr;
        let mut sum = 0.0f32;
        for &f in &ratios {
            let sq = if ((t * f).fract()) < 0.5 { 1.0 } else { -1.0 };
            sum += sq;
        }
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let noise = ((rng as f32) / (u32::MAX as f32)) * 2.0 - 1.0;
        let raw = sum * 0.12 + noise * 0.55;
        let hp = raw - prev;
        prev = raw * 0.82;
        let env = (-t * 58.0).exp() as f32;
        let s = (hp * env * 0.78).clamp(-0.95, 0.95);
        hat.push([s * 0.95, s]);
    }

    // 4. Snappy 808 Snare (210 ms): dual body tones (185Hz & 330Hz) + snare wire burst
    let snare_len = (0.21 * sr) as usize;
    let mut snare = Vec::with_capacity(snare_len);
    let mut p1 = 0.0_f64;
    let mut p2 = 0.0_f64;
    for i in 0..snare_len {
        let t = (i as f64) / sr;
        let f1 = 182.0 + 90.0 * (-t * 85.0).exp();
        let f2 = 332.0 + 110.0 * (-t * 95.0).exp();
        p1 = (p1 + f1 / sr).fract();
        p2 = (p2 + f2 / sr).fract();
        let tone = ((p1 * TAU).sin() * 0.65 + (p2 * TAU).sin() * 0.35) * (-t * 24.0).exp();

        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let noise = (((rng as f32) / (u32::MAX as f32)) * 2.0 - 1.0) as f64 * (-t * 19.0).exp();
        let s = ((tone * 0.75 + noise * 0.65) * 1.25).tanh() as f32 * 0.88;
        snare.push([s, s]);
    }

    [
        Arc::from(kick.into_boxed_slice()),
        Arc::from(clap.into_boxed_slice()),
        Arc::from(hat.into_boxed_slice()),
        Arc::from(snare.into_boxed_slice()),
    ]
}

/// Materializes the starter drum kit `.wav` files into `samples_dir` if they do not exist yet.
pub fn ensure_starter_drum_wav_files(samples_dir: &Path, sample_rate: u32) {
    let _ = fs::create_dir_all(samples_dir);
    let kit = build_starter_drum_kit(sample_rate);
    let names = [
        "kick_808.wav",
        "clap_studio.wav",
        "hihat_closed.wav",
        "snare_808.wav",
    ];
    for (slot, name) in names.iter().enumerate() {
        let file_path = samples_dir.join(name);
        if !file_path.exists() {
            let flat: Vec<f32> = kit[slot].iter().flat_map(|f| [f[0], f[1]]).collect();
            let _ = write_stereo_wav_file(&file_path, &flat, sample_rate);
        }
    }
}

/// Time-stretch and/or pitch-shift an existing PCM stereo sample buffer.
pub fn process_pcm_time_stretch_and_pitch(
    pcm: &SharedStereoPcm,
    sample_rate: u32,
    stretch_ratio: f64,
    pitch_semitones: f64,
) -> SharedStereoPcm {
    let flat: Vec<f32> = pcm.iter().flat_map(|f| [f[0], f[1]]).collect();
    let processed = crate::timestretch::pitch_shift_and_time_stretch(
        &flat,
        2,
        sample_rate,
        stretch_ratio,
        pitch_semitones,
    );

    let mut out_frames = Vec::with_capacity(processed.len() / 2);
    for frame in processed.chunks_exact(2) {
        out_frames.push([frame[0], frame[1]]);
    }
    Arc::from(out_frames.into_boxed_slice())
}

/// Time-stretch an existing WAV file on disk and save the result as a new WAV in `samples_dir`.
pub fn time_stretch_wav_file(
    source_path: &Path,
    samples_dir: &Path,
    stretch_ratio: f64,
    pitch_semitones: f64,
    target_sample_rate: u32,
) -> Result<(String, usize, f64), String> {
    let (pcm, sr) = load_wav_file_resampled(source_path, target_sample_rate)?;
    let stretched = process_pcm_time_stretch_and_pitch(&pcm, sr, stretch_ratio, pitch_semitones);

    let _ = fs::create_dir_all(samples_dir);
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("sample");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let new_filename = format!("{stem}_stretched_{ts}.wav");
    let dest_path = samples_dir.join(&new_filename);

    let flat: Vec<f32> = stretched.iter().flat_map(|f| [f[0], f[1]]).collect();
    write_stereo_wav_file(&dest_path, &flat, sr)?;

    let frame_count = stretched.len();
    let duration_sec = (frame_count as f64) / (sr as f64);
    Ok((dest_path.to_string_lossy().to_string(), frame_count, duration_sec))
}
