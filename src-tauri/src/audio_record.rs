//! QL STUDIO — Low-Latency Live Audio Input & Vocal Recording Engine
//!
//! Captures microphone / instrument audio via `cpal` input stream, provides
//! zero-latency live input monitoring through mixer inserts, and writes
//! broadcast-quality 16-bit / 48kHz stereo WAV files for instant Playlist Arranger placement.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use rtrb::Producer;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDeviceInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedAudioSummary {
    pub file_path: String,
    pub file_name: String,
    pub sample_rate: u32,
    pub duration_seconds: f64,
    pub frame_count: u64,
    pub start_tick: u64,
    pub track_index: u16,
}

struct InputAudioStreamHolder(#[allow(dead_code)] cpal::Stream);
unsafe impl Send for InputAudioStreamHolder {}
unsafe impl Sync for InputAudioStreamHolder {}

pub struct AudioRecorderManager {
    pub is_recording: Arc<AtomicBool>,
    pub live_monitoring_enabled: Arc<AtomicBool>,
    pub target_insert: Arc<Mutex<u8>>,
    pub recorded_frames: Arc<Mutex<Vec<f32>>>,
    pub recording_start_tick: Arc<AtomicU64>,
    pub recording_track_index: Arc<Mutex<u16>>,
    pub sample_rate: u32,
    pub channels: u16,
    pub selected_device_name: Arc<Mutex<Option<String>>>,
    pub monitor_producer: Option<Arc<Mutex<Producer<f32>>>>,
    _stream: Option<InputAudioStreamHolder>,
}

impl AudioRecorderManager {
    pub fn new(monitor_producer: Option<Producer<f32>>) -> Self {
        let is_recording = Arc::new(AtomicBool::new(false));
        // Default live monitoring to FALSE to prevent acoustic feedback Larsen effect ("beeep" squeal) through speakers
        let live_monitoring_enabled = Arc::new(AtomicBool::new(false));
        let target_insert = Arc::new(Mutex::new(1));
        let recorded_frames = Arc::new(Mutex::new(Vec::with_capacity(48000 * 60))); // Preallocate 1 min
        let recording_start_tick = Arc::new(AtomicU64::new(0));
        let recording_track_index = Arc::new(Mutex::new(1));
        let selected_device_name = Arc::new(Mutex::new(None));
        let monitor_producer = monitor_producer.map(|p| Arc::new(Mutex::new(p)));

        let mut mgr = Self {
            is_recording,
            live_monitoring_enabled,
            target_insert,
            recorded_frames,
            recording_start_tick,
            recording_track_index,
            sample_rate: 48000,
            channels: 2,
            selected_device_name,
            monitor_producer,
            _stream: None,
        };

        mgr.try_start_input_stream();
        mgr
    }

    /// List all physical audio input devices (Microphones, Audio Interfaces).
    pub fn list_input_devices() -> Vec<AudioInputDeviceInfo> {
        let host = cpal::default_host();
        let default_name = host
            .default_input_device()
            .and_then(|d| d.name().ok())
            .unwrap_or_default();

        let mut devices = Vec::new();
        if let Ok(dev_iter) = host.input_devices() {
            for dev in dev_iter {
                if let Ok(name) = dev.name() {
                    let is_default = name == default_name;
                    devices.push(AudioInputDeviceInfo { name, is_default });
                }
            }
        }

        if devices.is_empty() {
            devices.push(AudioInputDeviceInfo {
                name: "Default System Microphone".to_string(),
                is_default: true,
            });
        }

        devices
    }

    pub fn set_live_monitoring(&self, enabled: bool) {
        self.live_monitoring_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn try_start_input_stream(&mut self) {
        let host = cpal::default_host();
        let device = host.default_input_device();
        let Some(dev) = device else {
            return;
        };

        let Ok(config) = dev.default_input_config() else {
            return;
        };

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        self.sample_rate = sample_rate;
        self.channels = channels;

        let is_rec = self.is_recording.clone();
        let rec_buf = self.recorded_frames.clone();
        let is_mon = self.live_monitoring_enabled.clone();
        let mon_prod = self.monitor_producer.clone();

        let stream_res = dev.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if is_rec.load(Ordering::Relaxed) {
                    if let Ok(mut buf) = rec_buf.lock() {
                        buf.extend_from_slice(data);
                    }
                }

                if is_mon.load(Ordering::Relaxed) {
                    if let Some(ref m_prod) = mon_prod {
                        if let Ok(mut prod) = m_prod.lock() {
                            for &s in data {
                                let _ = prod.push(s);
                            }
                        }
                    }
                }
            },
            move |err| {
                eprintln!("[QlStudio Audio Input Warning]: {err}");
            },
            None,
        );

        if let Ok(stream) = stream_res {
            let _ = stream.play();
            self._stream = Some(InputAudioStreamHolder(stream));
        }
    }

    /// Arm and start recording live microphone audio at the given arrangement timeline tick.
    pub fn start_recording(&mut self, start_tick: u64, track_index: u16) {
        if let Ok(mut buf) = self.recorded_frames.lock() {
            buf.clear();
        }
        self.recording_start_tick.store(start_tick, Ordering::Release);
        if let Ok(mut trk) = self.recording_track_index.lock() {
            *trk = track_index;
        }
        self.is_recording.store(true, Ordering::Release);
    }

    /// Stop recording, encode captured audio into a 16-bit 48kHz stereo WAV file,
    /// and return the summary for immediate Playlist Arranger placement.
    pub fn stop_recording(&mut self, samples_dir: &Path) -> Result<Option<RecordedAudioSummary>, String> {
        if !self.is_recording.swap(false, Ordering::AcqRel) {
            return Ok(None);
        }

        let raw_samples = {
            let mut guard = self.recorded_frames.lock().map_err(|e| e.to_string())?;
            std::mem::take(&mut *guard)
        };

        if raw_samples.is_empty() {
            return Ok(None);
        }

        std::fs::create_dir_all(samples_dir)
            .map_err(|e| format!("Failed to create samples dir: {e}"))?;

        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let file_name = format!("recorded_vocal_{}.wav", timestamp);
        let file_path = samples_dir.join(&file_name);

        let channels = self.channels.max(1);
        let spec = WavSpec {
            channels,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = WavWriter::create(&file_path, spec)
            .map_err(|e| format!("Failed to create WAV writer: {e}"))?;

        for &sample in &raw_samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let s16 = (clamped * 32767.0).round() as i16;
            writer.write_sample(s16).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        let total_frames = (raw_samples.len() as u64) / (channels as u64);
        let duration_seconds = (total_frames as f64) / (self.sample_rate as f64);
        let start_tick = self.recording_start_tick.load(Ordering::Relaxed);
        let track_index = *self.recording_track_index.lock().unwrap_or_else(|p| p.into_inner());

        Ok(Some(RecordedAudioSummary {
            file_path: file_path.to_string_lossy().to_string(),
            file_name,
            sample_rate: self.sample_rate,
            duration_seconds,
            frame_count: total_frames,
            start_tick,
            track_index,
        }))
    }
}
