/**
 * QL STUDIO — Clean-Room DAW Engine Data Schemas (TypeScript)
 * Grounded in W3C Web Audio API, MIDI 1.0/2.0, and public FLP specifications.
 */

export type PpqResolution = 96 | 192 | 384;

export interface TimeSignature {
  readonly numerator: number;   // e.g., 4, 3, 5, 7
  readonly denominator: number; // e.g., 4, 8
}

export type GeneratorKind = "sampler_pcm" | "multilayer_pcm" | "oscillator_synth";

export type WaveformShape =
  | "sine"
  | "triangle"
  | "sawtooth"
  | "pulse"
  | "noise"
  | "sampler_pcm";

export interface SampleBufferDescriptor {
  readonly kind: "sampler_pcm";
  readonly assetId: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly lengthFrames: number;
  readonly loopStartFrame: number | null;
  readonly loopEndFrame: number | null;
  readonly interpolation: "linear" | "hermite_cubic" | "sinc_64";
}

export interface MultiLayerZone {
  readonly assetId: string;
  readonly keyLow: number;      // MIDI 0..127
  readonly keyHigh: number;     // MIDI 0..127
  readonly velocityLow: number; // 0..127
  readonly velocityHigh: number;// 0..127
  readonly rootMidiNote: number;// Default 60 (C5 in FL convention)
  readonly fineTuneCents: number;
}

export interface MultiLayerPcmDescriptor {
  readonly kind: "multilayer_pcm";
  readonly zones: readonly MultiLayerZone[];
}

export interface BasicOscillatorDescriptor {
  readonly kind: "oscillator_synth";
  readonly oscillators: readonly {
    readonly waveform: WaveformShape;
    readonly coarseSemitones: number;
    readonly fineCents: number;
    readonly mixLevel: number; // 0.0 .. 1.0
    readonly pulseWidth: number; // 0.05 .. 0.95
  }[];
}

export type ChannelGeneratorConfig =
  | SampleBufferDescriptor
  | MultiLayerPcmDescriptor
  | BasicOscillatorDescriptor;

export interface QlChannel {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly colorHex: `#${string}`;
  readonly generator: ChannelGeneratorConfig;
  readonly pan: number;                // -1.0 (Left) .. 0.0 (Center) .. +1.0 (Right)
  readonly volumeDb: number;           // -Infinity .. +6.0 dB (0.0 dB = unity)
  readonly rootMidiNote: number;       // 0..127 (default 60)
  readonly pitchSemitones: number;     // -48 .. +48
  readonly pitchCents: number;         // -100 .. +100
  readonly swingMultiplier: number;    // 0.0 .. 1.0 per-channel swing scaling
  readonly muted: boolean;
  readonly solo: boolean;
  readonly assignedMixerInsert: number;// 0 = Master, 1..64+ = Insert Track
  readonly sampleSlot?: number;        // 0..31 index in native engine sample bank
  readonly samplePath?: string;        // Loaded .wav file path or starter drum kit asset
}

export interface QlStep {
  readonly active: boolean;
  readonly velocity: number;           // 0..127 (default 100)
  readonly finePan: number;            // -1.0 .. +1.0 (default 0.0)
  readonly pitchOffsetSemitones: number; // -24 .. +24 relative to channel root
  readonly finePitchCents: number;     // -100 .. +100
  readonly gateRatio: number;          // 0.05 .. 4.0 (fraction of 16th-step duration; >1.0 overlaps)
  readonly shiftTicks: number;         // Sub-step micro-timing offset (0 .. PPQ/4 - 1)
}

