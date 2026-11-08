/**
 * QL STUDIO — TypeScript to Tauri v2 Native Core IPC Bridge
 *
 * Connects the Ql Studio TypeScript domain schemas (`QlPattern`, `QlChannel`, `QlMixerState`)
 * to the native Rust audio engine (`src-tauri/src/commands.rs`) via `@tauri-apps/api/core`,
 * `@tauri-apps/api/window`, and `@tauri-apps/plugin-dialog`.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AudioInputDeviceInfo,
  BiquadFilterMode,
  MidiControllerProfile,
  MidiDeviceInfo,
  MidiStatusSnapshot,
  ParametricEqBand,
  PlayMode,
  PluginDescriptor,
  PluginInstanceSummary,
  QlChannel,
  QlMixerSend,
  QlMixerState,
  QlPattern,
  QlPlaylistState,
  RecordedAudioSummary,
  TimeStretchResult,
  WaveformShape,
} from "./schemas.ts";

export interface NativeEngineStatusSnapshot {
  readonly isPlaying: boolean;
  readonly bpm: number;
  readonly ppq: 96 | 192 | 384;
  readonly swingRatio: number;
  readonly sampleRate: number;
  readonly bufferSizeFrames: number;
  readonly nextUnscheduledTick: number;
  readonly audioStreamActive: boolean;
  readonly playMode?: PlayMode;
  readonly songTick?: number;
}

export interface AudioSettingsSnapshot {
  readonly deviceName: string;
  readonly sampleRate: number;
  readonly bufferSizeFrames: number;
  readonly availableBufferSizes: readonly number[];
  readonly streamActive: boolean;
}

export interface LoadedSampleSummary {
  readonly slotIndex: number;
  readonly name: string;
  readonly sourcePath: string;
  readonly originalSampleRate: number;
  readonly engineSampleRate: number;
  readonly channels: number;
  readonly durationSeconds: number;
  readonly frameCount: number;
}

export interface NativeDagVerificationReport {
  readonly isAcyclic: boolean;
  readonly topologicalOrder: readonly number[];
  readonly cycleInserts: readonly number[];
}

export interface NativeChannelPayload {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly colorHex: string;
  readonly waveform: WaveformShape;
  readonly sampleSlot?: number;
  readonly pan: number;
  readonly volumeDb: number;
  readonly rootMidiNote: number;
  readonly pitchSemitones: number;
  readonly pitchCents: number;
  readonly swingMultiplier: number;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly assignedMixerInsert: number;
}

export interface NativeImportedChannelMeta {
  readonly channelId: string;
  readonly samplePath: string | null;
  readonly generatorName: string | null;
  readonly loopEnabled: boolean;
}

export interface QlProjectPayload {
  readonly sourcePath: string;
  readonly title: string;
  readonly author: string;
  readonly flpVersion: string;
  readonly formatType: number;
  readonly bpm: number;
  readonly ppq: 96 | 192 | 384;
  readonly globalSwingRatio: number;
  readonly activePatternId: string;
  readonly channels: readonly NativeChannelPayload[];
  readonly channelMeta: Readonly<Record<string, NativeImportedChannelMeta>>;
  readonly patterns: readonly QlPattern[];
  readonly rawEventCount: number;
}

export interface NativeMixerInsertPayload {
  readonly index: number;
  readonly name: string;
  readonly inputGainDb: number;
  readonly faderVolumeDb: number;
  readonly pan: number;
  readonly stereoSeparation: number;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly eqBand: ParametricEqBand;
}

export interface NativeMixerStatePayload {
  readonly masterInsertIndex: number;
  readonly inserts: readonly NativeMixerInsertPayload[];
  readonly sends: readonly QlMixerSend[];
}

export function toNativeChannelPayload(channel: QlChannel): NativeChannelPayload {
  let waveform: WaveformShape = "sawtooth";
  if (channel.generator.kind === "sampler_pcm") {
    waveform = "sampler_pcm";
  } else if (
    channel.generator.kind === "oscillator_synth" &&
    channel.generator.oscillators.length > 0
  ) {
    waveform = channel.generator.oscillators[0]!.waveform;
  }

  return {
    id: channel.id,
    index: channel.index,
    name: channel.name,
    colorHex: channel.colorHex,
    waveform,
    sampleSlot: channel.sampleSlot,
    pan: channel.pan,
    volumeDb: channel.volumeDb,
    rootMidiNote: channel.rootMidiNote,
    pitchSemitones: channel.pitchSemitones,
    pitchCents: channel.pitchCents,
    swingMultiplier: channel.swingMultiplier,
    muted: channel.muted,
    solo: channel.solo,
    assignedMixerInsert: channel.assignedMixerInsert,
  };
}

export function fromNativeChannelPayload(payload: NativeChannelPayload): QlChannel {
  const isSampler = payload.waveform === "sampler_pcm" || payload.sampleSlot !== undefined;
  return {
    id: payload.id,
    index: payload.index,
    name: payload.name,
    colorHex: (payload.colorHex.startsWith("#")
      ? payload.colorHex
      : `#${payload.colorHex}`) as `#${string}`,
    generator: isSampler
      ? {
          kind: "sampler_pcm",
          assetId: `slot_${payload.sampleSlot ?? 0}`,
          sampleRate: 48000,
          channels: 2,
          lengthFrames: 24000,
          loopStartFrame: null,
          loopEndFrame: null,
          interpolation: "hermite_cubic",
        }
      : {
          kind: "oscillator_synth",
          oscillators: [
            {
              waveform: payload.waveform,
              coarseSemitones: 0,
              fineCents: 0,
              mixLevel: 1.0,
              pulseWidth: 0.5,
            },
          ],
        },
    pan: payload.pan,
    volumeDb: payload.volumeDb,
    rootMidiNote: payload.rootMidiNote,
    pitchSemitones: payload.pitchSemitones,
    pitchCents: payload.pitchCents,
    swingMultiplier: payload.swingMultiplier,
    muted: payload.muted,
    solo: payload.solo,
    assignedMixerInsert: payload.assignedMixerInsert,
    sampleSlot: payload.sampleSlot,
  };
}

export function toNativeMixerStatePayload(
  mixer: QlMixerState,
): NativeMixerStatePayload {
  const defaultEqBand: ParametricEqBand = {
    enabled: false,
    mode: "peaking" as BiquadFilterMode,
    frequencyHz: 1000,
    gainDb: 0,
    qFactor: 1.0,
  };

  return {
    masterInsertIndex: mixer.masterInsertIndex,
    sends: mixer.sends,
    inserts: mixer.inserts.map((ins) => {
      const eqSlot = ins.effectSlots.find(
        (slot) => !slot.bypassed && slot.config.kind === "parametric_eq",
      );
      const firstBand =
        eqSlot && eqSlot.config.kind === "parametric_eq"
          ? (eqSlot.config.bands[0] ?? defaultEqBand)
          : defaultEqBand;

      return {
        index: ins.index,
        name: ins.name,
        inputGainDb: ins.inputGainDb,
        faderVolumeDb: ins.faderVolumeDb,
        pan: ins.pan,
        stereoSeparation: ins.stereoSeparation,
        muted: ins.muted,
        solo: ins.solo,
        eqBand: firstBand,
      };
    }),
  };
}

/**
 * Type-safe client for controlling the Tauri v2 + Rust Real-Time Audio Engine,
 * with automatic WebAudio fallback when previewed outside the Tauri desktop container.
 */
