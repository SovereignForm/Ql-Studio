//! QL STUDIO — Clean-Room DAW Engine Data Schemas (Rust Mirror)
//! Zero-allocation-friendly representations for the real-time DSP worker.

#![allow(dead_code)]

#[repr(u16)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PpqResolution {
    Ppq96 = 96,
    Ppq192 = 192,
    Ppq384 = 384,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimeSignature {
    pub numerator: u8,
    pub denominator: u8,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaveformShape {
    Sine = 0,
    Triangle = 1,
    Sawtooth = 2,
    Pulse = 3,
    Noise = 4,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct QlStepPod {
    pub active: bool,
    pub velocity: u8,            // 0..=127
    pub fine_pan: f32,           // -1.0..=1.0
    pub pitch_offset_semis: i8,  // -24..=24
    pub fine_pitch_cents: i8,    // -100..=100
    pub gate_ratio: f32,         // 0.05..=4.0
    pub shift_ticks: u16,        // 0..PPQ/4
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct QlPianoRollNotePod {
    pub id: u64,
    pub start_tick: u32,
    pub duration_ticks: u32,
    pub midi_note: u8,
    pub velocity: u8,
    pub release_velocity: u8,
    pub voice_color_group: u8,   // 0..=15
    pub fine_pan: f32,
    pub fine_pitch_cents: f32,
    pub filter_cutoff_norm: f32,
    pub filter_resonance_norm: f32,
    pub is_slide_note: bool,
    pub is_porta_note: bool,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioScheduledEventKind {
    NoteOn = 1,
    NoteOff = 2,
    PitchGlide = 3,
    ParamAutomation = 4,
}

/// Lock-free SPSC Ring Buffer Event Pod (64-byte cache-line aligned)
#[repr(C, align(64))]
#[derive(Clone, Copy, Debug)]
pub struct ScheduledAudioEventPod {
    pub sample_frame: u64,
    pub duration_frames: u64,
    pub channel_index: u16,
    pub voice_color_group: u8,
    pub kind: AudioScheduledEventKind,
    pub midi_note: u8,
    pub velocity: u8,
    pub _pad: [u8; 2],
    pub start_freq_hz: f64,
    pub target_freq_hz: f64,
    pub pan: f32,
    pub gain_linear: f32,
}