export interface QlPianoRollNote {
  readonly id: string;
  readonly startTick: number;          // >= 0 in PPQ ticks
  readonly durationTicks: number;      // >= 1 in PPQ ticks
  readonly midiNote: number;           // 0..127
  readonly velocity: number;           // 0..127
  readonly releaseVelocity: number;    // 0..127
  readonly finePan: number;            // -1.0 .. +1.0
  readonly finePitchCents: number;     // -1200 .. +1200
  readonly filterCutoffNorm: number;   // -1.0 .. +1.0 (per-note Mod X)
  readonly filterResonanceNorm: number;// -1.0 .. +1.0 (per-note Mod Y)
  readonly voiceColorGroup: number;    // 0..15 (independent slide/portamento group)
  readonly isSlideNote: boolean;       // FL-style triangle slide icon
  readonly isPortaNote: boolean;       // Per-note portamento transition flag
}

export interface QlChannelPatternData {
  readonly channelId: string;
  readonly steps: readonly QlStep[];   // Length 16, 32, 64, or variable per timeSignature
  readonly notes: readonly QlPianoRollNote[];
}

export interface QlPattern {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly colorHex: `#${string}`;
  readonly timeSignature: TimeSignature;
  readonly stepCount: number;          // Default 16; expandable to 32, 64, or N * numerator
  readonly channelData: Readonly<Record<string, QlChannelPatternData>>;
}

export type BiquadFilterMode =
  | "lowpass"
  | "highpass"
  | "bandpass_csg"
  | "notch"
  | "peaking"
  | "lowshelf"
  | "highshelf";

export interface ParametricEqBand {
  readonly enabled: boolean;
  readonly mode: BiquadFilterMode;
  readonly frequencyHz: number;        // 20 .. 20000 Hz
  readonly gainDb: number;             // -24 .. +24 dB
  readonly qFactor: number;            // 0.1 .. 18.0
}

export type InsertEffectConfig =
  | {
      readonly kind: "parametric_eq";
      readonly bands: readonly ParametricEqBand[];
    }
  | {
      readonly kind: "stereo_delay";
      readonly timeTicksLeft: number;
      readonly timeTicksRight: number;
      readonly feedback: number;       // 0.0 .. 0.98
      readonly lowCutHz: number;
      readonly highCutHz: number;
      readonly pingPong: boolean;
    }
  | {
      readonly kind: "algorithmic_reverb";
      readonly preDelayMs: number;
      readonly decaySeconds: number;
      readonly dampingFreqHz: number;
      readonly roomSize: number;       // 0.0 .. 1.0
      readonly diffusion: number;      // 0.0 .. 1.0
    }
  | {
      readonly kind: "waveshaper_distortion";
      readonly driveDb: number;        // 0.0 .. 36.0 dB
      readonly asymmetry: number;      // -1.0 .. +1.0
      readonly curveExponent: number;  // 0.2 .. 5.0
    };

export interface QlEffectSlot {
  readonly slotIndex: number;          // 0..9 (10 insert slots per mixer track)
  readonly bypassed: boolean;
  readonly wetMix: number;             // 0.0 .. 1.0
  readonly config: InsertEffectConfig;
}

export interface QlMixerSend {
  readonly sourceInsert: number;       // 0..64+
  readonly targetInsert: number;       // 0..64+ (0 = Master)
  readonly gainLinear: number;         // 0.0 .. 2.0 (1.0 = 0 dB)
  readonly preFader: boolean;
  readonly sidechainOnly: boolean;     // Gain 0.0 audio route, active sidechain bus
}

export interface QlMixerInsert {
  readonly index: number;              // 0 = Master, 1..64+ = Insert Tracks
  readonly name: string;
  readonly colorHex: `#${string}`;
  readonly inputGainDb: number;        // -24 .. +24 dB
  readonly faderVolumeDb: number;      // -Infinity .. +5.6 dB
  readonly pan: number;                // -1.0 .. +1.0
  readonly stereoSeparation: number;   // -1.0 (100% Merged Mono) .. 0.0 (Original) .. +1.0 (100% Separated Side)
  readonly polarityInverted: boolean;
  readonly swapLeftRight: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly effectSlots: readonly QlEffectSlot[];
}