export class QlNativeEngineClient {
  private fallbackStatus: NativeEngineStatusSnapshot = {
    isPlaying: false,
    bpm: 140.0,
    ppq: 96,
    swingRatio: 0.5,
    sampleRate: 48000,
    bufferSizeFrames: 1024,
    nextUnscheduledTick: 0,
    audioStreamActive: true,
  };

  private fallbackAudioSettings: AudioSettingsSnapshot = {
    deviceName: "PipeWire / ALSA Studio Output (Fixed Buffer)",
    sampleRate: 48000,
    bufferSizeFrames: 1024,
    availableBufferSizes: [256, 512, 1024, 2048],
    streamActive: true,
  };

  private webAudioCtx: AudioContext | null = null;
  private webAudioTimer: number | null = null;
  private webAudioPattern: QlPattern | null = null;
  private webAudioChannels: readonly QlChannel[] = [];
  private webAudioStepIndex = 0;

  public get isNativeRuntime(): boolean {
    return typeof window !== "undefined" && isTauri();
  }

  private ensureWebAudioFallback(): void {
    if (this.isNativeRuntime || typeof window === "undefined") return;
    if (!this.webAudioCtx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        this.webAudioCtx = new Ctx({ latencyHint: "interactive" });
      }
    }
    if (this.webAudioCtx && this.webAudioCtx.state === "suspended") {
      void this.webAudioCtx.resume();
    }
  }

  private triggerWebAudioStep(stepIdx: number): void {
    const ctx = this.webAudioCtx;
    const pat = this.webAudioPattern;
    if (!ctx || !pat) return;

    const anySolo = this.webAudioChannels.some((c) => c.solo);
    const stepDurSec = 60 / this.fallbackStatus.bpm / 4;
    const now = ctx.currentTime + 0.015;

    for (const ch of this.webAudioChannels) {
      if (ch.muted || (anySolo && !ch.solo)) continue;
      const chData = pat.channelData[ch.id];
      const step = chData?.steps[stepIdx];
      if (!step || !step.active) continue;

      const velGain = Math.pow(step.velocity / 127, 1.5) * Math.pow(10, ch.volumeDb / 20) * 0.25;
      const gainNode = ctx.createGain();
      const panNode = ctx.createStereoPanner();
      panNode.pan.setValueAtTime(Math.max(-1, Math.min(1, ch.pan + step.finePan)), now);
      gainNode.connect(panNode);
      panNode.connect(ctx.destination);

      const midi = ch.rootMidiNote + ch.pitchSemitones + step.pitchOffsetSemitones;
      const freq = 440 * Math.pow(2, (midi - 69) / 12);

      if (ch.sampleSlot === 0 || ch.name.toLowerCase().includes("kick")) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(155, now);
        osc.frequency.exponentialRampToValueAtTime(46, now + 0.08);
        gainNode.gain.setValueAtTime(velGain * 1.4, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gainNode);
        osc.start(now);
        osc.stop(now + 0.36);
      } else if (
        ch.sampleSlot === 1 ||
        ch.sampleSlot === 2 ||
        ch.sampleSlot === 3 ||
        ch.name.toLowerCase().includes("clap") ||
        ch.name.toLowerCase().includes("hat") ||
        ch.name.toLowerCase().includes("snare")
      ) {
        const dur = ch.sampleSlot === 2 || ch.name.toLowerCase().includes("hat") ? 0.065 : 0.19;
        const bufLen = Math.max(256, Math.floor(ctx.sampleRate * dur));
        const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufLen * 0.28));
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = ch.sampleSlot === 2 ? "highpass" : "bandpass";
        filter.frequency.setValueAtTime(ch.sampleSlot === 2 ? 6500 : 1800, now);
        gainNode.gain.setValueAtTime(velGain, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + dur);
        src.connect(filter);
        filter.connect(gainNode);
        src.start(now);
      } else {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freq, now);
        gainNode.gain.setValueAtTime(0.001, now);
        gainNode.gain.linearRampToValueAtTime(velGain * 0.7, now + 0.008);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + Math.max(0.08, stepDurSec * step.gateRatio));
        osc.connect(gainNode);
        osc.start(now);
        osc.stop(now + Math.max(0.09, stepDurSec * step.gateRatio + 0.01));
      }
    }
  }

  private startWebAudioLoop(): void {
    this.stopWebAudioLoop();
    this.ensureWebAudioFallback();
    const tickIntervalMs = () => (60 / this.fallbackStatus.bpm / 4) * 1000;
    const stepFn = () => {
      if (!this.fallbackStatus.isPlaying) return;
      this.triggerWebAudioStep(this.webAudioStepIndex % 16);
      this.webAudioStepIndex = (this.webAudioStepIndex + 1) % 16;
      this.webAudioTimer = window.setTimeout(stepFn, tickIntervalMs());
    };
    stepFn();
  }

  private stopWebAudioLoop(): void {
    if (this.webAudioTimer !== null) {
      clearTimeout(this.webAudioTimer);
      this.webAudioTimer = null;
    }
  }

  public async play(): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackStatus = { ...this.fallbackStatus, isPlaying: true };
      this.startWebAudioLoop();
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("play");
  }

  public async pause(): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackStatus = { ...this.fallbackStatus, isPlaying: false };
      this.stopWebAudioLoop();
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("pause");
  }

  public async stop(): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackStatus = {
        ...this.fallbackStatus,
        isPlaying: false,
        nextUnscheduledTick: 0,
      };
      this.webAudioStepIndex = 0;
      this.stopWebAudioLoop();
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("stop");
  }

  public async setBpm(bpm: number): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackStatus = { ...this.fallbackStatus, bpm };
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("set_bpm", { bpm });
  }

  public async setSwing(swingRatio: number): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackStatus = { ...this.fallbackStatus, swingRatio };
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("set_swing", { swingRatio });
  }

  public async updatePattern(
    pattern: QlPattern,
    channels: readonly QlChannel[],
  ): Promise<NativeEngineStatusSnapshot> {
    this.webAudioPattern = pattern;
    this.webAudioChannels = channels;
    if (!this.isNativeRuntime) {
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("update_pattern", {
      pattern,
      channels: channels.map(toNativeChannelPayload),
    });
  }

  public async updateMixerGraph(
    mixer: QlMixerState,
  ): Promise<NativeDagVerificationReport> {
    if (!this.isNativeRuntime) {
      return {
        isAcyclic: true,
        topologicalOrder: mixer.inserts.map((i) => i.index),
        cycleInserts: [],
      };
    }
    return invoke<NativeDagVerificationReport>("update_mixer_graph", {
      mixer: toNativeMixerStatePayload(mixer),
    });
  }

  public async getEngineStatus(): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("get_engine_status");
  }

  public async setPlayMode(mode: PlayMode): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackStatus = { ...this.fallbackStatus, playMode: mode };
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("set_play_mode", { mode });
  }

  public async updateArrangement(
    playlist: QlPlaylistState,
    patterns: readonly QlPattern[],
  ): Promise<NativeEngineStatusSnapshot> {
    if (!this.isNativeRuntime) {
      return this.fallbackStatus;
    }
    return invoke<NativeEngineStatusSnapshot>("update_arrangement", {
      playlist,
      patterns,
    });
  }

  public async scanPlugins(customPaths: string[] = []): Promise<PluginDescriptor[]> {
    if (!this.isNativeRuntime) {
      return [];
    }
    return invoke<PluginDescriptor[]>("scan_plugins", { customPaths });
  }

  public async getAvailablePlugins(): Promise<PluginDescriptor[]> {
    if (!this.isNativeRuntime) {
      return [];
    }
    return invoke<PluginDescriptor[]>("get_available_plugins");
  }

  public async loadPlugin(
    pluginId: string,
    targetKind: "mixer_slot" | "channel",
    targetIndex: number,
    slotIndex?: number,
  ): Promise<PluginInstanceSummary> {
    if (!this.isNativeRuntime) {
      return {
        instanceId: `mock_${Date.now()}`,
        descriptor: {
          id: pluginId,
          path: "",
          name: pluginId,
          vendor: "Studio",
          version: "1.0",
          format: "vst3",
          category: "effect",
          audioInputs: 2,
          audioOutputs: 2,
          hasEditor: true,
          parameters: [],
        },
        targetKind,
        targetIndex,
        slotIndex,
        parameters: [],
        active: true,
      };
    }
    return invoke<PluginInstanceSummary>("load_plugin", {
      pluginId,
      targetKind,
      targetIndex,
      slotIndex,
    });
  }

  public async setPluginParameter(
    instanceId: string,
    paramId: number,
    value: number,
  ): Promise<void> {
    if (!this.isNativeRuntime) return;
    return invoke<void>("set_plugin_parameter", {
      instanceId,
      paramId,
      value,
    });
  }

  public async unloadPlugin(instanceId: string): Promise<void> {
    if (!this.isNativeRuntime) return;
    return invoke<void>("unload_plugin", { instanceId });
  }

  public async getLoadedPlugins(): Promise<PluginInstanceSummary[]> {
    if (!this.isNativeRuntime) return [];
    return invoke<PluginInstanceSummary[]>("get_loaded_plugins");
  }

  public async getAudioSettings(): Promise<AudioSettingsSnapshot> {
    if (!this.isNativeRuntime) {
      return this.fallbackAudioSettings;
    }
    return invoke<AudioSettingsSnapshot>("get_audio_settings");
  }

  public async setAudioBufferSize(
    bufferSizeFrames: number,
  ): Promise<AudioSettingsSnapshot> {
    if (!this.isNativeRuntime) {
      this.fallbackAudioSettings = {
        ...this.fallbackAudioSettings,
        bufferSizeFrames,
      };
      this.fallbackStatus = {
        ...this.fallbackStatus,
        bufferSizeFrames,
      };
      return this.fallbackAudioSettings;
    }
    return invoke<AudioSettingsSnapshot>("set_audio_buffer_size", {
      bufferSize: bufferSizeFrames,
      bufferSizeFrames,
    });
  }

  public async loadSampleFile(
    channelId: string,
    path: string,
  ): Promise<LoadedSampleSummary> {
    if (!this.isNativeRuntime) {
      const name = path.split(/[\\/]/).pop()?.replace(/\.wav$/i, "") ?? "Sample";
      return {
        slotIndex: 4,
        name,
        sourcePath: path,
        originalSampleRate: 48000,
        engineSampleRate: 48000,
        channels: 2,
        durationSeconds: 0.45,
        frameCount: 21600,
      };
    }
    return invoke<LoadedSampleSummary>("load_sample_file", {
      channelId,
      path,
    });
  }

  public async openAndLoadWavDialog(
    channelId: string,
  ): Promise<LoadedSampleSummary | null> {
    if (!this.isNativeRuntime) {
      return null;
    }
    const selected = await open({
      multiple: false,
      title: "Load Audio Sample (.wav)",
      filters: [
        {
          name: "WAV Audio Sample",
          extensions: ["wav", "WAV"],
        },
      ],
    });
    if (!selected || typeof selected !== "string") {
      return null;
    }
    return this.loadSampleFile(channelId, selected);
  }

  public async exportWavDialog(bars = 2): Promise<string | null> {
    if (!this.isNativeRuntime) {
      return "/tmp/ql_studio_master_export.wav (Browser Preview)";
    }
    const dest = await save({
      title: "Export Pattern Mixdown as WAV",
      defaultPath: "ql_studio_mixdown.wav",
      filters: [
        {
          name: "WAV Audio (16-bit PCM Stereo)",
          extensions: ["wav"],
        },
      ],
    });
    if (!dest) return null;
    return invoke<string>("export_wav_file", { path: dest, bars });
  }

  public async importFlpFile(path: string): Promise<QlProjectPayload> {
    return invoke<QlProjectPayload>("import_flp_file", { path });
  }

  public async openAndImportFlpDialog(): Promise<QlProjectPayload | null> {
    if (this.isNativeRuntime) {
      const selected = await open({
        multiple: false,
        title: "Open Audio Project (.flp)",
        filters: [
          {
            name: "Supported Audio Project",
            extensions: ["flp"],
          },
        ],
      });
      if (!selected || typeof selected !== "string") {
        return null;
      }
      return this.importFlpFile(selected);
    }
    return null;
  }

  public async toggleFullscreen(): Promise<boolean> {
    if (this.isNativeRuntime) {
      try {
        return await invoke<boolean>("toggle_fullscreen");
      } catch (err) {
        console.warn("Native toggle_fullscreen invoke failed, falling back to window API", err);
        const win = getCurrentWindow();
        const current = await win.isFullscreen();
        await win.setFullscreen(!current);
        return !current;
      }
    }
    if (typeof document !== "undefined") {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => {});
        return true;
      } else {
        await document.exitFullscreen().catch(() => {});
        return false;
      }
    }
    return false;
  }

  public async toggleMaximize(): Promise<void> {
    if (this.isNativeRuntime) {
      try {
        await invoke<boolean>("toggle_maximize");
        return;
      } catch (err) {
        console.warn("Native toggle_maximize invoke failed, falling back to window API", err);
        const win = getCurrentWindow();
        const maxed = await win.isMaximized();
        if (maxed) {
          await win.unmaximize();
        } else {
          await win.maximize();
        }
      }
    }
  }

  public async minimizeWindow(): Promise<void> {
    if (this.isNativeRuntime) {
      await getCurrentWindow().minimize();
    }
  }

  public async closeWindow(): Promise<void> {
    if (this.isNativeRuntime) {
      await getCurrentWindow().close();
    }
  }

  // --- Live Audio Recording & Vocal Capture ---

  public async getAudioInputDevices(): Promise<readonly AudioInputDeviceInfo[]> {
    if (!this.isNativeRuntime) {
      return [{ name: "Default System Microphone (Web Audio)", isDefault: true }];
    }
    return invoke<AudioInputDeviceInfo[]>("get_audio_input_devices");
  }

  public async startRecording(startTick: number, trackIndex: number): Promise<void> {
    if (!this.isNativeRuntime) {
      return;
    }
    await invoke("start_recording", { startTick, trackIndex });
  }

  public async stopRecording(): Promise<RecordedAudioSummary | null> {
    if (!this.isNativeRuntime) {
      return null;
    }
    return invoke<RecordedAudioSummary | null>("stop_recording");
  }

  public async setLiveMonitoring(enabled: boolean): Promise<void> {
    if (!this.isNativeRuntime) {
      return;
    }
    await invoke("set_live_monitoring", { enabled });
  }

  // --- Hardware Physical MIDI Controllers ---

  public async getMidiInputDevices(): Promise<readonly MidiDeviceInfo[]> {
    if (!this.isNativeRuntime) {
      return [];
    }
    return invoke<MidiDeviceInfo[]>("get_midi_input_devices");
  }

  public async connectMidiDevice(
    portIndex: number,
    profile: MidiControllerProfile,
  ): Promise<string> {
    if (!this.isNativeRuntime) {
      return "Web Emulated MIDI Port";
    }
    return invoke<string>("connect_midi_device", { portIndex, profile });
  }

  public async disconnectMidiDevice(): Promise<void> {
    if (!this.isNativeRuntime) {
      return;
    }
    await invoke("disconnect_midi_device");
  }

  public async getMidiStatus(): Promise<MidiStatusSnapshot> {
    if (!this.isNativeRuntime) {
      return {
        connectedDevice: null,
        activeProfile: "generic",
        lastActivityTimestampMs: 0,
        lastNotePlayed: null,
      };
    }
    return invoke<MidiStatusSnapshot>("get_midi_status");
  }

  // --- Time-Stretching & Pitch-Shifting (WSOLA + 4-Point Hermite) ---

  public async timeStretchAudioClip(
    clipId: string,
    filePath: string,
    stretchRatio: number,
    pitchShiftSemitones: number,
    sampleRate = 48000,
  ): Promise<TimeStretchResult> {
    if (!this.isNativeRuntime) {
      return {
        clipId,
        originalPath: filePath,
        stretchedPath: filePath,
        frameCount: 48000 * 2,
        durationSeconds: 2.0 * stretchRatio,
        stretchRatio,
        pitchSemitones: pitchShiftSemitones,
      };
    }
    return invoke<TimeStretchResult>("time_stretch_audio_clip", {
      clipId,
      filePath,
      stretchRatio,
      pitchShiftSemitones,
      sampleRate,
    });
  }

  public async stretchChannelSample(
    slot: number,
    stretchRatio: number,
    pitchShiftSemitones: number,
  ): Promise<void> {
    if (!this.isNativeRuntime) {
      return;
    }
    await invoke("stretch_channel_sample", {
      slot,
      stretchRatio,
      pitchShiftSemitones,
    });
  }

  // --- External VST3 / CLAP Native Dedicated Window ---

  public async openPluginGuiWindow(instanceId: string): Promise<void> {
    if (!this.isNativeRuntime) {
      if (typeof window !== "undefined") {
        window.open(
          `?pluginWindow=${encodeURIComponent(instanceId)}`,
          `plugin-${instanceId}`,
          "width=760,height=540,resizable=yes",
        );
      }
      return;
    }
    await invoke("open_plugin_gui_window", { instanceId });
  }
}
