//! QL STUDIO — Zero-Allocation Real-Time DSP & Kahn DAG Mixer Engine
//!
//! Implements:
//! 1. Robert Bristow-Johnson (RBJ) Audio EQ Cookbook Biquad Filter (`RbjBiquadCoeffs`, `BiquadState`)
//! 2. Exponential Slide Note / Portamento Evaluator: f(t) = f0 * (f1 / f0)^(t / t_slide)
//! 3. FL-style Mid/Side Stereo Separation + Constant-Power Sin/Cos Panning
//! 4. Kahn's Algorithm Acyclic Graph Verification (`verify_acyclic_routing_graph`)
//! 5. Fast Active-Insert Sparse Mixer Evaluation (eliminating idle-channel CPU load)

use crate::schemas::{
    BiquadFilterMode, ParametricEqBand, QlMixerSend, QlMixerState, MAX_MIXER_INSERTS,
    MAX_MIXER_SENDS,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::f64::consts::{FRAC_1_SQRT_2, PI, SQRT_2};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RbjBiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Default for RbjBiquadCoeffs {
    #[inline]
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

/// Direct Form II Transposed stereo state (zero allocation, stack-resident).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StereoBiquadState {
    pub z1_l: f64,
    pub z2_l: f64,
    pub z1_r: f64,
    pub z2_r: f64,
}

impl StereoBiquadState {
    #[inline(always)]
    pub fn process_stereo(
        &mut self,
        left: f32,
        right: f32,
        coeffs: &RbjBiquadCoeffs,
    ) -> (f32, f32) {
        let xl = left as f64;
        let yl = coeffs.b0 * xl + self.z1_l;
        self.z1_l = coeffs.b1 * xl - coeffs.a1 * yl + self.z2_l;
        self.z2_l = coeffs.b2 * xl - coeffs.a2 * yl;

        let xr = right as f64;
        let yr = coeffs.b0 * xr + self.z1_r;
        self.z1_r = coeffs.b1 * xr - coeffs.a1 * yr + self.z2_r;
        self.z2_r = coeffs.b2 * xr - coeffs.a2 * yr;

        (yl as f32, yr as f32)
    }

    #[inline(always)]
    pub fn has_energy(&self) -> bool {
        self.z1_l.abs() > 1e-9
            || self.z2_l.abs() > 1e-9
            || self.z1_r.abs() > 1e-9
            || self.z2_r.abs() > 1e-9
    }
}

/// Computes normalized biquad filter coefficients using Robert Bristow-Johnson's Audio EQ Cookbook.
#[inline]
pub fn compute_rbj_biquad_coeffs(band: &ParametricEqBand, sample_rate: f64) -> RbjBiquadCoeffs {
    if !band.enabled || sample_rate <= 0.0 {
        return RbjBiquadCoeffs::default();
    }

    let a_amp = 10.0_f64.powf(band.gain_db / 40.0);
    let w0 = (2.0 * PI * band.frequency_hz.clamp(10.0, sample_rate * 0.49)) / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let q = band.q_factor.max(0.05);
    let alpha = sin_w0 / (2.0 * q);

    let (b0, b1, b2, a0, a1, a2) = match band.mode {
        BiquadFilterMode::Lowpass => (
            (1.0 - cos_w0) * 0.5,
            1.0 - cos_w0,
            (1.0 - cos_w0) * 0.5,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        BiquadFilterMode::Highpass => (
            (1.0 + cos_w0) * 0.5,
            -(1.0 + cos_w0),
            (1.0 + cos_w0) * 0.5,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        BiquadFilterMode::BandpassCsg => (
            alpha,
            0.0,
            -alpha,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        BiquadFilterMode::Notch => (
            1.0,
            -2.0 * cos_w0,
            1.0,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        BiquadFilterMode::Peaking => (
            1.0 + alpha * a_amp,
            -2.0 * cos_w0,
            1.0 - alpha * a_amp,
            1.0 + alpha / a_amp,
            -2.0 * cos_w0,
            1.0 - alpha / a_amp,
        ),
        BiquadFilterMode::Lowshelf => {
            let two_sqrt_a_alpha = 2.0 * a_amp.sqrt() * alpha;
            (
                a_amp * ((a_amp + 1.0) - (a_amp - 1.0) * cos_w0 + two_sqrt_a_alpha),
                2.0 * a_amp * ((a_amp - 1.0) - (a_amp + 1.0) * cos_w0),
                a_amp * ((a_amp + 1.0) - (a_amp - 1.0) * cos_w0 - two_sqrt_a_alpha),
                (a_amp + 1.0) + (a_amp - 1.0) * cos_w0 + two_sqrt_a_alpha,
                -2.0 * ((a_amp - 1.0) + (a_amp + 1.0) * cos_w0),
                (a_amp + 1.0) + (a_amp - 1.0) * cos_w0 - two_sqrt_a_alpha,
            )
        }
        BiquadFilterMode::Highshelf => {
            let two_sqrt_a_alpha = 2.0 * a_amp.sqrt() * alpha;
            (
                a_amp * ((a_amp + 1.0) + (a_amp - 1.0) * cos_w0 + two_sqrt_a_alpha),
                -2.0 * a_amp * ((a_amp - 1.0) + (a_amp + 1.0) * cos_w0),
                a_amp * ((a_amp + 1.0) + (a_amp - 1.0) * cos_w0 - two_sqrt_a_alpha),
                (a_amp + 1.0) - (a_amp - 1.0) * cos_w0 + two_sqrt_a_alpha,
                2.0 * ((a_amp - 1.0) - (a_amp + 1.0) * cos_w0),
                (a_amp + 1.0) - (a_amp - 1.0) * cos_w0 - two_sqrt_a_alpha,
            )
        }
    };

    let inv_a0 = 1.0 / a0;
    RbjBiquadCoeffs {
        b0: b0 * inv_a0,
        b1: b1 * inv_a0,
        b2: b2 * inv_a0,
        a1: a1 * inv_a0,
        a2: a2 * inv_a0,
    }
}

/// Converts MIDI note (0..=127) + fine cents into fundamental frequency (Hz).
#[inline(always)]
pub fn midi_note_to_frequency_hz(midi_note: u8, fine_cents: f64) -> f64 {
    let total_semitones = (midi_note as f64 - 69.0) + (fine_cents / 100.0);
    440.0 * 2.0_f64.powf(total_semitones / 12.0)
}

/// Evaluates FL Studio's signature Slide Note / Portamento pitch glide at elapsed time `t`:
///
///   f(t) = f0 * (f1 / f0)^(t / t_slide)
#[inline(always)]
pub fn evaluate_slide_frequency_hz(
    f0_hz: f64,
    f1_hz: f64,
    elapsed_frames: u64,
    slide_duration_frames: u64,
) -> f64 {
    if slide_duration_frames == 0 || elapsed_frames >= slide_duration_frames {
        return f1_hz;
    }
    if elapsed_frames == 0 {
        return f0_hz;
    }
    let ratio = (elapsed_frames as f64) / (slide_duration_frames as f64);
    f0_hz * (f1_hz / f0_hz).powf(ratio)
}

/// Applies FL-style Mid/Side Stereo Separation and Constant-Power Panning in-place without allocation.
#[inline(always)]
pub fn process_stereo_separation_and_pan(
    left_in: f32,
    right_in: f32,
    stereo_separation: f32,
    pan: f32,
) -> (f32, f32) {
    if stereo_separation.abs() < 1e-5 && pan.abs() < 1e-5 {
        return (left_in, right_in);
    }
    let mid = 0.5 * (left_in + right_in);
    let side = 0.5 * (left_in - right_in);

    let sep = stereo_separation.clamp(-1.0, 1.0);
    let mid_gain = if sep > 0.0 { 1.0 - sep } else { 1.0 };
    let side_gain = 1.0 + sep;

    let sep_l = mid * mid_gain + side * side_gain;
    let sep_r = mid * mid_gain - side * side_gain;

    let clamped_pan = (pan.clamp(-1.0, 1.0)) as f64;
    let pan_angle = ((clamped_pan + 1.0) * PI) * 0.25;
    let gain_l = (pan_angle.cos() * SQRT_2) as f32;
    let gain_r = (pan_angle.sin() * SQRT_2) as f32;
    let _ = FRAC_1_SQRT_2;

    (sep_l * gain_l, sep_r * gain_r)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DagVerificationReport {
    pub is_acyclic: bool,
    pub topological_order: Vec<u8>,
    pub cycle_inserts: Vec<u8>,
}

/// Verifies that the 64+ insert routing matrix contains no feedback cycles using Kahn's algorithm.
pub fn verify_acyclic_routing_graph(mixer: &QlMixerState) -> DagVerificationReport {
    let mut in_degree = [0u16; MAX_MIXER_INSERTS];
    let mut present = [false; MAX_MIXER_INSERTS];
    let mut adjacency = [[false; MAX_MIXER_INSERTS]; MAX_MIXER_INSERTS];
    let mut total_nodes = 0usize;

    for ins in &mixer.inserts {
        let idx = ins.index as usize;
        if idx < MAX_MIXER_INSERTS && !present[idx] {
            present[idx] = true;
            total_nodes += 1;
        }
    }

    for send in &mixer.sends {
        let src = send.source_insert as usize;
        let dst = send.target_insert as usize;
        if src >= MAX_MIXER_INSERTS || dst >= MAX_MIXER_INSERTS {
            continue;
        }
        if src == dst {
            return DagVerificationReport {
                is_acyclic: false,
                topological_order: Vec::new(),
                cycle_inserts: vec![send.source_insert],
            };
        }
        if present[src] && present[dst] && !adjacency[src][dst] {
            adjacency[src][dst] = true;
            in_degree[dst] += 1;
        }
    }

    let mut queue = VecDeque::with_capacity(MAX_MIXER_INSERTS);
    for idx in 0..MAX_MIXER_INSERTS {
        if present[idx] && in_degree[idx] == 0 {
            queue.push_back(idx as u8);
        }
    }

    let mut topological_order = Vec::with_capacity(total_nodes);
    while let Some(curr) = queue.pop_front() {
        topological_order.push(curr);
        let u = curr as usize;
        for v in 0..MAX_MIXER_INSERTS {
            if adjacency[u][v] {
                in_degree[v] = in_degree[v].saturating_sub(1);
                if in_degree[v] == 0 {
                    queue.push_back(v as u8);
                }
            }
        }
    }

    if topological_order.len() != total_nodes {
        let cycle_inserts = (0..MAX_MIXER_INSERTS)
            .filter(|&idx| present[idx] && !topological_order.contains(&(idx as u8)))
            .map(|idx| idx as u8)
            .collect();
        return DagVerificationReport {
            is_acyclic: false,
            topological_order,
            cycle_inserts,
        };
    }

    DagVerificationReport {
        is_acyclic: true,
        topological_order,
        cycle_inserts: Vec::new(),
    }
}

/// Fixed-capacity, zero-allocation mixer graph state owned exclusively by the real-time audio callback.
#[derive(Clone, Copy)]
pub struct RealTimeInsertStrip {
    pub pan: f32,
    pub stereo_separation: f32,
    pub fader_gain_linear: f32,
    pub muted: bool,
    pub eq_enabled: bool,
    pub eq_coeffs: RbjBiquadCoeffs,
    pub eq_state: StereoBiquadState,
    pub direct_master_gain: f32,
}

impl Default for RealTimeInsertStrip {
    fn default() -> Self {
        Self {
            pan: 0.0,
            stereo_separation: 0.0,
            fader_gain_linear: 1.0,
            muted: false,
            eq_enabled: false,
            eq_coeffs: RbjBiquadCoeffs::default(),
            eq_state: StereoBiquadState::default(),
            direct_master_gain: 1.0,
        }
    }
}

pub struct PreallocatedMixerGraph {
    pub strips: [RealTimeInsertStrip; MAX_MIXER_INSERTS],
    pub topological_order: [u8; MAX_MIXER_INSERTS],
    pub node_count: u8,
    pub sends: [QlMixerSend; MAX_MIXER_SENDS],
    pub send_count: u8,
    pub non_master_send_count: u8,
    pub buses_lr: [[f32; 2]; MAX_MIXER_INSERTS],
    pub bus_active: [bool; MAX_MIXER_INSERTS],
}

impl Default for PreallocatedMixerGraph {
    fn default() -> Self {
        let mut topological_order = [0u8; MAX_MIXER_INSERTS];
        let mut sends = [QlMixerSend {
            source_insert: 0,
            target_insert: 0,
            gain_linear: 0.0,
            pre_fader: false,
            sidechain_only: false,
        }; MAX_MIXER_SENDS];

        for i in 1..MAX_MIXER_INSERTS {
            topological_order[i - 1] = i as u8;
            sends[i - 1] = QlMixerSend {
                source_insert: i as u8,
                target_insert: 0,
                gain_linear: 1.0,
                pre_fader: false,
                sidechain_only: false,
            };
        }
        topological_order[MAX_MIXER_INSERTS - 1] = 0;

        Self {
            strips: [RealTimeInsertStrip::default(); MAX_MIXER_INSERTS],
            topological_order,
            node_count: MAX_MIXER_INSERTS as u8,
            sends,
            send_count: (MAX_MIXER_INSERTS - 1) as u8,
            non_master_send_count: 0,
            buses_lr: [[0.0; 2]; MAX_MIXER_INSERTS],
            bus_active: [false; MAX_MIXER_INSERTS],
        }
    }
}

impl PreallocatedMixerGraph {
    #[inline(always)]
    pub fn clear_buses(&mut self) {
        self.buses_lr = [[0.0; 2]; MAX_MIXER_INSERTS];
        self.bus_active = [false; MAX_MIXER_INSERTS];
    }

    pub fn rebuild_fast_send_lookup(&mut self) {
        for strip in &mut self.strips {
            strip.direct_master_gain = 0.0;
        }
        let mut non_master = 0u8;
        let len = (self.send_count as usize).min(MAX_MIXER_SENDS);
        for i in 0..len {
            let s = self.sends[i];
            if s.sidechain_only {
                continue;
            }
            if s.target_insert == 0 && (s.source_insert as usize) < MAX_MIXER_INSERTS {
                self.strips[s.source_insert as usize].direct_master_gain = s.gain_linear;
            } else {
                non_master = non_master.saturating_add(1);
            }
        }
        self.non_master_send_count = non_master;
    }

    /// Evaluates active mixer inserts in topological order for a single stereo sample frame.
    /// Skips silent/idle inserts in O(1) to prevent CPU underruns on Linux PipeWire/ALSA.
    #[inline(always)]
    pub fn process_frame(&mut self) -> (f32, f32) {
        let count = (self.node_count as usize).min(MAX_MIXER_INSERTS);
        let has_aux_sends = self.non_master_send_count > 0;
        let send_len = (self.send_count as usize).min(MAX_MIXER_SENDS);

        for idx in 0..count {
            let insert_id = self.topological_order[idx] as usize;
            if insert_id >= MAX_MIXER_INSERTS {
                continue;
            }

            let is_active = self.bus_active[insert_id]
                || (self.strips[insert_id].eq_enabled && self.strips[insert_id].eq_state.has_energy());
            if !is_active {
                continue;
            }

            let strip = &mut self.strips[insert_id];
            if strip.muted {
                self.buses_lr[insert_id] = [0.0, 0.0];
                continue;
            }

            let (mut l, mut r) = (self.buses_lr[insert_id][0], self.buses_lr[insert_id][1]);

            if strip.eq_enabled {
                let (el, er) = strip.eq_state.process_stereo(l, r, &strip.eq_coeffs);
                l = el;
                r = er;
            }

            let (pl, pr) =
                process_stereo_separation_and_pan(l, r, strip.stereo_separation, strip.pan);
            l = pl * strip.fader_gain_linear;
            r = pr * strip.fader_gain_linear;

            self.buses_lr[insert_id] = [l, r];

            if insert_id != 0 {
                let master_gain = strip.direct_master_gain;
                if master_gain > 0.0 {
                    self.buses_lr[0][0] += l * master_gain;
                    self.buses_lr[0][1] += r * master_gain;
                    self.bus_active[0] = true;
                }
                if has_aux_sends {
                    for s_idx in 0..send_len {
                        let send = &self.sends[s_idx];
                        if send.source_insert as usize == insert_id
                            && send.target_insert != 0
                            && !send.sidechain_only
                        {
                            let target = send.target_insert as usize;
                            if target < MAX_MIXER_INSERTS && target != insert_id {
                                self.buses_lr[target][0] += l * send.gain_linear;
                                self.buses_lr[target][1] += r * send.gain_linear;
                                self.bus_active[target] = true;
                            }
                        }
                    }
                }
            }
        }

        // Soft-clipping master limiter (smooth tanh saturation above +/- 0.95)
        let master = self.buses_lr[0];
        let out_l = if master[0].abs() > 0.95 {
            master[0].tanh()
        } else {
            master[0]
        };
        let out_r = if master[1].abs() > 0.95 {
            master[1].tanh()
        } else {
            master[1]
        };
        (out_l.clamp(-1.0, 1.0), out_r.clamp(-1.0, 1.0))
    }
}