export interface QlMixerState {
  readonly masterInsertIndex: 0;
  readonly inserts: readonly QlMixerInsert[]; // Minimum 65 (0 Master + 1..64 Inserts)
  readonly sends: readonly QlMixerSend[];
}

export interface QlProject {
  readonly schemaVersion: "1.0.0";
  readonly title: string;
  readonly author: string;
  readonly bpm: number;                // 10.0 .. 522.0 BPM
  readonly ppq: PpqResolution;         // 96 | 192 | 384
  readonly globalSwingRatio: number;   // 0.50 (straight) .. 0.75 (heavy swing)
  readonly timeSignature: TimeSignature;
  readonly activePatternId: string;
  readonly channels: readonly QlChannel[];
  readonly patterns: readonly QlPattern[];
  readonly mixer: QlMixerState;
  readonly playlist?: QlPlaylistState;
}

export type PlayMode = "pattern" | "song";

export interface QlPlaylistTrack {
  readonly index: number;
  readonly name: string;
  readonly colorHex: `#${string}`;
  readonly heightPx: number;
  readonly muted: boolean;
  readonly solo: boolean;
}

export interface QlPlaylistClip {
  readonly id: string;
  readonly trackIndex: number;
  readonly startTick: number;
  readonly lengthTicks: number;
  readonly offsetTicks?: number;
  readonly kind: "pattern" | "audio" | "automation";
  readonly referenceId: string;
  readonly name: string;
  readonly colorHex: `#${string}`;
  readonly muted?: boolean;
}

export interface QlAutomationPoint {
  readonly tick: number;
  readonly value: number; // 0.0 .. 1.0
  readonly tension: number; // -1.0 .. +1.0
}

export interface QlAutomationClip {
  readonly id: string;
  readonly name: string;
  readonly targetType:
    | "channel_volume"
    | "channel_pan"
    | "channel_cutoff"
    | "mixer_fader"
    | "mixer_pan"
    | "plugin_param";
  readonly targetId: string;
  readonly targetParamIndex?: number;
  readonly points: readonly QlAutomationPoint[];
  readonly lengthTicks: number;
  readonly colorHex: `#${string}`;
}

export interface QlPlaylistState {
  readonly tracks: readonly QlPlaylistTrack[];
  readonly clips: readonly QlPlaylistClip[];
  readonly automationClips: readonly QlAutomationClip[];
  readonly loopStartTick?: number | null;
  readonly loopEndTick?: number | null;
  readonly playMode: PlayMode;
}

export interface PluginParamInfo {
  readonly id: number;
  readonly name: string;
  readonly value: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly defaultValue: number;
}

export interface PluginDescriptor {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly vendor: string;
  readonly version: string;
  readonly format: "vst3" | "clap" | "builtin";
  readonly category: "instrument" | "effect" | "analyzer";
  readonly audioInputs: number;
  readonly audioOutputs: number;
  readonly hasEditor: boolean;
  readonly parameters: readonly PluginParamInfo[];
}

export interface PluginInstanceSummary {
  readonly instanceId: string;
  readonly descriptor: PluginDescriptor;
  readonly targetKind: "mixer_slot" | "channel";
  readonly targetIndex: number;
  readonly slotIndex?: number;
  readonly parameters: readonly PluginParamInfo[];
  readonly active: boolean;
}

export interface AudioInputDeviceInfo {
  readonly name: string;
  readonly isDefault: boolean;
}

export interface RecordedAudioSummary {
  readonly filePath: string;
  readonly fileName: string;
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly startTick: number;
  readonly trackIndex: number;
}

export type MidiControllerProfile = "generic" | "akai_fire" | "novation_launchkey";

export interface MidiDeviceInfo {
  readonly index: number;
  readonly name: string;
  readonly isConnected: boolean;
}

export interface MidiStatusSnapshot {
  readonly connectedDevice: string | null;
  readonly activeProfile: MidiControllerProfile;
  readonly lastActivityTimestampMs: number;
  readonly lastNotePlayed: number | null;
}
