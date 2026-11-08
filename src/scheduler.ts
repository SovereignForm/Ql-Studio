/**
 * QL STUDIO — High-Precision Lookahead Audio Clock & Zero-Jitter Scheduler
 *
 * Implements:
 * 1. Exact PPQ (96 / 192 / 384) tick-to-seconds and tick-to-sample-frame conversion
 * 2. FL-style Groove/Swing offset math (50% straight -> 75% heavy swing on odd 16th steps)
 * 3. Exponential Pitch Glide / Slide Note math: f(t) = f0 * (f1 / f0)^(t / t_slide)
 * 4. Hybrid Lookahead Scheduler (25-50 ms window) + SPSC Audio Event Queue
 */

import type {
  PpqResolution,
  QlChannel,
  QlPattern,
  QlPianoRollNote,
} from "./schemas.ts";

export interface TimingMetrics {
  readonly bpm: number;
  readonly ppq: PpqResolution;
  readonly sampleRate: number;
  readonly secondsPerBeat: number;
  readonly secondsPerTick: number;
  readonly samplesPerTick: number;
  readonly ticksPerSixteenth: number;
}

/**
 * Computes exact musical timing constants from BPM, PPQ, and hardware sample rate.
 *
 * Seconds Per Beat = 60 / BPM
 * Seconds Per Tick = Seconds Per Beat / PPQ
 */
export function computeTimingMetrics(
  bpm: number,
  ppq: PpqResolution,
  sampleRate: number,
): TimingMetrics {
  if (bpm <= 0 || !Number.isFinite(bpm)) {
    throw new RangeError(`Invalid BPM: ${bpm}`);
  }
  const secondsPerBeat = 60.0 / bpm;
  const secondsPerTick = secondsPerBeat / ppq;
  const samplesPerTick = secondsPerTick * sampleRate;
  const ticksPerSixteenth = ppq / 4;

  return {
    bpm,
    ppq,
    sampleRate,
    secondsPerBeat,
    secondsPerTick,
    samplesPerTick,
    ticksPerSixteenth,
  };
}

/**
 * Converts MIDI note number (0..127) + fine pitch cents into fundamental frequency (Hz).
 * Standard A4 = MIDI 69 = 440.0 Hz.
 */
export function midiNoteToFrequencyHz(
  midiNote: number,
  fineCents: number = 0,
): number {
  const totalSemitones = midiNote - 69 + fineCents / 100.0;
  return 440.0 * Math.pow(2.0, totalSemitones / 12.0);
}

/**
 * Evaluates FL Studio's signature Slide Note / Portamento pitch glide at elapsed time `t`:
 *
 *   f(t) = f0 * (f1 / f0)^(t / t_slide)
 *
 * In log-frequency (pitch) space, this is linear in octaves/semitones and exponential in Hz.
 */
export function evaluateSlideFrequencyHz(
  f0Hz: number,
  f1Hz: number,
  elapsedTimeSec: number,
  slideDurationSec: number,
): number {
  if (f0Hz <= 0 || f1Hz <= 0) {
    throw new RangeError("Fundamental frequencies f0 and f1 must be > 0 Hz");
  }
  if (slideDurationSec <= 0 || elapsedTimeSec >= slideDurationSec) {
    return f1Hz;
  }
  if (elapsedTimeSec <= 0) {
    return f0Hz;
  }
  const normalizedProgress = elapsedTimeSec / slideDurationSec;
  return f0Hz * Math.pow(f1Hz / f0Hz, normalizedProgress);
}

/**
 * Computes the swung tick position for a 16th-note step index (0-based).
 *
 * - Even 16th steps (0, 2, 4, ...) remain anchored on the grid.
 * - Odd 16th steps (1, 3, 5, ...) are delayed proportionally as `globalSwingRatio`
 *   moves from 0.50 (straight 50/50 eighth split) to 0.75 (heavy 75/25 triplet/dotted feel).
 *
 * Formula for odd step `s = 2k + 1`:
 *   Base Tick = s * (PPQ / 4)
 *   Pair Duration = 2 * (PPQ / 4) = PPQ / 2
 *   Swing Delay Ticks = ((globalSwingRatio - 0.50) * (PPQ / 2)) * channelSwingMultiplier
 */
