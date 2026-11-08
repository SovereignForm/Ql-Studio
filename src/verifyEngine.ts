import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCleanRoomSampleFlp,
  parseFlpBinary,
} from "./flpParser.ts";
import {
  computeRbjBiquadCoefficients,
  createDefaultMixerState,
  processStereoSeparationAndPan,
  verifyAcyclicRoutingGraph,
} from "./mixer.ts";
import type { QlChannel, QlPattern } from "./schemas.ts";
import {
  computeTimingMetrics,
  evaluateSlideFrequencyHz,
  QlLookaheadScheduler,
} from "./scheduler.ts";

const sampleRate = 48000;
const bpm = 140;
const ppq = 96;

// 1. Verify Timing Metrics
const metrics = computeTimingMetrics(bpm, ppq, sampleRate);
console.log("[1] Timing Metrics (140 BPM, 96 PPQ, 48kHz):", metrics);

// 2. Verify Lookahead Scheduler with Swing (62.5%) & Slide Notes
const scheduler = new QlLookaheadScheduler({
  bpm,
  ppq,
  sampleRate,
  globalSwingRatio: 0.625,
  lookaheadWindowSec: 0.04, // 40ms lookahead window
  timerIntervalMs: 10,
});

const leadChannel: QlChannel = {
  id: "ch_lead",
  index: 0,
  name: "808 Sub Lead",
  colorHex: "#FF6B35",
  generator: {
    kind: "oscillator_synth",
    oscillators: [
      {
        waveform: "sawtooth",
        coarseSemitones: 0,
        fineCents: 0,
        mixLevel: 1.0,
        pulseWidth: 0.5,
      },
    ],
  },
  pan: 0.0,
  volumeDb: 0.0,
  rootMidiNote: 60,
  pitchSemitones: 0,
  pitchCents: 0,
  swingMultiplier: 1.0,
  muted: false,
  solo: false,
  assignedMixerInsert: 1,
};

const pattern: QlPattern = {
  id: "pat_1",
  index: 1,
  name: "Main Groove",
  colorHex: "#00B4D8",
  timeSignature: { numerator: 4, denominator: 4 },
  stepCount: 16,
  channelData: {
    ch_lead: {
      channelId: "ch_lead",
      steps: [
        {
          active: true,
          velocity: 110,
          finePan: 0,
          pitchOffsetSemitones: 0,
          finePitchCents: 0,
          gateRatio: 0.8,
          shiftTicks: 0,
        },
        {
          active: true, // Odd 16th step (step 1) -> shifted by 62.5% swing!
          velocity: 95,
          finePan: 0.1,
          pitchOffsetSemitones: 3,
          finePitchCents: 0,
          gateRatio: 0.8,
          shiftTicks: 0,
        },
      ],
      notes: [
        {
          id: "n_carrier",
          startTick: 0,
          durationTicks: 96,
          midiNote: 60, // C5
          velocity: 100,
          releaseVelocity: 64,
          finePan: 0,
          finePitchCents: 0,
          filterCutoffNorm: 0,
          filterResonanceNorm: 0,
          voiceColorGroup: 0,
          isSlideNote: false,
          isPortaNote: false,
        },
        {
          id: "n_slide",
          startTick: 24,
          durationTicks: 48,
          midiNote: 72, // Slide up 1 octave to C6
          velocity: 100,
          releaseVelocity: 64,
          finePan: 0,
          finePitchCents: 0,
          filterCutoffNorm: 0,
          filterResonanceNorm: 0,
          voiceColorGroup: 0,
          isSlideNote: true,
          isPortaNote: false,
        },
      ],
    },
  },
};

scheduler.start(0.0);
for (let step = 0; step < 15; step++) {
  scheduler.advanceLookahead(step * 0.025, pattern, [leadChannel]);
}
const scheduledEvents = scheduler.eventQueue.dequeueUpToFrame(sampleRate);
console.log(
  `[2] Scheduled ${scheduledEvents.length} sample-accurate events in first 1.0s:`,
  scheduledEvents.map((e) => ({
    type: e.eventType,
    tick: e.patternTick,
    sampleFrame: e.sampleFrame,
    freqHz: Number(e.frequencyHz.toFixed(2)),
    targetSlideHz: e.targetSlideFrequencyHz
      ? Number(e.targetSlideFrequencyHz.toFixed(2))
      : null,
  })),
);

