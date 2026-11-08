//! QL STUDIO — Native Clean-Room FL Studio (`.flp`) Binary Importer
//!
//! Dissects `FLhd` (header) and `FLdt` (TLV event stream) chunks and translates
//! raw binary events into `QlProjectPayload` (`QlChannel`, `QlPattern`, `QlStep`, `QlPianoRollNote`).

use crate::schemas::{
    PpqResolution, QlChannel, QlChannelPatternData, QlPattern, QlPianoRollNote, QlStep,
    TimeSignature, WaveformShape,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

// Standard Open-Spec FLP Event IDs
pub const FLP_BYTE_ENABLED: u8 = 0;
pub const FLP_BYTE_NOTE_ON: u8 = 1;
pub const FLP_BYTE_VOL: u8 = 2;
pub const FLP_BYTE_PAN: u8 = 3;
pub const FLP_BYTE_LOOP_TYPE: u8 = 9;
pub const FLP_BYTE_SWING_MIX: u8 = 16;
pub const FLP_BYTE_MIXER_INSERT: u8 = 19;

pub const FLP_WORD_NEW_CHAN: u8 = 64;
pub const FLP_WORD_NEW_PAT: u8 = 65;
pub const FLP_WORD_TEMPO_COARSE: u8 = 66;
pub const FLP_WORD_CURRENT_PAT: u8 = 67;
pub const FLP_WORD_MAIN_PITCH: u8 = 69;

pub const FLP_DWORD_COLOR: u8 = 128;
pub const FLP_DWORD_GENERATOR_KIND: u8 = 145;
pub const FLP_DWORD_FINE_TEMPO: u8 = 156; // Millibeats per minute (e.g., 140_000 = 140.000 BPM)
pub const FLP_DWORD_TARGET_MIXER: u8 = 160;

pub const FLP_TEXT_CHAN_NAME: u8 = 192;
pub const FLP_TEXT_PAT_NAME: u8 = 193;
pub const FLP_TEXT_TITLE: u8 = 194;
pub const FLP_TEXT_COMMENT: u8 = 195;
pub const FLP_TEXT_SAMPLE_PATH: u8 = 196;
pub const FLP_TEXT_VERSION: u8 = 199;
pub const FLP_TEXT_GEN_NAME: u8 = 201;
pub const FLP_TEXT_AUTHOR: u8 = 207;
pub const FLP_DATA_PAT_NOTES: u8 = 224; // 24-byte note structs

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlImportedChannelMeta {
    pub channel_id: String,
    pub sample_path: Option<String>,
    pub generator_name: Option<String>,
    pub loop_enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlProjectPayload {
    pub source_path: String,
    pub title: String,
    pub author: String,
    pub flp_version: String,
    pub format_type: u16,
    pub bpm: f64,
    pub ppq: u16,
    pub global_swing_ratio: f64,
    pub active_pattern_id: String,
    pub channels: Vec<QlChannel>,
    pub channel_meta: HashMap<String, QlImportedChannelMeta>,
    pub patterns: Vec<QlPattern>,
    pub raw_event_count: usize,
}

#[inline]
fn decode_unsigned_leb128(bytes: &[u8], start: usize) -> Result<(usize, usize), String> {
    let mut result: usize = 0;
    let mut shift: u32 = 0;
    let mut cursor = start;

    while cursor < bytes.len() {
        let b = bytes[cursor];
        cursor += 1;
        result |= ((b & 0x7F) as usize) << shift;
        if (b & 0x80) == 0 {
            return Ok((result, cursor));
        }
        shift += 7;
        if shift > 35 {
            return Err(format!("Malformed LEB128 length at byte offset {start}"));
        }
    }
    Err(format!(
        "Unexpected EOF while decoding LEB128 length at byte offset {start}"
    ))
}

/// Decodes a text payload that may be UTF-8/ASCII (classic/clean-room FLP) or UTF-16LE (FL 12+).
fn decode_flp_string(payload: &[u8]) -> String {
    if payload.is_empty() {
        return String::new();
    }
    // Heuristic for UTF-16LE: even length >= 4 where every odd index is 0x00 for ASCII characters
    if payload.len() >= 4 && payload.len() % 2 == 0 && payload[1] == 0 && payload[3] == 0 {
        let u16_words: Vec<u16> = payload
            .chunks_exact(2)
            .map(| pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|&w| w != 0)
            .collect();
        if let Ok(s) = String::from_utf16(&u16_words) {
            return s.trim().to_string();
        }
    }

    let trimmed = match payload.iter().position(|&b| b == 0) {
        Some(zero_pos) => &payload[..zero_pos],
        None => payload,
    };
    String::from_utf8_lossy(trimmed).trim().to_string()
}

fn bgr_dword_to_hex(color_dword: u32) -> String {
    let r = (color_dword & 0xFF) as u8;
    let g = ((color_dword >> 8) & 0xFF) as u8;
    let b = ((color_dword >> 16) & 0xFF) as u8;
    if r == 0 && g == 0 && b == 0 {
        "#5C6BC0".to_string()
    } else {
        format!("#{r:02X}{g:02X}{b:02X}")
    }
}

fn default_16_steps() -> Vec<QlStep> {
    vec![
        QlStep {
            active: false,
            velocity: 100,
            fine_pan: 0.0,
            pitch_offset_semitones: 0,
            fine_pitch_cents: 0,
            gate_ratio: 0.80,
            shift_ticks: 0,
        };
        16
    ]
}

/// Parses an `.flp` file from disk into a `QlProjectPayload`.
pub fn parse_flp_file(path: &Path) -> Result<QlProjectPayload, String> {
    let bytes = fs::read(path)
        .map_err(|e| format!("Failed to read FLP file '{}': {e}", path.display()))?;
    parse_flp_bytes(&bytes, &path.display().to_string())
}

/// Parses a raw `.flp` byte slice into a complete `QlProjectPayload`.
pub fn parse_flp_bytes(bytes: &[u8], source_path: &str) -> Result<QlProjectPayload, String> {
    if bytes.len() < 22 {
        return Err(format!(
            "Invalid FLP binary: length {} is shorter than 22-byte FLhd+FLdt header",
            bytes.len()
        ));
    }

    if &bytes[0..4] != b"FLhd" {
        return Err("Invalid FLP magic: expected 'FLhd' at byte offset 0".to_string());
    }

    let flhd_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    if flhd_size != 6 {
        return Err(format!("Unsupported FLhd chunk size: expected 6, got {flhd_size}"));
    }

    let format_type = u16::from_le_bytes([bytes[8], bytes[9]]);
    let declared_channel_count = u16::from_le_bytes([bytes[10], bytes[11]]);
    let raw_ppq = u16::from_le_bytes([bytes[12], bytes[13]]);
    let ppq = PpqResolution::from_u16(raw_ppq);
    let ticks_per_step = (ppq.as_u32() / 4).max(1);

    if &bytes[14..18] != b"FLdt" {
        return Err("Invalid FLP data chunk magic: expected 'FLdt' at byte offset 14".to_string());
    }

    let fldt_size = u32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]) as usize;
    let stream_end = bytes.len().min(22usize.saturating_add(fldt_size));

    let mut title = String::from("Untitled FLP Project");
    let mut author = String::from("Unknown Artist");
    let mut flp_version = String::from("FL Studio Compatible");
    let mut bpm: f64 = 140.0;
    let global_swing_ratio: f64 = 0.50;

    let mut channels: Vec<QlChannel> = Vec::new();
    let mut channel_meta: HashMap<String, QlImportedChannelMeta> = HashMap::new();
    let mut patterns: Vec<QlPattern> = Vec::new();

    let mut current_chan_idx: Option<usize> = None;
    let mut current_pat_idx: Option<usize> = None;
    let mut raw_event_count = 0usize;

    let palette = [
        "#FF6B35", "#00B4D8", "#9B5DE5", "#06D6A0", "#F15BB5", "#FEE440", "#3A86FF", "#FB5607",
    ];

    let mut cursor = 22usize;
    while cursor < stream_end {
        let event_id = bytes[cursor];
        cursor += 1;
        raw_event_count += 1;

        if event_id < 64 {
            // BYTE EVENT (1 byte)
            if cursor >= stream_end {
                break;
            }
            let val = bytes[cursor];
            cursor += 1;

            if let Some(ch_i) = current_chan_idx {
                if let Some(ch) = channels.get_mut(ch_i) {
                    match event_id {
                        FLP_BYTE_ENABLED => ch.muted = val == 0,
                        FLP_BYTE_VOL => {
                            // 0..128 where 100 = 0.0 dB unity
                            let norm = (val as f32) / 100.0;
                            ch.volume_db = if norm <= 0.001 {
                                -96.0
                            } else {
                                (20.0 * norm.log10()).clamp(-60.0, 6.0)
                            };
                        }
                        FLP_BYTE_PAN => {
                            // 0..128 where 64 = center
                            ch.pan = (((val as f32) - 64.0) / 64.0).clamp(-1.0, 1.0);
                        }
                        FLP_BYTE_SWING_MIX => {
                            ch.swing_multiplier = ((val as f32) / 128.0).clamp(0.0, 1.0);
                        }
                        FLP_BYTE_MIXER_INSERT => {
                            ch.assigned_mixer_insert = val.min(64);
                        }
                        FLP_BYTE_LOOP_TYPE => {
                            if let Some(meta) = channel_meta.get_mut(&ch.id) {
                                meta.loop_enabled = val != 0;
                            }
                        }
                        _ => {}
                    }
                }
            }
        } else if event_id < 128 {
            // WORD EVENT (2 bytes LE)
            if cursor + 2 > stream_end {
                break;
            }
            let val = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]);
            cursor += 2;

            match event_id {
                FLP_WORD_NEW_CHAN => {
                    let idx = channels.len() as u16;
                    let id = format!("ch_{idx}");
                    let color = palette[(idx as usize) % palette.len()].to_string();
                    let default_waveform = match idx % 4 {
                        0 => WaveformShape::Sine,
                        1 => WaveformShape::Sawtooth,
                        2 => WaveformShape::Pulse,
                        _ => WaveformShape::Triangle,
                    };
                    channels.push(QlChannel {
                        id: id.clone(),
                        index: idx,
                        name: format!("Channel {}", idx + 1),
                        color_hex: color,
                        waveform: default_waveform,
                        sample_slot: if idx < 4 { Some(idx as u8) } else { None },
                        pan: 0.0,
                        volume_db: 0.0,
                        root_midi_note: 60,
                        pitch_semitones: 0,
                        pitch_cents: 0,
                        swing_multiplier: 1.0,
                        muted: false,
                        solo: false,
                        assigned_mixer_insert: ((idx as u8) % 64) + 1,
                    });
                    channel_meta.insert(
                        id.clone(),
                        QlImportedChannelMeta {
                            channel_id: id,
                            sample_path: None,
                            generator_name: None,
                            loop_enabled: false,
                        },
                    );
                    current_chan_idx = Some(channels.len() - 1);
                }
                FLP_WORD_NEW_PAT | FLP_WORD_CURRENT_PAT => {
                    let pat_num = val.max(1);
                    if let Some(existing_pos) = patterns.iter().position(|p| p.index == pat_num) {
                        current_pat_idx = Some(existing_pos);
                    } else {
                        let pat_id = format!("pat_{pat_num}");
                        patterns.push(QlPattern {
                            id: pat_id,
                            index: pat_num,
                            name: format!("Pattern {pat_num}"),
                            color_hex: "#00B4D8".to_string(),
                            time_signature: TimeSignature {
                                numerator: 4,
                                denominator: 4,
                            },
                            step_count: 16,
                            channel_data: HashMap::new(),
                        });
                        current_pat_idx = Some(patterns.len() - 1);
                    }
                }
                FLP_WORD_TEMPO_COARSE => {
                    if (10..=522).contains(&val) {
                        bpm = val as f64;
                    }
                }
                FLP_WORD_MAIN_PITCH => {
                    if let Some(ch_i) = current_chan_idx {
                        if let Some(ch) = channels.get_mut(ch_i) {
                            let signed_cents = val as i16;
                            ch.pitch_semitones = (signed_cents / 100).clamp(-48, 48) as i8;
                            ch.pitch_cents = (signed_cents % 100).clamp(-100, 100) as i8;
                        }
                    }
                }
                _ => {}
            }
        } else if event_id < 192 {
            // DWORD EVENT (4 bytes LE)
            if cursor + 4 > stream_end {
                break;
            }
            let val = u32::from_le_bytes([
                bytes[cursor],
                bytes[cursor + 1],
                bytes[cursor + 2],
                bytes[cursor + 3],
            ]);
            cursor += 4;

            match event_id {
                FLP_DWORD_FINE_TEMPO => {
                    let candidate = (val as f64) / 1000.0;
                    if (10.0..=522.0).contains(&candidate) {
                        bpm = candidate;
                    }
                }
                FLP_DWORD_COLOR => {
                    if let Some(ch_i) = current_chan_idx {
                        if let Some(ch) = channels.get_mut(ch_i) {
                            ch.color_hex = bgr_dword_to_hex(val);
                        }
                    }
                }
                FLP_DWORD_TARGET_MIXER => {
                    if let Some(ch_i) = current_chan_idx {
                        if let Some(ch) = channels.get_mut(ch_i) {
                            ch.assigned_mixer_insert = (val as u8).min(64);
                        }
                    }
                }
                FLP_DWORD_GENERATOR_KIND => {
                    if let Some(ch_i) = current_chan_idx {
                        if let Some(ch) = channels.get_mut(ch_i) {
                            ch.waveform = match val % 5 {
                                0 => WaveformShape::Sine,
                                1 => WaveformShape::Sawtooth,
                                2 => WaveformShape::Pulse,
                                3 => WaveformShape::Triangle,
                                _ => WaveformShape::Noise,
                            };
                        }
                    }
                }
                _ => {}
            }
        } else {
            // VARIABLE-LENGTH TEXT / BLOB EVENT (192..=255)
            let (payload_len, next_offset) = decode_unsigned_leb128(bytes, cursor)?;
            cursor = next_offset;
            if cursor + payload_len > stream_end {
                break;
            }
            let payload = &bytes[cursor..cursor + payload_len];
            cursor += payload_len;

            match event_id {
                FLP_TEXT_TITLE => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        title = s;
                    }
                }
                FLP_TEXT_AUTHOR => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        author = s;
                    }
                }
                FLP_TEXT_VERSION => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        flp_version = s;
                    }
                }
                FLP_TEXT_CHAN_NAME => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        if let Some(ch_i) = current_chan_idx {
                            if let Some(ch) = channels.get_mut(ch_i) {
                                ch.name = s;
                            }
                        }
                    }
                }
                FLP_TEXT_SAMPLE_PATH => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        if let Some(ch_i) = current_chan_idx {
                            if let Some(ch) = channels.get_mut(ch_i) {
                                if let Some(meta) = channel_meta.get_mut(&ch.id) {
                                    meta.sample_path = Some(s.clone());
                                }
                                if ch.name.starts_with("Channel ") {
                                    if let Some(stem) = Path::new(&s).file_stem() {
                                        ch.name = stem.to_string_lossy().to_string();
                                    }
                                }
                            }
                        }
                    }
                }
                FLP_TEXT_GEN_NAME => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        if let Some(ch_i) = current_chan_idx {
                            if let Some(ch) = channels.get(ch_i) {
                                if let Some(meta) = channel_meta.get_mut(&ch.id) {
                                    meta.generator_name = Some(s);
                                }
                            }
                        }
                    }
                }
                FLP_TEXT_PAT_NAME => {
                    let s = decode_flp_string(payload);
                    if !s.is_empty() {
                        if let Some(pat_i) = current_pat_idx {
                            if let Some(pat) = patterns.get_mut(pat_i) {
                                pat.name = s;
                            }
                        }
                    }
                }
                FLP_DATA_PAT_NOTES => {
                    // Ensure at least one pattern exists
                    if patterns.is_empty() {
                        patterns.push(QlPattern {
                            id: "pat_1".to_string(),
                            index: 1,
                            name: "Pattern 1".to_string(),
                            color_hex: "#00B4D8".to_string(),
                            time_signature: TimeSignature {
                                numerator: 4,
                                denominator: 4,
                            },
                            step_count: 16,
                            channel_data: HashMap::new(),
                        });
                        current_pat_idx = Some(0);
                    }
                    let pat_i = current_pat_idx.unwrap_or(0);
                    let pat = &mut patterns[pat_i];

                    // Each FLP note record is 24 bytes:
                    // 0..4   : start_tick (u32 LE)
                    // 4..6   : flags (u16 LE; bit 0x0008 = slide note, bit 0x0010 = porta)
                    // 6..8   : rack_channel_index (u16 LE)
                    // 8..12  : duration_ticks (u32 LE; 0 = step-sequencer trigger)
                    // 12..14 : midi_key (u16 LE; 0..127)
                    // 14..16 : voice_color_group (u16 LE; 0..15)
                    // 16     : fine_pitch (u8; 120 = center 0 cents, 10 units per semitone)
                    // 17     : release_velocity (u8)
                    // 18     : mod_x / cutoff (u8; 128 = center)
                    // 19     : mod_y / resonance (u8; 128 = center)
                    // 20     : pan (u8; 64 = center)
                    // 21     : velocity (u8; 0..128)
                    // 22..24 : reserved
                    for (note_idx, rec) in payload.chunks_exact(24).enumerate() {
                        let start_tick = u32::from_le_bytes([rec[0], rec[1], rec[2], rec[3]]);
                        let flags = u16::from_le_bytes([rec[4], rec[5]]);
                        let chan_idx = u16::from_le_bytes([rec[6], rec[7]]) as usize;
                        let raw_dur = u32::from_le_bytes([rec[8], rec[9], rec[10], rec[11]]);
                        let midi_key = (u16::from_le_bytes([rec[12], rec[13]]) & 0x7F) as u8;
                        let color_group = (u16::from_le_bytes([rec[14], rec[15]]) & 0x0F) as u8;
                        let raw_fine_pitch = rec[16];
                        let rel_vel = rec[17].min(127);
                        let raw_mod_x = rec[18];
                        let raw_mod_y = rec[19];
                        let raw_pan = rec[20];
                        let raw_vel = rec[21].min(127);

                        let channel_id = channels
                            .get(chan_idx)
                            .map(|c| c.id.clone())
                            .unwrap_or_else(|| format!("ch_{chan_idx}"));

                        let entry = pat.channel_data.entry(channel_id.clone()).or_insert_with(|| {
                            QlChannelPatternData {
                                channel_id: channel_id.clone(),
                                steps: default_16_steps(),
                                notes: Vec::new(),
                            }
                        });

                        let pan_norm = (((raw_pan as f32) - 64.0) / 64.0).clamp(-1.0, 1.0);
                        let fine_cents = ((raw_fine_pitch as f32) - 120.0) * 10.0;
                        let is_slide = (flags & 0x0008) != 0;
                        let is_porta = (flags & 0x0010) != 0;

                        // Map 16th-grid aligned triggers into the 16-step sequencer grid
                        let step_idx = (start_tick / ticks_per_step) as usize;
                        let step_rem = (start_tick % ticks_per_step) as u16;
                        if step_idx < entry.steps.len() && !is_slide && (raw_dur == 0 || raw_dur <= ticks_per_step) {
                            let root = channels.get(chan_idx).map(|c| c.root_midi_note).unwrap_or(60);
                            entry.steps[step_idx] = QlStep {
                                active: true,
                                velocity: if raw_vel == 0 { 100 } else { raw_vel },
                                fine_pan: pan_norm,
                                pitch_offset_semitones: (midi_key as i16 - root as i16).clamp(-24, 24) as i8,
                                fine_pitch_cents: (fine_cents.clamp(-100.0, 100.0)) as i8,
                                gate_ratio: if raw_dur == 0 {
                                    0.80
                                } else {
                                    ((raw_dur as f32) / (ticks_per_step as f32)).clamp(0.1, 4.0)
                                },
                                shift_ticks: step_rem,
                            };
                        }

                        // Always retain full Piano Roll representation as well
                        entry.notes.push(QlPianoRollNote {
                            id: format!("note_{}_{}", pat.index, note_idx),
                            start_tick,
                            duration_ticks: if raw_dur == 0 { ticks_per_step } else { raw_dur },
                            midi_note: if midi_key == 0 { 60 } else { midi_key },
                            velocity: if raw_vel == 0 { 100 } else { raw_vel },
                            release_velocity: if rel_vel == 0 { 64 } else { rel_vel },
                            fine_pan: pan_norm,
                            fine_pitch_cents: fine_cents,
                            filter_cutoff_norm: (((raw_mod_x as f32) - 128.0) / 128.0).clamp(-1.0, 1.0),
                            filter_resonance_norm: (((raw_mod_y as f32) - 128.0) / 128.0).clamp(-1.0, 1.0),
                            voice_color_group: color_group,
                            is_slide_note: is_slide,
                            is_porta_note: is_porta,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    // Backfill declared channels if the FLP only specified count in FLhd
    while (channels.len() as u16) < declared_channel_count {
        let idx = channels.len() as u16;
        let id = format!("ch_{idx}");
        channels.push(QlChannel {
            id: id.clone(),
            index: idx,
            name: format!("Channel {}", idx + 1),
            color_hex: palette[(idx as usize) % palette.len()].to_string(),
            waveform: WaveformShape::Sawtooth,
            sample_slot: if idx < 4 { Some(idx as u8) } else { None },
            pan: 0.0,
            volume_db: 0.0,
            root_midi_note: 60,
            pitch_semitones: 0,
            pitch_cents: 0,
            swing_multiplier: 1.0,
            muted: false,
            solo: false,
            assigned_mixer_insert: ((idx as u8) % 64) + 1,
        });
    }

    if patterns.is_empty() {
        patterns.push(QlPattern {
            id: "pat_1".to_string(),
            index: 1,
            name: "Pattern 1".to_string(),
            color_hex: "#00B4D8".to_string(),
            time_signature: TimeSignature {
                numerator: 4,
                denominator: 4,
            },
            step_count: 16,
            channel_data: HashMap::new(),
        });
    }

    // Ensure every pattern has step arrays initialized for all channels
    for pat in &mut patterns {
        for ch in &channels {
            pat.channel_data
                .entry(ch.id.clone())
                .or_insert_with(|| QlChannelPatternData {
                    channel_id: ch.id.clone(),
                    steps: default_16_steps(),
                    notes: Vec::new(),
                });
        }
    }

    // If a clean-room demo FLP has no embedded note block yet, seed a signature starter beat on Pattern 1
    let has_any_active_step = patterns.iter().any(|p| {
        p.channel_data
            .values()
            .any(|cd| cd.steps.iter().any(|s| s.active) || !cd.notes.is_empty())
    });
    if !has_any_active_step {
        if let Some(first_pat) = patterns.first_mut() {
            for (ch_i, ch) in channels.iter().enumerate() {
                if let Some(cd) = first_pat.channel_data.get_mut(&ch.id) {
                    let pattern_indices: &[usize] = match ch_i % 4 {
                        0 => &[0, 4, 8, 12],          // Four-on-the-floor Kick
                        1 => &[4, 12],                // Backbeat Clap
                        2 => &[0, 2, 4, 6, 8, 10, 12, 14], // 8th Closed Hats
                        _ => &[0, 3, 6, 10, 14],      // Syncopated 808 Sub Bass
                    };
                    for &s_idx in pattern_indices {
                        if let Some(step) = cd.steps.get_mut(s_idx) {
                            step.active = true;
                            step.velocity = if s_idx % 4 == 0 { 118 } else { 96 };
                        }
                    }
                }
            }
        }
    }

    let active_pattern_id = patterns[0].id.clone();

    Ok(QlProjectPayload {
        source_path: source_path.to_string(),
        title,
        author,
        flp_version,
        format_type,
        bpm,
        ppq: ppq as u16,
        global_swing_ratio,
        active_pattern_id,
        channels,
        channel_meta,
        patterns,
        raw_event_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_demo_flp_file() {
        let demo_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("demo_project.flp");
        if demo_path.exists() {
            let project = parse_flp_file(&demo_path).expect("should parse demo_project.flp");
            assert_eq!(project.title, "Ql Studio Clean-Room Demo");
            assert!((project.bpm - 140.0).abs() < 1e-6);
            assert_eq!(project.ppq, 96);
            assert_eq!(project.channels.len(), 4);
            assert_eq!(project.channels[0].name, "808 Kick");
        }
    }
}