export function computeSwungStepTick(
  stepIndex: number,
  ppq: PpqResolution,
  globalSwingRatio: number,
  channelSwingMultiplier: number = 1.0,
  microShiftTicks: number = 0,
): number {
  const clampedSwing = Math.min(0.75, Math.max(0.5, globalSwingRatio));
  const clampedChannelMult = Math.min(1.0, Math.max(0.0, channelSwingMultiplier));
  const ticksPerStep = ppq / 4;
  const baseTick = stepIndex * ticksPerStep;

  if (stepIndex % 2 === 0) {
    return baseTick + microShiftTicks;
  }

  const eighthNoteTicks = ticksPerStep * 2;
  const rawSwingOffset = (clampedSwing - 0.5) * eighthNoteTicks;
  const swungOffsetTicks = Math.round(rawSwingOffset * clampedChannelMult);
  return baseTick + swungOffsetTicks + microShiftTicks;
}

export type ScheduledEventType = "note_on" | "note_off" | "pitch_slide";

export interface ScheduledAudioEvent {
  readonly eventType: ScheduledEventType;
  readonly channelId: string;
  readonly channelIndex: number;
  readonly voiceColorGroup: number;
  readonly patternTick: number;
  readonly audioContextTimeSec: number;
  readonly sampleFrame: number;
  readonly durationSeconds: number;
  readonly durationFrames: number;
  readonly midiNote: number;
  readonly frequencyHz: number;
  readonly targetSlideFrequencyHz: number | null;
  readonly velocityNormalized: number; // 0.0 .. 1.0
  readonly pan: number;                // -1.0 .. +1.0
}

export interface LookaheadSchedulerConfig {
  readonly bpm: number;
  readonly ppq: PpqResolution;
  readonly sampleRate: number;
  readonly globalSwingRatio: number;   // 0.50 .. 0.75
  readonly lookaheadWindowSec: number; // 0.025 .. 0.050 (25ms - 50ms)
  readonly timerIntervalMs: number;    // e.g. 10ms UI/worker wakeup cadence
}

/**
 * Fixed-capacity Single-Producer Single-Consumer (SPSC) Ring Buffer
 * for transferring sample-accurate scheduled events to the AudioWorklet / DSP thread.
 */
export class AudioEventRingBuffer {
  private readonly buffer: (ScheduledAudioEvent | undefined)[];
  private readonly capacity: number;
  private writePos = 0;
  private readPos = 0;

  constructor(capacityPowerOfTwo: number = 1024) {
    if ((capacityPowerOfTwo & (capacityPowerOfTwo - 1)) !== 0) {
      throw new RangeError("Ring buffer capacity must be a power of 2");
    }
    this.capacity = capacityPowerOfTwo;
    this.buffer = new Array<ScheduledAudioEvent | undefined>(capacityPowerOfTwo);
  }

  public enqueue(event: ScheduledAudioEvent): boolean {
    if (this.writePos - this.readPos >= this.capacity) {
      return false; // Buffer full
    }
    const mask = this.capacity - 1;
    this.buffer[this.writePos & mask] = event;
    this.writePos++;
    return true;
  }

  public dequeueUpToFrame(maxSampleFrame: number): ScheduledAudioEvent[] {
    const ready: ScheduledAudioEvent[] = [];
    const mask = this.capacity - 1;
    while (this.readPos < this.writePos) {
      const slot = this.readPos & mask;
      const ev = this.buffer[slot];
      if (!ev || ev.sampleFrame > maxSampleFrame) {
        break;
      }
      ready.push(ev);
      this.buffer[slot] = undefined;
      this.readPos++;
    }
    return ready;
  }

