/**
 * QL STUDIO — 64+ Insert Mixer Routing Graph & DSP Primitives
 *
 * Implements:
 * 1. Directed Acyclic Graph (DAG) verification & topological execution schedule
 * 2. Mid/Side Stereo Separation & Constant-Power Panning
 * 3. RBJ Audio EQ Cookbook Biquad Filter Coefficients
 */

import type {
  BiquadFilterMode,
  ParametricEqBand,
  QlMixerInsert,
  QlMixerSend,
  QlMixerState,
} from "./schemas.ts";

export interface MixerGraphVerificationResult {
  readonly isAcyclic: boolean;
  readonly topologicalOrder: readonly number[];
  readonly cycleInserts: readonly number[];
}

/**
 * Verifies that the 64+ insert routing matrix contains no feedback loops
 * using Kahn's topological sort algorithm, and produces the exact DSP evaluation order.
 */
export function verifyAcyclicRoutingGraph(
  mixer: QlMixerState,
): MixerGraphVerificationResult {
  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();

  for (const ins of mixer.inserts) {
    inDegree.set(ins.index, 0);
    adjacency.set(ins.index, []);
  }

  for (const send of mixer.sends) {
    if (send.sourceInsert === send.targetInsert) {
      return {
        isAcyclic: false,
        topologicalOrder: [],
        cycleInserts: [send.sourceInsert],
      };
    }
    const targets = adjacency.get(send.sourceInsert);
    if (targets && !targets.includes(send.targetInsert)) {
      targets.push(send.targetInsert);
      inDegree.set(
        send.targetInsert,
        (inDegree.get(send.targetInsert) ?? 0) + 1,
      );
    }
  }

  const queue: number[] = [];
  for (const [insertIdx, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(insertIdx);
    }
  }

  const topologicalOrder: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    topologicalOrder.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const nextDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, nextDeg);
      if (nextDeg === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (topologicalOrder.length !== mixer.inserts.length) {
    const cycleInserts = mixer.inserts
      .map((i) => i.index)
      .filter((idx) => !topologicalOrder.includes(idx));
    return {
      isAcyclic: false,
      topologicalOrder,
      cycleInserts,
    };
  }

  return {
    isAcyclic: true,
    topologicalOrder,
    cycleInserts: [],
  };
}

/**
 * Applies FL-style Mid/Side Stereo Separation and Constant-Power Panning to a stereo frame.
 *
 * Mid  = (L + R) * 0.5
 * Side = (L - R) * 0.5
 * - stereoSeparation < 0: attenuates Side toward 100% Merged Mono (-1.0)
 * - stereoSeparation > 0: boosts Side / attenuates Mid toward 100% Separated (+1.0)
 */
export function processStereoSeparationAndPan(
  leftIn: number,
  rightIn: number,
  stereoSeparation: number,
  pan: number,
): readonly [number, number] {
  const mid = 0.5 * (leftIn + rightIn);
  const side = 0.5 * (leftIn - rightIn);

  const sep = Math.min(1.0, Math.max(-1.0, stereoSeparation));
  const midGain = sep > 0 ? 1.0 - sep : 1.0;
  const sideGain = sep < 0 ? 1.0 + sep : 1.0 + sep;

  const separatedL = mid * midGain + side * sideGain;
  const separatedR = mid * midGain - side * sideGain;

  // Constant-power pan law (sin/cos)
  const clampedPan = Math.min(1.0, Math.max(-1.0, pan));
  const panAngle = ((clampedPan + 1.0) * Math.PI) / 4.0;
  const gainL = Math.cos(panAngle) * Math.SQRT2;
  const gainR = Math.sin(panAngle) * Math.SQRT2;

  return [separatedL * gainL, separatedR * gainR] as const;
}

export interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * Computes normalized biquad filter coefficients (b0, b1, b2, a1, a2)
 * using Robert Bristow-Johnson's Audio EQ Cookbook formulas.
 */
export function computeRbjBiquadCoefficients(
  band: ParametricEqBand,
  sampleRate: number,
): BiquadCoefficients {
  const A = Math.pow(10.0, band.gainDb / 40.0);
  const w0 = (2.0 * Math.PI * band.frequencyHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2.0 * Math.max(0.05, band.qFactor));

  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;

  switch (band.mode) {
    case "lowpass":
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "bandpass_csg":
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "notch":
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "peaking":
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
      break;
    case "lowshelf": {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
      b2 = A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = -2 * (A - 1 + (A + 1) * cosW0);
      a2 = A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case "highshelf": {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
      b2 = A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = 2 * (A - 1 - (A + 1) * cosW0);
      a2 = A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Helper to create a default 65-insert mixer state (Master 0 + Inserts 1..64)
 * with every insert routed to Master (0).
 */
export function createDefaultMixerState(insertCount: number = 64): QlMixerState {
  const inserts: QlMixerInsert[] = [];
  const sends: QlMixerSend[] = [];

  for (let i = 0; i <= insertCount; i++) {
    inserts.push({
      index: i,
      name: i === 0 ? "Master" : `Insert ${i}`,
      colorHex: i === 0 ? "#485156" : "#5F686D",
      inputGainDb: 0.0,
      faderVolumeDb: 0.0,
      pan: 0.0,
      stereoSeparation: 0.0,
      polarityInverted: false,
      swapLeftRight: false,
      muted: false,
      solo: false,
      effectSlots: [],
    });

    if (i > 0) {
      sends.push({
        sourceInsert: i,
        targetInsert: 0,
        gainLinear: 1.0,
        preFader: false,
        sidechainOnly: false,
      });
    }
  }

  return {
    masterInsertIndex: 0,
    inserts,
    sends,
  };
}
