//! QL STUDIO — Hardware MIDI Controller Engine & Plug-and-Play Mapper
//!
//! Connects external physical USB MIDI hardware keyboards and pad controllers
//! (Akai Fire, Novation Launchkey, Arturia KeyStep, Generic USB MIDI)
//! to the real-time audio engine with sub-millisecond input response.

use crate::dsp::midi_note_to_frequency_hz;
use crate::schemas::{
    AudioScheduledEventKind, RealTimeCommand, ScheduledAudioEventPod, WaveformShape,
};
use midir::{Ignore, MidiInput, MidiInputConnection};
use rtrb::Producer;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDeviceInfo {
    pub index: usize,
    pub name: String,
    pub is_connected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MidiControllerProfile {
    Generic,
    AkaiFire,
    NovationLaunchkey,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiStatusSnapshot {
    pub connected_device: Option<String>,
    pub active_profile: MidiControllerProfile,
    pub last_activity_timestamp_ms: u64,
    pub last_note_played: Option<u8>,
}

pub struct MidiManager {
    connection: Option<MidiInputConnection<()>>,
    pub connected_name: Option<String>,
    pub profile: MidiControllerProfile,
    pub last_activity_ms: Arc<AtomicU64>,
    pub last_note: Arc<Mutex<Option<u8>>>,
    pub is_active_atomic: Arc<AtomicBool>,
    pub event_producer: Arc<Mutex<Producer<ScheduledAudioEventPod>>>,
    pub command_producer: Arc<Mutex<Producer<RealTimeCommand>>>,
    frame_counter: Arc<AtomicU64>,
}

impl MidiManager {
    pub fn new(
        event_producer: Producer<ScheduledAudioEventPod>,
        command_producer: Producer<RealTimeCommand>,
        frame_counter: Arc<AtomicU64>,
    ) -> Self {
        Self {
            connection: None,
            connected_name: None,
            profile: MidiControllerProfile::Generic,
            last_activity_ms: Arc::new(AtomicU64::new(0)),
            last_note: Arc::new(Mutex::new(None)),
            is_active_atomic: Arc::new(AtomicBool::new(false)),
            event_producer: Arc::new(Mutex::new(event_producer)),
            command_producer: Arc::new(Mutex::new(command_producer)),
            frame_counter,
        }
    }

    /// List all currently available physical and virtual MIDI input ports on the system.
    pub fn list_ports(&self) -> Vec<MidiDeviceInfo> {
        let Ok(midi_in) = MidiInput::new("Ql Studio Port Enumerator") else {
            return Vec::new();
        };

        let ports = midi_in.ports();
        let mut devices = Vec::new();

        for (idx, port) in ports.iter().enumerate() {
            let name = midi_in
                .port_name(port)
                .unwrap_or_else(|_| format!("MIDI Port {}", idx + 1));
            let is_connected = self.connected_name.as_deref() == Some(&name);
            devices.push(MidiDeviceInfo {
                index: idx,
                name,
                is_connected,
            });
        }

        devices
    }

    /// Connect to a specific MIDI input port by index with lock-free real-time audio routing.
    pub fn connect_port(
        &mut self,
        port_index: usize,
        profile: MidiControllerProfile,
    ) -> Result<String, String> {
        // Disconnect existing connection if any
        self.disconnect();

        let mut midi_in = MidiInput::new("Ql Studio Controller Input")
            .map_err(|e| format!("Failed to initialize MIDI input: {e}"))?;
        midi_in.ignore(Ignore::None);

        let ports = midi_in.ports();
        let port = ports
            .get(port_index)
            .ok_or_else(|| format!("MIDI port index {} out of range", port_index))?;
        let port_name = midi_in
            .port_name(port)
            .unwrap_or_else(|_| format!("MIDI Port {}", port_index));

        let last_act = self.last_activity_ms.clone();
        let last_n = self.last_note.clone();
        let is_active = self.is_active_atomic.clone();
        let ev_prod = self.event_producer.clone();
        let cmd_prod = self.command_producer.clone();
        let frame_counter = self.frame_counter.clone();

        // High-priority real-time MIDI receiver callback
        let connection = midi_in
            .connect(
                port,
                "ql-studio-midi-cb",
                move |_timestamp_us, message, _| {
                    if message.is_empty() {
                        return;
                    }

                    // Record activity timestamp for UI activity LED
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    last_act.store(now_ms, Ordering::Relaxed);
                    is_active.store(true, Ordering::Relaxed);

                    let status = message[0];
                    let msg_type = status & 0xF0;
                    let _channel = status & 0x0F;

                    let cur_frame = frame_counter.load(Ordering::Relaxed);

                    match msg_type {
                        // Note On
                        0x90 if message.len() >= 3 => {
                            let note = message[1];
                            let vel = message[2];

                            if vel > 0 {
                                if let Ok(mut guard) = last_n.lock() {
                                    *guard = Some(note);
                                }
                                let freq_hz = midi_note_to_frequency_hz(note, 0.0);
                                let vel_norm = (vel as f32) / 127.0;

                                let pod = ScheduledAudioEventPod {
                                    sample_frame: cur_frame,
                                    duration_frames: 48000 * 2, // 2s sustain envelope until NoteOff
                                    channel_index: 0,           // Triggers active focused channel
                                    assigned_mixer_insert: 1,
                                    voice_color_group: 0,
                                    kind: AudioScheduledEventKind::NoteOn,
                                    waveform: WaveformShape::Sawtooth,
                                    sample_slot: 0,
                                    root_midi_note: 60,
                                    midi_note: note,
                                    velocity: vel,
                                    start_freq_hz: freq_hz,
                                    target_freq_hz: freq_hz,
                                    pan: 0.0,
                                    gain_linear: vel_norm * 0.8,
                                };
                                if let Ok(mut prod) = ev_prod.lock() {
                                    let _ = prod.push(pod);
                                }
                            } else {
                                // Note Off via Velocity 0
                                let pod = ScheduledAudioEventPod {
                                    sample_frame: cur_frame,
                                    duration_frames: 192,
                                    channel_index: 0,
                                    assigned_mixer_insert: 1,
                                    voice_color_group: 0,
                                    kind: AudioScheduledEventKind::NoteOff,
                                    waveform: WaveformShape::Sawtooth,
                                    sample_slot: 0,
                                    root_midi_note: 60,
                                    midi_note: note,
                                    velocity: 0,
                                    start_freq_hz: 0.0,
                                    target_freq_hz: 0.0,
                                    pan: 0.0,
                                    gain_linear: 0.0,
                                };
                                if let Ok(mut prod) = ev_prod.lock() {
                                    let _ = prod.push(pod);
                                }
                            }
                        }

                        // Note Off
                        0x80 if message.len() >= 3 => {
                            let note = message[1];
                            let pod = ScheduledAudioEventPod {
                                sample_frame: cur_frame,
                                duration_frames: 192,
                                channel_index: 0,
                                assigned_mixer_insert: 1,
                                voice_color_group: 0,
                                kind: AudioScheduledEventKind::NoteOff,
                                waveform: WaveformShape::Sawtooth,
                                sample_slot: 0,
                                root_midi_note: 60,
                                midi_note: note,
                                velocity: 0,
                                start_freq_hz: 0.0,
                                target_freq_hz: 0.0,
                                pan: 0.0,
                                gain_linear: 0.0,
                            };
                            if let Ok(mut prod) = ev_prod.lock() {
                                let _ = prod.push(pod);
                            }
                        }

                        // Control Change (CC)
                        0xB0 if message.len() >= 3 => {
                            let cc_num = message[1];
                            let cc_val = message[2];
                            let val_norm = (cc_val as f32) / 127.0;

                            match profile {
                                MidiControllerProfile::AkaiFire => {
                                    // Akai Fire 4-Encoder Mapping (Vol, Pan, Filter, Reso)
                                    match cc_num {
                                        16 => {
                                            // Channel/Insert 1 Volume
                                            if let Ok(mut prod) = cmd_prod.lock() {
                                                let _ = prod.push(RealTimeCommand::SetInsertParams {
                                                    insert_index: 1,
                                                    pan: 0.0,
                                                    stereo_separation: 0.0,
                                                    fader_gain_linear: val_norm * 1.5,
                                                    muted: false,
                                                    eq_coeffs: Default::default(),
                                                    eq_enabled: false,
                                                });
                                            }
                                        }
                                        17 => {
                                            // Channel/Insert 1 Pan
                                            let pan = (val_norm * 2.0) - 1.0;
                                            if let Ok(mut prod) = cmd_prod.lock() {
                                                let _ = prod.push(RealTimeCommand::SetInsertParams {
                                                    insert_index: 1,
                                                    pan,
                                                    stereo_separation: 0.0,
                                                    fader_gain_linear: 1.0,
                                                    muted: false,
                                                    eq_coeffs: Default::default(),
                                                    eq_enabled: false,
                                                });
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                MidiControllerProfile::NovationLaunchkey => {
                                    // Novation InControl Faders 1..8
                                    if (41..=48).contains(&cc_num) {
                                        let insert_idx = (cc_num - 41 + 1) as u8;
                                        if let Ok(mut prod) = cmd_prod.lock() {
                                            let _ = prod.push(RealTimeCommand::SetInsertParams {
                                                insert_index: insert_idx,
                                                pan: 0.0,
                                                stereo_separation: 0.0,
                                                fader_gain_linear: val_norm * 1.5,
                                                muted: false,
                                                eq_coeffs: Default::default(),
                                                eq_enabled: false,
                                            });
                                        }
                                    }
                                }
                                MidiControllerProfile::Generic => {
                                    // Standard CC 7 (Volume) and CC 10 (Pan)
                                    match cc_num {
                                        7 => {
                                            if let Ok(mut prod) = cmd_prod.lock() {
                                                let _ = prod.push(RealTimeCommand::SetInsertParams {
                                                    insert_index: 1,
                                                    pan: 0.0,
                                                    stereo_separation: 0.0,
                                                    fader_gain_linear: val_norm * 1.5,
                                                    muted: false,
                                                    eq_coeffs: Default::default(),
                                                    eq_enabled: false,
                                                });
                                            }
                                        }
                                        10 => {
                                            let pan = (val_norm * 2.0) - 1.0;
                                            if let Ok(mut prod) = cmd_prod.lock() {
                                                let _ = prod.push(RealTimeCommand::SetInsertParams {
                                                    insert_index: 1,
                                                    pan,
                                                    stereo_separation: 0.0,
                                                    fader_gain_linear: 1.0,
                                                    muted: false,
                                                    eq_coeffs: Default::default(),
                                                    eq_enabled: false,
                                                });
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }

                        _ => {}
                    }
                },
                (),
            )
            .map_err(|e| format!("Failed to connect to MIDI device: {e}"))?;

        self.connected_name = Some(port_name.clone());
        self.profile = profile;
        self.connection = Some(connection);

        Ok(port_name)
    }

    /// Disconnect from currently connected MIDI port.
    pub fn disconnect(&mut self) {
        if let Some(conn) = self.connection.take() {
            conn.close();
        }
        self.connected_name = None;
    }

    pub fn get_status(&self) -> MidiStatusSnapshot {
        MidiStatusSnapshot {
            connected_device: self.connected_name.clone(),
            active_profile: self.profile,
            last_activity_timestamp_ms: self.last_activity_ms.load(Ordering::Relaxed),
            last_note_played: *self.last_note.lock().unwrap_or_else(|p| p.into_inner()),
        }
    }
}