  public get pendingCount(): number {
    return this.writePos - this.readPos;
  }
}

/**
 * Sample-accurate Lookahead Audio Scheduler.
 * Runs ahead of the hardware audio clock by `lookaheadWindowSec` (25–50 ms),
 * resolving Step Sequencer steps (with Swing), Piano Roll notes, and Slide Notes
 * into exact sample frames.
 */
export class QlLookaheadScheduler {
  private config: LookaheadSchedulerConfig;
  private metrics: TimingMetrics;
  private nextUnscheduledTick = 0;
  private transportStartAudioTimeSec = 0;
  private isPlaying = false;
  public readonly eventQueue: AudioEventRingBuffer;

  constructor(config: LookaheadSchedulerConfig, queueCapacity = 2048) {
    this.config = config;
    this.metrics = computeTimingMetrics(
      config.bpm,
      config.ppq,
      config.sampleRate,
    );
    this.eventQueue = new AudioEventRingBuffer(queueCapacity);
  }

  public start(currentAudioContextTimeSec: number): void {
    this.transportStartAudioTimeSec = currentAudioContextTimeSec;
    this.nextUnscheduledTick = 0;
    this.isPlaying = true;
  }

  public stop(): void {
    this.isPlaying = false;
  }

  public updateBpm(newBpm: number): void {
    this.config = { ...this.config, bpm: newBpm };
    this.metrics = computeTimingMetrics(
      this.config.bpm,
      this.config.ppq,
      this.config.sampleRate,
    );
  }

  /**
   * Advances the lookahead horizon up to `currentAudioTimeSec + lookaheadWindowSec`.
   * Immune to UI/timer jitter as long as wakeup interval < lookaheadWindowSec.
   */
  public advanceLookahead(
    currentAudioTimeSec: number,
    pattern: QlPattern,
    channels: readonly QlChannel[],
  ): ScheduledAudioEvent[] {
    if (!this.isPlaying) {
      return [];
    }

    const horizonTimeSec = currentAudioTimeSec + this.config.lookaheadWindowSec;
    const patternLengthTicks = pattern.stepCount * this.metrics.ticksPerSixteenth;
    const newlyScheduled: ScheduledAudioEvent[] = [];

    while (true) {
      const tickAudioTimeSec =
        this.transportStartAudioTimeSec +
        this.nextUnscheduledTick * this.metrics.secondsPerTick;

      if (tickAudioTimeSec > horizonTimeSec) {
        break;
      }

      const localPatternTick = this.nextUnscheduledTick % patternLengthTicks;
      const cycleBaseTick = this.nextUnscheduledTick - localPatternTick;

      const tickEvents = this.collectEventsAtPatternTick(
        localPatternTick,
        cycleBaseTick,
        pattern,
        channels,
      );

      for (const ev of tickEvents) {
        this.eventQueue.enqueue(ev);
        newlyScheduled.push(ev);
      }

      this.nextUnscheduledTick++;
    }

    return newlyScheduled;
  }

