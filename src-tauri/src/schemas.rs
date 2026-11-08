//! QL STUDIO — Clean-Room DAW Engine Data Schemas & Real-Time POD Types
//!
//! Combines Serde-serializable IPC models (`QlPattern`, `QlChannel`, `QlMixerState`)
//! with cache-line-aligned `Copy` POD structures (`ScheduledAudioEventPod`, `RealTimeCommand`)
//! transported over `rtrb` lock-free SPSC ring buffers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_MIXER_INSERTS: usize = 65; // Master (0) + Inserts 1..=64
pub const MAX_MIXER_SENDS: usize = 128;
pub const MAX_ACTIVE_VOICES: usize = 64;

#[repr(u16)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PpqResolution {
    #[serde(rename = "96")]
    Ppq96 = 96,
    #[serde(rename = "192")]
    Ppq192 = 192,
    #[serde(rename = "384")]
    Ppq384 = 384,
}

impl PpqResolution {
    #[inline]
    pub const fn as_u32(self) -> u32 {
        self as u16 as u32
    }

    #[inline]
    pub const fn from_u16(val: u16) -> Self {
        match val {
            192 => Self::Ppq192,
            384 => Self::Ppq384,
            _ => Self::Ppq96,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSignature {
    pub numerator: u8,
    pub denominator: u8,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaveformShape {
    Sine = 0,
    Triangle = 1,
    Sawtooth = 2,
    Pulse = 3,
    Noise = 4,
    SamplerPcm = 5,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlChannel {
    pub id: String,
    pub index: u16,
    pub name: String,
    pub color_hex: String,
    pub waveform: WaveformShape,
    #[serde(default)]
    pub sample_slot: Option<u8>,
    pub pan: f32,                 // -1.0 .. +1.0
    pub volume_db: f32,           // -inf .. +6.0 dB
    pub root_midi_note: u8,       // Default 60 (C5)
    pub pitch_semitones: i8,      // -48 .. +48
    pub pitch_cents: i8,          // -100 .. +100
    pub swing_multiplier: f32,    // 0.0 .. 1.0
    pub muted: bool,
    pub solo: bool,
    pub assigned_mixer_insert: u8,// 0 = Master, 1..=64 = Insert
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlStep {
    pub active: bool,
    pub velocity: u8,             // 0..=127
    pub fine_pan: f32,            // -1.0 .. +1.0
    pub pitch_offset_semitones: i8,
    pub fine_pitch_cents: i8,
    pub gate_ratio: f32,          // 0.05 .. 4.0
    pub shift_ticks: u16,         // 0 .. PPQ/4
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlPianoRollNote {
    pub id: String,
    pub start_tick: u32,
    pub duration_ticks: u32,
    pub midi_note: u8,
    pub velocity: u8,
    pub release_velocity: u8,
    pub fine_pan: f32,
    pub fine_pitch_cents: f32,
    pub filter_cutoff_norm: f32,
    pub filter_resonance_norm: f32,
    pub voice_color_group: u8,    // 0..=15
    pub is_slide_note: bool,
    pub is_porta_note: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlChannelPatternData {
    pub channel_id: String,
    pub steps: Vec<QlStep>,
    pub notes: Vec<QlPianoRollNote>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlPattern {
    pub id: String,
    pub index: u16,
    pub name: String,
    pub color_hex: String,
    pub time_signature: TimeSignature,
    pub step_count: u32,
    pub channel_data: HashMap<String, QlChannelPatternData>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BiquadFilterMode {
    Lowpass,
    Highpass,
    BandpassCsg,
    Notch,
    Peaking,
    Lowshelf,
    Highshelf,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParametricEqBand {
    pub enabled: bool,
    pub mode: BiquadFilterMode,
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q_factor: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlMixerSend {
    pub source_insert: u8,
    pub target_insert: u8,
    pub gain_linear: f32,
    pub pre_fader: bool,
    pub sidechain_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlMixerInsert {
    pub index: u8,
    pub name: String,
    pub input_gain_db: f32,
    pub fader_volume_db: f32,
    pub pan: f32,
    pub stereo_separation: f32,
    pub muted: bool,
    pub solo: bool,
    pub eq_band: ParametricEqBand,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlMixerState {
    pub master_insert_index: u8,
    pub inserts: Vec<QlMixerInsert>,
    pub sends: Vec<QlMixerSend>,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioScheduledEventKind {
    NoteOn = 1,
    NoteOff = 2,
    PitchGlide = 3,
}

/// Lock-free SPSC Ring Buffer Event POD (64-byte cache-line aligned).
/// Zero heap references; safe to send across threads in `O(1)` without locks.
#[repr(C, align(64))]
#[derive(Clone, Copy, Debug)]
pub struct ScheduledAudioEventPod {
    pub sample_frame: u64,
    pub duration_frames: u64,
    pub channel_index: u16,
    pub assigned_mixer_insert: u8,
    pub voice_color_group: u8,
    pub kind: AudioScheduledEventKind,
    pub waveform: WaveformShape,
    pub sample_slot: u8,          // 0xFF = none, 0..31 = PCM sample slot
    pub root_midi_note: u8,
    pub midi_note: u8,
    pub velocity: u8,
    pub start_freq_hz: f64,
    pub target_freq_hz: f64,
    pub pan: f32,
    pub gain_linear: f32,
}

/// Real-time control command sent over a dedicated lock-free `rtrb` channel
/// to mutate DSP parameters without locking or allocating on the audio thread.
#[derive(Clone, Copy, Debug)]
pub enum RealTimeCommand {
    Play,
    Pause,
    Stop,
    SetInsertParams {
        insert_index: u8,
        pan: f32,
        stereo_separation: f32,
        fader_gain_linear: f32,
        muted: bool,
        eq_coeffs: crate::dsp::RbjBiquadCoeffs,
        eq_enabled: bool,
    },
    UpdateRoutingSchedule {
        topological_order: [u8; MAX_MIXER_INSERTS],
        node_count: u8,
        sends: [QlMixerSend; MAX_MIXER_SENDS],
        send_count: u8,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatusSnapshot {
    pub is_playing: bool,
    pub bpm: f64,
    pub ppq: u16,
    pub swing_ratio: f64,
    pub sample_rate: u32,
    pub buffer_size_frames: u32,
    pub next_unscheduled_tick: u64,
    pub audio_stream_active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettingsSnapshot {
    pub device_name: String,
    pub sample_rate: u32,
    pub buffer_size_frames: u32,
    pub available_buffer_sizes: Vec<u32>,
    pub stream_active: bool,
}