// 3. Verify Exponential Slide Note Midpoint (Octave glide midpoint = +6 semitones = F#5)
const f0 = 261.625565;
const f1 = 523.25113;
const fMid = evaluateSlideFrequencyHz(f0, f1, 0.25, 0.5);
console.log(
  `[3] Slide Note Midpoint Check (f0=${f0.toFixed(2)}Hz -> f1=${f1.toFixed(2)}Hz at t=50%): ${fMid.toFixed(2)}Hz (Expected geometric mean ${(Math.sqrt(f0 * f1)).toFixed(2)}Hz)`,
);

// 4. Verify 64-Insert Mixer DAG & Cycle Detection
const mixer = createDefaultMixerState(64);
const dagCheck = verifyAcyclicRoutingGraph(mixer);
const cyclicMixer = {
  ...mixer,
  sends: [
    ...mixer.sends,
    {
      sourceInsert: 1,
      targetInsert: 5,
      gainLinear: 0.8,
      preFader: false,
      sidechainOnly: false,
    },
    {
      sourceInsert: 5,
      targetInsert: 1,
      gainLinear: 0.8,
      preFader: false,
      sidechainOnly: false,
    },
  ],
};
const cycleCheck = verifyAcyclicRoutingGraph(cyclicMixer);
console.log("[4] Mixer 64-Insert Graph Verification:", {
  defaultIsAcyclic: dagCheck.isAcyclic,
  nodeCount: dagCheck.topologicalOrder.length,
  feedbackLoopDetected: !cycleCheck.isAcyclic,
  cycleInserts: cycleCheck.cycleInserts,
});

// 5. Verify RBJ Biquad & Stereo Separation
const eqCoeffs = computeRbjBiquadCoefficients(
  {
    enabled: true,
    mode: "peaking",
    frequencyHz: 1000,
    gainDb: 6.0,
    qFactor: 1.0,
  },
  sampleRate,
);
const stereoOut = processStereoSeparationAndPan(0.8, 0.2, -1.0, 0.0); // -1.0 = 100% merged mono
console.log("[5] DSP Primitives Check:", {
  peaking1kHzPlus6dB: eqCoeffs,
  mergedMonoLeftRight: stereoOut,
});

// 6. Generate & Parse Clean-Room .flp Binary Fixture
const flpBytes = buildCleanRoomSampleFlp({
  title: "Ql Studio Clean-Room Demo",
  bpm: 140.0,
  ppq: 96,
  channelNames: ["808 Kick", "Crisp Clap", "Closed Hat", "Sub Bass"],
});
const flpOutPath = join(import.meta.dirname, "..", "demo_project.flp");
writeFileSync(flpOutPath, flpBytes);
const parsedFlp = parseFlpBinary(flpBytes);
console.log("[6] Clean-Room FLP Roundtrip:", {
  flpOutPath,
  byteLength: flpBytes.byteLength,
  header: parsedFlp.header,
  derivedTitle: parsedFlp.derivedTitle,
  derivedBpm: parsedFlp.derivedBpm,
  eventCount: parsedFlp.events.length,
});

// 7. Time-Stretch & Plugin Native GUI Bridge Verification
import { QlNativeEngineClient } from "./tauriBridge.ts";
const client = new QlNativeEngineClient();
const stretchResult = await client.timeStretchAudioClip("clip_vocal_1", "/samples/vocal.wav", 1.5, 7.0, 48000);
console.log("[7] WSOLA Time-Stretch & Pitch Bridge Check:", {
  clipId: stretchResult.clipId,
  stretchRatio: stretchResult.stretchRatio,
  pitchSemitones: stretchResult.pitchSemitones,
  durationSeconds: stretchResult.durationSeconds,
});