  private collectEventsAtPatternTick(
    localPatternTick: number,
    cycleBaseTick: number,
    pattern: QlPattern,
    channels: readonly QlChannel[],
  ): ScheduledAudioEvent[] {
    const events: ScheduledAudioEvent[] = [];
    const anySolo = channels.some((ch) => ch.solo);

    for (const channel of channels) {
      const audible = anySolo ? channel.solo : !channel.muted;
      if (!audible) continue;

      const chData = pattern.channelData[channel.id];
      if (!chData) continue;

      // 1. Step Sequencer Events (with FL Groove/Swing offset)
      for (let stepIdx = 0; stepIdx < chData.steps.length; stepIdx++) {
        const step = chData.steps[stepIdx];
        if (!step || !step.active) continue;

        const swungTick = computeSwungStepTick(
          stepIdx,
          this.config.ppq,
          this.config.globalSwingRatio,
          channel.swingMultiplier,
          step.shiftTicks,
        );

        if (swungTick === localPatternTick) {
          const absoluteTick = cycleBaseTick + swungTick;
          const eventTimeSec =
            this.transportStartAudioTimeSec +
            absoluteTick * this.metrics.secondsPerTick;
          const sampleFrame = Math.round(
            eventTimeSec * this.config.sampleRate,
          );
          const durationTicks = Math.max(
            1,
            Math.round(this.metrics.ticksPerSixteenth * step.gateRatio),
          );
          const durationSec = durationTicks * this.metrics.secondsPerTick;
          const durationFrames = Math.round(
            durationSec * this.config.sampleRate,
          );

          const midiNote =
            channel.rootMidiNote +
            channel.pitchSemitones +
            step.pitchOffsetSemitones;
          const totalCents = channel.pitchCents + step.finePitchCents;

          events.push({
            eventType: "note_on",
            channelId: channel.id,
            channelIndex: channel.index,
            voiceColorGroup: 0,
            patternTick: localPatternTick,
            audioContextTimeSec: eventTimeSec,
            sampleFrame,
            durationSeconds: durationSec,
            durationFrames,
            midiNote,
            frequencyHz: midiNoteToFrequencyHz(midiNote, totalCents),
            targetSlideFrequencyHz: null,
            velocityNormalized: Math.min(1, Math.max(0, step.velocity / 127)),
            pan: Math.min(1, Math.max(-1, channel.pan + step.finePan)),
          });
        }
      }

      // 2. Piano Roll Normal & Slide Notes
      for (const note of chData.notes) {
        if (note.startTick !== localPatternTick) continue;

        const absoluteTick = cycleBaseTick + note.startTick;
        const eventTimeSec =
          this.transportStartAudioTimeSec +
          absoluteTick * this.metrics.secondsPerTick;
        const sampleFrame = Math.round(eventTimeSec * this.config.sampleRate);
        const durationSec = note.durationTicks * this.metrics.secondsPerTick;
        const durationFrames = Math.round(durationSec * this.config.sampleRate);
        const totalCents = channel.pitchCents + note.finePitchCents;
        const noteFreqHz = midiNoteToFrequencyHz(note.midiNote, totalCents);

        if (note.isSlideNote) {
          // Find active carrier note in the same voice color group
          const carrier = chData.notes.find(
            (n) =>
              !n.isSlideNote &&
              n.voiceColorGroup === note.voiceColorGroup &&
              n.startTick <= note.startTick &&
              n.startTick + n.durationTicks > note.startTick,
          );
          const startFreqHz = carrier
            ? midiNoteToFrequencyHz(
                carrier.midiNote,
                channel.pitchCents + carrier.finePitchCents,
              )
            : noteFreqHz;

          events.push({
            eventType: "pitch_slide",
            channelId: channel.id,
            channelIndex: channel.index,
            voiceColorGroup: note.voiceColorGroup,
            patternTick: localPatternTick,
            audioContextTimeSec: eventTimeSec,
            sampleFrame,
            durationSeconds: durationSec,
            durationFrames,
            midiNote: note.midiNote,
            frequencyHz: startFreqHz,
            targetSlideFrequencyHz: noteFreqHz,
            velocityNormalized: Math.min(1, Math.max(0, note.velocity / 127)),
            pan: Math.min(1, Math.max(-1, channel.pan + note.finePan)),
          });
        } else {
          events.push({
            eventType: "note_on",
            channelId: channel.id,
            channelIndex: channel.index,
            voiceColorGroup: note.voiceColorGroup,
            patternTick: localPatternTick,
            audioContextTimeSec: eventTimeSec,
            sampleFrame,
            durationSeconds: durationSec,
            durationFrames,
            midiNote: note.midiNote,
            frequencyHz: noteFreqHz,
            targetSlideFrequencyHz: null,
            velocityNormalized: Math.min(1, Math.max(0, note.velocity / 127)),
            pan: Math.min(1, Math.max(-1, channel.pan + note.finePan)),
          });
        }
      }
    }

    return events;
  }
}
