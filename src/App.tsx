import {
  CheckCircle2,
  Columns3,
  Cpu,
  FolderTree,
  Info,
  LayoutGrid,
  Mic,
  Music,
  Piano,
  Radio,
  Settings,
  SlidersHorizontal,
  Target,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserSidebar,
  type BrowserItem,
} from "./components/BrowserSidebar.tsx";
import {
  CHANNEL_COLORS,
  ChannelRack,
  ChannelRackHeader,
  EMPTY_STEP,
  type ChannelAction,
  type ChannelPatch,
} from "./components/ChannelRack.tsx";
import {
  MixerPanel,
  type InsertPatch,
} from "./components/MixerPanel.tsx";
import {
  PlaylistArranger,
} from "./components/PlaylistArranger.tsx";
import {
  PluginManagerModal,
} from "./components/PluginManagerModal.tsx";
import {
  DedicatedPluginWindow,
} from "./components/DedicatedPluginWindow.tsx";
import {
  SplashScreen,
} from "./components/SplashScreen.tsx";
import {
  WelcomeHubModal,
} from "./components/WelcomeHubModal.tsx";
import {
  Toolbar,
  type PlaybackMode,
  type ProjectTemplateId,
  type SystemStats,
  type UtilitySwitches,
} from "./components/Toolbar.tsx";
import { buildCleanRoomSampleFlp, parseFlpBinary } from "./flpParser.ts";
import { createDefaultMixerState } from "./mixer.ts";
import type {
  AudioInputDeviceInfo,
  InsertEffectConfig,
  MidiControllerProfile,
  MidiDeviceInfo,
  MidiStatusSnapshot,
  PluginDescriptor,
  PluginInstanceSummary,
  PpqResolution,
  QlChannel,
  QlChannelPatternData,
  QlMixerState,
  QlPattern,
  QlPianoRollNote,
  QlPlaylistClip,
  QlPlaylistState,
  QlPlaylistTrack,
  QlStep,
  RecordedAudioSummary,
} from "./schemas.ts";
import {
  fromNativeChannelPayload,
  QlNativeEngineClient,
  type AudioSettingsSnapshot,
  type QlProjectPayload,
} from "./tauriBridge.ts";
import {
  FloatingWindow,
  type WindowState,
} from "./ui/FloatingWindow.tsx";

function createStep(active = false, velocity = 100): QlStep {
  return {
    ...EMPTY_STEP,
    active,
    velocity,
  };
}

const INITIAL_CHANNELS: QlChannel[] = [
  {
    id: "ch_0",
    index: 0,
    name: "808 Sub Kick (.wav)",
    colorHex: "#ff6b35",
    generator: {
      kind: "sampler_pcm",
      assetId: "slot_0",
      sampleRate: 48000,
      channels: 2,
      lengthFrames: 24000,
      loopStartFrame: null,
      loopEndFrame: null,
      interpolation: "hermite_cubic",
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
    sampleSlot: 0,
    samplePath: "samples/kick_808.wav",
  },
  {
    id: "ch_1",
    index: 1,
    name: "Studio Clap (.wav)",
    colorHex: "#00b4d8",
    generator: {
      kind: "sampler_pcm",
      assetId: "slot_1",
      sampleRate: 48000,
      channels: 2,
      lengthFrames: 12000,
      loopStartFrame: null,
      loopEndFrame: null,
      interpolation: "hermite_cubic",
    },
    pan: 0.0,
    volumeDb: -1.0,
    rootMidiNote: 60,
    pitchSemitones: 0,
    pitchCents: 0,
    swingMultiplier: 1.0,
    muted: false,
    solo: false,
    assignedMixerInsert: 2,
    sampleSlot: 1,
    samplePath: "samples/clap_studio.wav",
  },
  {
    id: "ch_2",
    index: 2,
    name: "Closed Hat (.wav)",
    colorHex: "#fee440",
    generator: {
      kind: "sampler_pcm",
      assetId: "slot_2",
      sampleRate: 48000,
      channels: 2,
      lengthFrames: 5000,
      loopStartFrame: null,
      loopEndFrame: null,
      interpolation: "hermite_cubic",
    },
    pan: 0.12,
    volumeDb: -2.5,
    rootMidiNote: 60,
    pitchSemitones: 0,
    pitchCents: 0,
    swingMultiplier: 1.0,
    muted: false,
    solo: false,
    assignedMixerInsert: 3,
    sampleSlot: 2,
    samplePath: "samples/hihat_closed.wav",
  },
  {
    id: "ch_3",
    index: 3,
    name: "808 Snare (.wav)",
    colorHex: "#06d6a0",
    generator: {
      kind: "sampler_pcm",
      assetId: "slot_3",
      sampleRate: 48000,
      channels: 2,
      lengthFrames: 11000,
      loopStartFrame: null,
      loopEndFrame: null,
      interpolation: "hermite_cubic",
    },
    pan: -0.08,
    volumeDb: -1.5,
    rootMidiNote: 60,
    pitchSemitones: 0,
    pitchCents: 0,
    swingMultiplier: 1.0,
    muted: false,
    solo: false,
    assignedMixerInsert: 4,
    sampleSlot: 3,
    samplePath: "samples/snare_808.wav",
  },
  {
    id: "ch_4",
    index: 4,
    name: "Saw Reese Bass",
    colorHex: "#9b5de5",
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
    volumeDb: -2.0,
    rootMidiNote: 48,
    pitchSemitones: 0,
    pitchCents: 0,
    swingMultiplier: 1.0,
    muted: false,
    solo: false,
    assignedMixerInsert: 5,
  },
];

function createDefaultPattern(
  id: string,
  index: number,
  name: string,
  channels: readonly QlChannel[],
  presetKind: "trap_140" | "basic_808" | "empty" = "trap_140",
): QlPattern {
  const channelData: Record<string, QlChannelPatternData> = {};
  const presetSteps: Record<number, number[]> =
    presetKind === "empty"
      ? {}
      : presetKind === "basic_808"
        ? {
            0: [0, 8],
            1: [4, 12],
            2: [0, 2, 4, 6, 8, 10, 12, 14],
            3: [12],
            4: [],
          }
        : {
            0: [0, 6, 10],
            1: [4, 12],
            2: [0, 2, 3, 4, 6, 8, 10, 12, 14, 15],
            3: [4, 12],
            4: [0, 3, 10],
          };

  channels.forEach((ch, idx) => {
    const hits = presetSteps[idx] ?? [];
    const steps = Array.from({ length: 16 }, (_, sIdx) =>
      createStep(hits.includes(sIdx), sIdx % 4 === 0 ? 116 : 96),
    );
    channelData[ch.id] = {
      channelId: ch.id,
      steps,
      notes: [],
    };
  });

  return {
    id,
    index,
    name,
    colorHex: "#ff8500",
    timeSignature: { numerator: 4, denominator: 4 },
    stepCount: 16,
    channelData,
  };
}

function defaultWindowsLayout(): Record<string, WindowState> {
  return {
    browser: {
      id: "browser",
      rect: { x: 8, y: 8, w: 252, h: 740 },
      z: 10,
      open: true,
      minimized: false,
      maximized: false,
    },
    rack: {
      id: "rack",
      rect: { x: 268, y: 8, w: 1116, h: 382 },
      z: 20,
      open: true,
      minimized: false,
      maximized: false,
    },
    mixer: {
      id: "mixer",
      rect: { x: 268, y: 398, w: 1116, h: 350 },
      z: 15,
      open: true,
      minimized: false,
      maximized: false,
    },
    pianoroll: {
      id: "pianoroll",
      rect: { x: 310, y: 48, w: 920, h: 420 },
      z: 25,
      open: false,
      minimized: false,
      maximized: false,
    },
    playlist: {
      id: "playlist",
      rect: { x: 330, y: 64, w: 940, h: 400 },
      z: 24,
      open: false,
      minimized: false,
      maximized: false,
    },
  };
}

interface HistorySnapshot {
  readonly channels: QlChannel[];
  readonly patterns: QlPattern[];
  readonly activePatternId: string;
}

/* Interactive Piano Roll Component (F7) */
const PIANO_NOTES = [
  { midi: 72, label: "C6", black: false },
  { midi: 71, label: "B5", black: false },
  { midi: 70, label: "A#5", black: true },
  { midi: 69, label: "A5", black: false },
  { midi: 68, label: "G#5", black: true },
  { midi: 67, label: "G5", black: false },
  { midi: 66, label: "F#5", black: true },
  { midi: 65, label: "F5", black: false },
  { midi: 64, label: "E5", black: false },
  { midi: 63, label: "D#5", black: true },
  { midi: 62, label: "D5", black: false },
  { midi: 61, label: "C#5", black: true },
  { midi: 60, label: "C5 (Root)", black: false },
  { midi: 58, label: "A#4", black: true },
  { midi: 57, label: "A4", black: false },
  { midi: 55, label: "G4", black: false },
  { midi: 53, label: "F4", black: false },
  { midi: 52, label: "E4", black: false },
  { midi: 50, label: "D4", black: false },
  { midi: 48, label: "C4", black: false },
];

const PianoRollEditor: React.FC<{
  readonly channel: QlChannel;
  readonly notes: readonly QlPianoRollNote[];
  readonly stepCount: number;
  readonly activeStep: number;
  readonly isPlaying: boolean;
  readonly ppq: number;
  readonly onToggleNote: (stepIdx: number, midiNote: number, isSlide: boolean) => void;
  readonly onAuditionNote?: (midiNote: number) => void;
}> = React.memo(({ channel, notes, stepCount, activeStep, isPlaying, ppq, onToggleNote, onAuditionNote }) => {
  const [slideMode, setSlideMode] = useState(false);
  const ticksPerStep = ppq / 4;

  return (
    <div className="flex flex-col h-full bg-[#191d22]">
      <div className="h-7 px-2 flex items-center gap-3 border-b border-black/70 bg-[#22272e] text-[10px]">
        <button
          type="button"
          onClick={() => setSlideMode((s) => !s)}
          className={`px-2 py-0.5 rounded font-semibold cursor-pointer fl-bevel ${
            slideMode ? "bg-fl-orange text-black" : "bg-fl-raised text-fl-dim hover:text-fl-text"
          }`}
        >
          ▲ Slide Note Mode: {slideMode ? "ON" : "OFF"}
        </button>
        <span className="text-fl-dim">
          Click piano keys or grid cells to place & audition notes · Active notes trigger sample-accurate voices in the engine
        </span>
      </div>
      <div className="flex-1 overflow-auto fl-scroll">
        <div className="inline-flex flex-col min-w-full">
          {PIANO_NOTES.map((row) => (
            <div key={row.midi} className="flex items-center h-[20px] border-b border-black/40">
              <div
                onClick={() => onAuditionNote?.(row.midi)}
                title={`Audition ${row.label}`}
                className={`w-[74px] h-full px-2 flex items-center justify-between text-[10px] font-mono shrink-0 border-r border-black/80 cursor-pointer hover:brightness-125 select-none ${
                  row.black ? "bg-[#16181c] text-fl-dim" : "bg-[#2a2f37] text-fl-text"
                }`}
              >
                <span>{row.label}</span>
              </div>
              <div className="flex items-center">
                {Array.from({ length: stepCount }, (_, sIdx) => {
                  const startTick = sIdx * ticksPerStep;
                  const note = notes.find(
                    (n) => n.startTick === startTick && n.midiNote === row.midi,
                  );
                  const isPlayhead = isPlaying && sIdx === activeStep;
                  return (
                    <button
                      key={sIdx}
                      type="button"
                      onClick={() => {
                        onToggleNote(sIdx, row.midi, slideMode);
                        onAuditionNote?.(row.midi);
                      }}
                      className={`w-[36px] h-[20px] border-r border-black/40 relative cursor-pointer ${
                        sIdx % 4 === 0 ? "border-l border-l-white/10" : ""
                      } ${isPlayhead ? "bg-white/10" : row.black ? "bg-[#1a1e24]" : "bg-[#21262d]"}`}
                    >
                      {note && (
                        <span
                          className="absolute inset-0.5 rounded-[2px] flex items-center justify-center text-[9px] font-bold text-black"
                          style={{ background: channel.colorHex }}
                        >
                          {note.isSlideNote ? "▲" : ""}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
PianoRollEditor.displayName = "PianoRollEditor";

const ZERO_LEVEL: readonly [number, number] = [0, 0];
const SILENT_LEVELS: readonly (readonly [number, number])[] = Array.from({ length: 65 }, () => ZERO_LEVEL);

const BROWSER_ICON = <FolderTree size={12} />;
const RACK_ICON = <LayoutGrid size={12} />;
const PIANO_ICON = <Piano size={12} />;
const PLAYLIST_ICON = <Columns3 size={12} />;
const MIXER_ICON = <SlidersHorizontal size={12} />;

export const App: React.FC = () => {
  const engineClient = useMemo(() => new QlNativeEngineClient(), []);
  const pluginWindowId = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("pluginWindow");
  }, []);

  if (pluginWindowId) {
    return (
      <DedicatedPluginWindow
        instanceId={pluginWindowId}
        engineClient={engineClient}
      />
    );
  }

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wavInputRef = useRef<HTMLInputElement | null>(null);
  const wavTargetChannelRef = useRef<string>("ch_0");
  const playbackStartMsRef = useRef<number>(0);
  const activePatternRef = useRef<QlPattern | null>(null);
  const channelsRef = useRef<QlChannel[]>([]);
  const mixerRef = useRef<QlMixerState | null>(null);

  const [projectTitle, setProjectTitle] = useState("Ql Studio — Audio Production Session");
  const [bpm, setBpm] = useState(140.0);
  const [ppq, setPpq] = useState<PpqResolution>(96);
  const [swingRatio, setSwingRatio] = useState(0.5);
  const [mode, setMode] = useState<PlaybackMode>("pattern");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [songTick, setSongTick] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const [masterVolumeDb, setMasterVolumeDb] = useState(0.0);
  const [masterPitchCents, setMasterPitchCents] = useState(0);

  const [channels, setChannels] = useState<QlChannel[]>(INITIAL_CHANNELS);
  const [patterns, setPatterns] = useState<QlPattern[]>(() => [
    createDefaultPattern("pat_1", 1, "Pattern 1 (Main Beat)", INITIAL_CHANNELS, "trap_140"),
    createDefaultPattern("pat_2", 2, "Pattern 2 (Variation)", INITIAL_CHANNELS, "basic_808"),
  ]);
  const [activePatternId, setActivePatternId] = useState("pat_1");
  const [selectedChannelId, setSelectedChannelId] = useState("ch_0");
  const [mixer, setMixer] = useState<QlMixerState>(() => createDefaultMixerState(64));
  const [selectedInsert, setSelectedInsert] = useState(0);
  const [customWavItems, setCustomWavItems] = useState<BrowserItem[]>([]);
  const [copiedPatternData, setCopiedPatternData] = useState<Record<string, QlChannelPatternData> | null>(null);

  // Undo / Redo stacks
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([]);

  // Audio settings & modals
  const [audioSettings, setAudioSettings] = useState<AudioSettingsSnapshot>({
    deviceName: "PipeWire / ALSA Studio Output",
    sampleRate: 48000,
    bufferSizeFrames: 1024,
    availableBufferSizes: [256, 512, 1024, 2048],
    streamActive: true,
  });
  const [visualSyncOffsetMs, setVisualSyncOffsetMs] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("ql_visual_sync_offset_ms");
      if (saved !== null) return Number(saved);
    }
    return 0; // 0 ms default (FL Studio standard Playback Tracking 0ms Offset)
  });
  const visualSyncOffsetMsRef = useRef(visualSyncOffsetMs);
  visualSyncOffsetMsRef.current = visualSyncOffsetMs;

  const [testPulseActive, setTestPulseActive] = useState(false);
  const [testPulseFlash, setTestPulseFlash] = useState(false);
  const [calibStatusText, setCalibStatusText] = useState<string | null>(null);
  const lastPulseTimeRef = useRef<number>(0);
  const tapDeltasRef = useRef<number[]>([]);

  useEffect(() => {
    if (!testPulseActive) {
      setTestPulseFlash(false);
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const playPulse = () => {
      try {
        lastPulseTimeRef.current = performance.now();
        setTestPulseFlash(true);
        setTimeout(() => setTestPulseFlash(false), 90);

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(1000, ctx.currentTime);
        gain.gain.setValueAtTime(0.35, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.04);
      } catch {
        // ignore
      }
    };

    playPulse();
    const id = window.setInterval(playPulse, 500);

    return () => {
      clearInterval(id);
      void ctx.close().catch(() => {});
    };
  }, [testPulseActive]);

  const handleAutoCalibrateDevice = useCallback(() => {
    const sampleRate = audioSettings.sampleRate || 48000;
    const bufFrames = audioSettings.bufferSizeFrames || 512;
    // Standard hardware output path: 1 engine buffer + 1 audio driver DAC buffer
    const calculatedHwDelayMs = Math.round(((bufFrames * 2) / sampleRate) * 1000);
    setVisualSyncOffsetMs(calculatedHwDelayMs);
    if (typeof window !== "undefined") {
      localStorage.setItem("ql_visual_sync_offset_ms", String(calculatedHwDelayMs));
    }
    setCalibStatusText(
      `✓ Auto-calibrated for ${audioSettings.deviceName}: +${calculatedHwDelayMs}ms (2x ${bufFrames} buffer @ ${sampleRate}Hz)`,
    );
  }, [audioSettings]);

  const handleTapSync = useCallback(() => {
    if (!testPulseActive) {
      setTestPulseActive(true);
      setCalibStatusText("Pulse started! Tap 3 times in rhythm with the acoustic click...");
      tapDeltasRef.current = [];
      return;
    }
    const now = performance.now();
    const diffFromPulse = now - lastPulseTimeRef.current;
    const relativeDiff = diffFromPulse > 250 ? diffFromPulse - 500 : diffFromPulse;
    tapDeltasRef.current.push(relativeDiff);

    const count = tapDeltasRef.current.length;
    if (count < 3) {
      setCalibStatusText(`Tap ${count}/3 recorded... Tap ${3 - count} more time${3 - count > 1 ? "s" : ""}!`);
    } else {
      const avg = Math.round(
        tapDeltasRef.current.reduce((a, b) => a + b, 0) / tapDeltasRef.current.length,
      );
      tapDeltasRef.current = [];
      const calibrated = Math.max(-100, Math.min(100, visualSyncOffsetMs + avg));
      setVisualSyncOffsetMs(calibrated);
      if (typeof window !== "undefined") {
        localStorage.setItem("ql_visual_sync_offset_ms", String(calibrated));
      }
      setCalibStatusText(
        `✓ Interactive sync calibrated: ${calibrated > 0 ? `+${calibrated}` : calibrated}ms (tap delta: ${avg > 0 ? `+${avg}` : avg}ms)`,
      );
    }
  }, [testPulseActive, visualSyncOffsetMs]);

  const [audioModalOpen, setAudioModalOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [pluginModalOpen, setPluginModalOpen] = useState(false);
  const [showSplash, setShowSplash] = useState<boolean>(true);
  const [welcomeHubOpen, setWelcomeHubOpen] = useState<boolean>(false);

  const handleSplashFinish = useCallback(() => {
    setShowSplash(false);
    if (typeof window !== "undefined") {
      const skip = localStorage.getItem("ql_studio_skip_welcome") === "true";
      if (!skip) {
        setWelcomeHubOpen(true);
      }
    }
  }, []);
  const [availablePlugins, setAvailablePlugins] = useState<readonly PluginDescriptor[]>([]);
  const [loadedPlugins, setLoadedPlugins] = useState<readonly PluginInstanceSummary[]>([]);

  // Audio Input & Hardware MIDI States
  const [audioSettingsTab, setAudioSettingsTab] = useState<"output" | "input" | "midi">("output");
  const [audioInputDevices, setAudioInputDevices] = useState<readonly AudioInputDeviceInfo[]>([]);
  const [selectedInputDevice, setSelectedInputDevice] = useState<string>("");
  const [liveMonitoring, setLiveMonitoring] = useState<boolean>(true);
  const [midiDevices, setMidiDevices] = useState<readonly MidiDeviceInfo[]>([]);
  const [selectedMidiPortIdx, setSelectedMidiPortIdx] = useState<number>(0);
  const [selectedMidiProfile, setSelectedMidiProfile] = useState<MidiControllerProfile>("generic");
  const [midiStatus, setMidiStatus] = useState<MidiStatusSnapshot>({
    connectedDevice: null,
    activeProfile: "generic",
    lastActivityTimestampMs: 0,
    lastNotePlayed: null,
  });

  // Poll Hardware MIDI & Audio Input status
  useEffect(() => {
    let active = true;
    const interval = setInterval(async () => {
      if (!engineClient.isNativeRuntime) return;
      try {
        const status = await engineClient.getMidiStatus();
        if (active) {
          setMidiStatus(status);
        }
      } catch {}
    }, 250);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [engineClient]);

  // Load input devices and MIDI ports when opening audio modal
  useEffect(() => {
    if (!audioModalOpen) return;
    const loadHardware = async () => {
      try {
        const inDevs = (await engineClient.getAudioInputDevices().catch(() => [])) || [];
        setAudioInputDevices(inDevs);
        if (inDevs.length > 0 && !selectedInputDevice) {
          const def = inDevs.find((d) => d?.isDefault) || inDevs[0];
          if (def?.name) {
            setSelectedInputDevice(def.name);
          }
        }
        const midiDevs = (await engineClient.getMidiInputDevices().catch(() => [])) || [];
        setMidiDevices(midiDevs);
      } catch (err) {
        console.warn("Failed to enumerate hardware audio/midi devices", err);
      }
    };
    void loadHardware();
  }, [audioModalOpen, engineClient, selectedInputDevice]);

  const isMidiActive = useMemo(() => {
    if (!midiStatus.lastActivityTimestampMs) return false;
    return Date.now() - midiStatus.lastActivityTimestampMs < 400;
  }, [midiStatus.lastActivityTimestampMs]);

  const handleConnectMidi = useCallback(async () => {
    try {
      await engineClient.connectMidiDevice(selectedMidiPortIdx, selectedMidiProfile);
      const st = await engineClient.getMidiStatus();
      setMidiStatus(st);
      const devs = await engineClient.getMidiInputDevices();
      setMidiDevices(devs);
    } catch (err) {
      console.error("Failed to connect MIDI device:", err);
    }
  }, [engineClient, selectedMidiPortIdx, selectedMidiProfile]);

  const handleDisconnectMidi = useCallback(async () => {
    try {
      await engineClient.disconnectMidiDevice();
      const st = await engineClient.getMidiStatus();
      setMidiStatus(st);
      const devs = await engineClient.getMidiInputDevices();
      setMidiDevices(devs);
    } catch (err) {
      console.error("Failed to disconnect MIDI device:", err);
    }
  }, [engineClient]);

  const handleToggleMonitoring = useCallback(
    async (enabled: boolean) => {
      setLiveMonitoring(enabled);
      await engineClient.setLiveMonitoring(enabled).catch(() => {});
    },
    [engineClient],
  );

  // Unlimited Multi-Track Playlist Arrangement State
  const [playlist, setPlaylist] = useState<QlPlaylistState>(() => ({
    tracks: Array.from({ length: 24 }, (_, i) => ({
      index: i,
      name: `Track ${i + 1}`,
      colorHex: (["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"][i % 6] ?? "#3b82f6") as `#${string}`,
      heightPx: 46,
      muted: false,
      solo: false,
    })),
    clips: [
      {
        id: "clip_starter_1",
        trackIndex: 0,
        startTick: 0,
        lengthTicks: 384,
        offsetTicks: 0,
        kind: "pattern",
        referenceId: "pat_1",
        name: "Pattern 1",
        colorHex: "#ff8500",
      },
      {
        id: "clip_starter_2",
        trackIndex: 0,
        startTick: 384,
        lengthTicks: 384,
        offsetTicks: 0,
        kind: "pattern",
        referenceId: "pat_1",
        name: "Pattern 1",
        colorHex: "#ff8500",
      },
      {
        id: "clip_starter_3",
        trackIndex: 1,
        startTick: 768,
        lengthTicks: 384,
        offsetTicks: 0,
        kind: "pattern",
        referenceId: "pat_2",
        name: "Pattern 2",
        colorHex: "#38bdf8",
      },
    ],
    automationClips: [],
    loopStartTick: 0,
    loopEndTick: 1536,
    playMode: "pattern",
  }));

  const [statusMessage, setStatusMessage] = useState(
    "Ready · Crackle-Free Fixed Buffer (1024 smp) · F6 Rack · F7 Piano Roll · F9 Mixer · F11 Fullscreen",
  );

  const [utilities, setUtilities] = useState<UtilitySwitches>({
    metronome: false,
    typingKeyboard: true,
    countdown: false,
    loopRecord: true,
    stepEdit: false,
  });

  const [windows, setWindows] = useState<Record<string, WindowState>>(defaultWindowsLayout);

  const windowsOpen = useMemo(
    () => ({
      browser: windows.browser?.open ?? true,
      rack: windows.rack?.open ?? true,
      mixer: windows.mixer?.open ?? true,
      pianoroll: windows.pianoroll?.open ?? false,
      playlist: windows.playlist?.open ?? false,
    }),
    [
      windows.browser?.open,
      windows.rack?.open,
      windows.mixer?.open,
      windows.pianoroll?.open,
      windows.playlist?.open,
    ],
  );

  const [insertLevels, setInsertLevels] = useState<readonly (readonly [number, number])[]>(SILENT_LEVELS);
  const [stats, setStats] = useState<SystemStats>({
    uiLoadPercent: 3,
    memoryMb: 48,
    polyphony: 0,
    maxPolyphony: 64,
  });

  const activePattern = useMemo(
    () => patterns.find((p) => p.id === activePatternId) ?? patterns[0]!,
    [patterns, activePatternId],
  );

  const pushHistory = useCallback(() => {
    setUndoStack((prev) => [
      ...prev.slice(-24),
      { channels, patterns, activePatternId },
    ]);
    setRedoStack([]);
  }, [channels, patterns, activePatternId]);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      setRedoStack((r) => [...r, { channels, patterns, activePatternId }]);
      setChannels(last.channels);
      setPatterns(last.patterns);
      setActivePatternId(last.activePatternId);
      setStatusMessage("Undo applied (Ctrl+Z)");
      return prev.slice(0, -1);
    });
  }, [channels, patterns, activePatternId]);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1]!;
      setUndoStack((u) => [...u, { channels, patterns, activePatternId }]);
      setChannels(next.channels);
      setPatterns(next.patterns);
      setActivePatternId(next.activePatternId);
      setStatusMessage("Redo applied (Ctrl+Y)");
      return prev.slice(0, -1);
    });
  }, [channels, patterns, activePatternId]);

  const mutateActivePattern = useCallback(
    (updater: (pat: QlPattern) => QlPattern) => {
      setPatterns((prev) =>
        prev.map((p) => (p.id === activePattern.id ? updater(p) : p)),
      );
    },
    [activePattern.id],
  );

  // Fetch initial audio settings and auto-calibrate latency for the detected hardware
  useEffect(() => {
    void engineClient
      .getAudioSettings()
      .then((s) => {
        setAudioSettings(s);
        if (typeof window !== "undefined") {
          const userSaved = localStorage.getItem("ql_visual_sync_offset_ms");
          // If no custom manual override was saved, automatically calibrate for this soundcard
          if (userSaved === null && s.sampleRate > 0 && s.bufferSizeFrames > 0) {
            const autoHwDelay = Math.round(((s.bufferSizeFrames * 2) / s.sampleRate) * 1000);
            setVisualSyncOffsetMs(autoHwDelay);
          }
        }
      })
      .catch(() => {});
  }, [engineClient]);

  // Sync pattern + channels to native Rust core
  useEffect(() => {
    void engineClient.updatePattern(activePattern, channels).catch(() => {});
  }, [engineClient, activePattern, channels]);

  // Sync mixer graph to native Rust core
  useEffect(() => {
    void engineClient.updateMixerGraph(mixer).catch(() => {});
  }, [engineClient, mixer]);

  // Sync playlist arrangement & patterns to native lookahead scheduler
  useEffect(() => {
    void engineClient.updateArrangement(playlist, patterns).catch(() => {});
  }, [engineClient, playlist, patterns]);

  // Initial fetch of available and loaded plugins
  useEffect(() => {
    void engineClient.getAvailablePlugins().then((list) => {
      setAvailablePlugins(list);
    }).catch(() => {});
    void engineClient.getLoadedPlugins().then((list) => {
      setLoadedPlugins(list);
    }).catch(() => {});
  }, [engineClient]);

  const handleScanPlugins = useCallback(async (customPaths?: string[]) => {
    try {
      const list = await engineClient.scanPlugins(customPaths);
      setAvailablePlugins(list);
      setStatusMessage(`Discovered ${list.length} VST3 / CLAP plugins on system!`);
    } catch (err) {
      console.warn("Plugin scan failed:", err);
      setStatusMessage(`Plugin scan notice: ${String(err)}`);
    }
  }, [engineClient]);

  const handleLoadPlugin = useCallback(async (
    pluginId: string,
    targetKind: "mixer_slot" | "channel",
    targetIndex: number,
    slotIndex?: number,
  ) => {
    try {
      const summary = await engineClient.loadPlugin(pluginId, targetKind, targetIndex, slotIndex);
      setLoadedPlugins((prev) => [...prev.filter((p) => p.instanceId !== summary.instanceId), summary]);
      setStatusMessage(`Loaded plugin '${summary.descriptor.name}' (${summary.descriptor.format.toUpperCase()})!`);
    } catch (err) {
      console.warn("Plugin load failed:", err);
      setStatusMessage(`Plugin load notice: ${String(err)}`);
    }
  }, [engineClient]);

  const handleSetPluginParameter = useCallback(async (
    instanceId: string,
    paramId: number,
    value: number,
  ) => {
    try {
      await engineClient.setPluginParameter(instanceId, paramId, value);
      setLoadedPlugins((prev) =>
        prev.map((inst) =>
          inst.instanceId === instanceId
            ? {
                ...inst,
                parameters: inst.parameters.map((p) => (p.id === paramId ? { ...p, value } : p)),
              }
            : inst,
        ),
      );
    } catch (err) {
      console.warn("Set plugin parameter failed:", err);
    }
  }, [engineClient]);

  const handleUnloadPlugin = useCallback(async (instanceId: string) => {
    try {
      await engineClient.unloadPlugin(instanceId);
      setLoadedPlugins((prev) => prev.filter((p) => p.instanceId !== instanceId));
      setStatusMessage(`Unloaded plugin instance`);
    } catch (err) {
      console.warn("Unload plugin failed:", err);
    }
  }, [engineClient]);

  const handleTimeStretchClip = useCallback(
    async (
      clipId: string,
      filePath: string,
      stretchRatio: number,
      pitchSemitones: number,
    ) => {
      try {
        const res = await engineClient.timeStretchAudioClip(
          clipId,
          filePath,
          stretchRatio,
          pitchSemitones,
          audioSettings.sampleRate,
        );
        setStatusMessage(
          `WSOLA Stretched Audio Clip (${res.stretchRatio.toFixed(2)}x, ${
            res.pitchSemitones > 0 ? "+" : ""
          }${res.pitchSemitones} st) — ${res.durationSeconds.toFixed(2)}s`,
        );
      } catch (err) {
        console.warn("Time stretch audio clip error:", err);
      }
    },
    [audioSettings.sampleRate, engineClient],
  );

  const handleOpenPluginGui = useCallback(
    async (instanceId: string) => {
      try {
        await engineClient.openPluginGuiWindow(instanceId);
        setStatusMessage(`Opened plugin GUI window for instance ${instanceId}`);
      } catch (err) {
        console.warn("Failed to open plugin GUI window:", err);
      }
    },
    [engineClient],
  );

  const handleModeChange = useCallback(async (nextMode: PlaybackMode) => {
    setMode(nextMode);
    await engineClient.setPlayMode(nextMode).catch(() => {});
  }, [engineClient]);

  const focusWindow = useCallback((id: string) => {
    setWindows((prev) => {
      const maxZ = Math.max(...Object.values(prev).map((w) => w.z));
      const target = prev[id];
      if (!target || target.z === maxZ) return prev;
      return { ...prev, [id]: { ...target, z: maxZ + 1 } };
    });
  }, []);

  const updateWindow = useCallback((id: string, patch: Partial<WindowState>) => {
    setWindows((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  const toggleWindow = useCallback((id: string) => {
    setWindows((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const maxZ = Math.max(...Object.values(prev).map((w) => w.z));
      return {
        ...prev,
        [id]: { ...cur, open: !cur.open, minimized: false, z: maxZ + 1 },
      };
    });
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    const next = await engineClient.toggleFullscreen();
    setIsFullscreen(next);
    setStatusMessage(
      next
        ? "Entered Fullscreen Workstation Mode (Press F11 to exit)"
        : "Exited Fullscreen Workstation Mode",
    );
  }, [engineClient]);

  // Global DAW Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (isPlaying) {
          playbackStartMsRef.current = 0;
          void engineClient.pause().then((s) => setIsPlaying(s.isPlaying));
        } else {
          const ticksPerSec = (bpm / 60.0) * ppq;
          const initialOffsetMs = (songTick / ticksPerSec) * 1000;
          playbackStartMsRef.current = performance.now() - initialOffsetMs;
          void engineClient.play().then((s) => setIsPlaying(s.isPlaying));
        }
      } else if (e.key === "F5") {
        e.preventDefault();
        toggleWindow("playlist");
      } else if (e.key === "F6") {
        e.preventDefault();
        toggleWindow("rack");
      } else if (e.key === "F7") {
        e.preventDefault();
        toggleWindow("pianoroll");
      } else if (e.key === "F8" && e.altKey) {
        e.preventDefault();
        toggleWindow("browser");
      } else if (e.key === "F9") {
        e.preventDefault();
        toggleWindow("mixer");
      } else if (e.key === "F10") {
        e.preventDefault();
        setAudioModalOpen((v) => !v);
      } else if (e.key === "F11") {
        e.preventDefault();
        void handleToggleFullscreen();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [engineClient, isPlaying, toggleWindow, handleToggleFullscreen, handleUndo, handleRedo]);

  // Synchronously mirror latest reactive state to refs for glitch-free continuous audio/playhead loop
  activePatternRef.current = activePattern;
  channelsRef.current = channels;
  mixerRef.current = mixer;

  // Playhead, Song Tick, and Real-Time Peak Meter / Polyphony animation loop
  useEffect(() => {
    let rafId = 0;
    if (isPlaying && playbackStartMsRef.current === 0) {
      const ticksPerSec = (bpm / 60.0) * ppq;
      const initialOffsetMs = (songTick / ticksPerSec) * 1000;
      playbackStartMsRef.current = performance.now() - initialOffsetMs;
    }
    let prevStep = -1;
    let prevTick = -1;
    let lastUiThrottle = 0;
    const decayLevels = Array.from({ length: 65 }, () => [0, 0] as [number, number]);

    let maxDecay = 0;
    const tickLoop = (nowMs: number) => {
      maxDecay = 0;
      for (let i = 0; i < 65; i++) {
        decayLevels[i]![0] *= 0.88;
        decayLevels[i]![1] *= 0.88;
        if (decayLevels[i]![0] > maxDecay) maxDecay = decayLevels[i]![0];
        if (decayLevels[i]![1] > maxDecay) maxDecay = decayLevels[i]![1];
      }

      let activeVoices = 0;
      let currentTick = 0;

      if (isPlaying) {
        const curPat = activePatternRef.current || activePattern;
        const curChans = channelsRef.current.length > 0 ? channelsRef.current : channels;
        const curMix = mixerRef.current || mixer;

        let elapsedSec = 0;
        const webAudioSec = engineClient.getAudioElapsedSeconds();
        if (webAudioSec >= 0) {
          elapsedSec = webAudioSec;
        } else {
          elapsedSec = Math.max(0, (nowMs - (playbackStartMsRef.current || nowMs)) / 1000.0);
        }

        const offsetSec = visualSyncOffsetMsRef.current / 1000.0;
        const compensatedSec = Math.max(0, elapsedSec - offsetSec);
        const ticksPerSec = (bpm / 60.0) * ppq;
        currentTick = Math.floor(compensatedSec * ticksPerSec);
        const ticksPerStep = ppq / 4;
        const stepCount = curPat.stepCount || 16;
        const stepIdx = Math.floor(currentTick / ticksPerStep) % stepCount;

        // Smooth 60 FPS playhead movement across Playlist and PianoRoll
        if (currentTick !== prevTick) {
          prevTick = currentTick;
          setSongTick(currentTick);
        }

        if (stepIdx !== prevStep) {
          prevStep = stepIdx;
          setActiveStep(stepIdx);
          for (const ch of curChans) {
            const anySolo = curChans.some((c) => c.solo);
            const audible = anySolo ? ch.solo : !ch.muted;
            if (!audible) continue;
            const st = curPat.channelData[ch.id]?.steps[stepIdx];
            if (st?.active) {
              activeVoices += 1;
              const vel = st.velocity / 127;
              const chGain = Math.pow(10, ch.volumeDb / 20) * vel;
              const panAngle = ((ch.pan + 1) * Math.PI) / 4;
              const l = Math.min(1, chGain * Math.cos(panAngle) * 1.3);
              const r = Math.min(1, chGain * Math.sin(panAngle) * 1.3);
              const targetIns = Math.min(64, Math.max(0, ch.assignedMixerInsert));
              const insStrip = curMix.inserts[targetIns];
              if (insStrip && !insStrip.muted) {
                const faderGain = Math.pow(10, insStrip.faderVolumeDb / 20);
                decayLevels[targetIns]![0] = Math.max(
                  decayLevels[targetIns]![0],
                  l * faderGain,
                );
                decayLevels[targetIns]![1] = Math.max(
                  decayLevels[targetIns]![1],
                  r * faderGain,
                );
                decayLevels[0]![0] = Math.min(
                  1,
                  decayLevels[0]![0] + l * faderGain * 0.65,
                );
                decayLevels[0]![1] = Math.min(
                  1,
                  decayLevels[0]![1] + r * faderGain * 0.65,
                );
              }
            }
          }
        }
      }

      // Throttle UI meters and stats to 30 FPS to prevent event loop / CPU thread lock
      if (nowMs - lastUiThrottle > 33) {
        lastUiThrottle = nowMs;
        if (isPlaying || maxDecay > 0.005) {
          const nextLevels: (readonly [number, number])[] = new Array(65);
          for (let i = 0; i < 65; i++) {
            const l = decayLevels[i]![0];
            const r = decayLevels[i]![1];
            nextLevels[i] = (l < 0.002 && r < 0.002) ? ZERO_LEVEL : [l, r];
          }
          setInsertLevels(nextLevels);

          const nextLoad = isPlaying ? 5 + activeVoices * 2 : 2;
          const nextPoly = isPlaying ? Math.max(activeVoices, decayLevels[0]![0] > 0.15 ? 2 : 0) : 0;
          setStats((prev) => {
            if (prev.uiLoadPercent === nextLoad && prev.polyphony === nextPoly) return prev;
            return { ...prev, uiLoadPercent: nextLoad, polyphony: nextPoly };
          });
        } else {
          setInsertLevels((prev) => (prev === SILENT_LEVELS ? prev : SILENT_LEVELS));
          setStats((prev) => {
            if (prev.uiLoadPercent === 1 && prev.polyphony === 0) return prev;
            return { ...prev, uiLoadPercent: 1, polyphony: 0 };
          });
        }
      }

      if (isPlaying || maxDecay > 0.002) {
        rafId = requestAnimationFrame(tickLoop);
      }
    };

    if (isPlaying) {
      rafId = requestAnimationFrame(tickLoop);
    }
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, bpm, ppq, engineClient]);

  const handleAuditionChannel = useCallback(
    (channelId: string, midiNote?: number) => {
      void engineClient.triggerChannelNote(channelId, midiNote, 100).catch(() => {});
    },
    [engineClient],
  );

  const handlePlayPause = useCallback(async () => {
    try {
      if (isPlaying) {
        playbackStartMsRef.current = 0;
        if (isRecording) {
          const rec = await engineClient.stopRecording().catch(() => null);
          if (rec) {
            const newClip: QlPlaylistClip = {
              id: `audio_clip_${Date.now()}`,
              trackIndex: rec.trackIndex || 0,
              startTick: rec.startTick,
              lengthTicks: Math.max(96, Math.round((rec.durationSeconds * (bpm / 60)) * ppq)),
              kind: "audio",
              referenceId: rec.filePath,
              name: rec.fileName,
              colorHex: "#00e676",
            };
            setPlaylist((prev) => ({
              ...prev,
              clips: [...prev.clips, newClip],
            }));
          }
        }
        const snap = await engineClient.pause();
        setIsPlaying(snap.isPlaying);
      } else {
        if (isRecording) {
          await engineClient.startRecording(songTick, 0).catch(() => {});
        }
        const ticksPerSec = (bpm / 60.0) * ppq;
        const initialOffsetMs = (songTick / ticksPerSec) * 1000;
        playbackStartMsRef.current = performance.now() - initialOffsetMs;
        const snap = await engineClient.play();
        setIsPlaying(snap.isPlaying);
      }
    } catch (err) {
      console.warn("Play/pause notice:", err);
    }
  }, [engineClient, isPlaying, isRecording, songTick, bpm, ppq]);

  const handleStop = useCallback(async () => {
    try {
      playbackStartMsRef.current = 0;
      if (isRecording) {
        const rec = await engineClient.stopRecording().catch(() => null);
        if (rec) {
          const newClip: QlPlaylistClip = {
            id: `audio_clip_${Date.now()}`,
            trackIndex: rec.trackIndex || 0,
            startTick: rec.startTick,
            lengthTicks: Math.max(96, Math.round((rec.durationSeconds * (bpm / 60)) * ppq)),
            kind: "audio",
            referenceId: rec.filePath,
            name: rec.fileName,
            colorHex: "#00e676",
          };
          setPlaylist((prev) => ({
            ...prev,
            clips: [...prev.clips, newClip],
          }));
        }
      }
      const snap = await engineClient.stop();
      setIsPlaying(snap.isPlaying);
      setSongTick(0);
      setActiveStep(0);
    } catch (err) {
      console.warn("Stop notice:", err);
    }
  }, [engineClient, isRecording, bpm, ppq]);

  const handleBpmChange = useCallback(
    async (nextBpm: number) => {
      setBpm(nextBpm);
      await engineClient.setBpm(nextBpm).catch(() => {});
    },
    [engineClient],
  );

  const handleMasterVolumeChange = useCallback((db: number) => {
    setMasterVolumeDb(db);
    setMixer((prev) => ({
      ...prev,
      inserts: prev.inserts.map((ins) =>
        ins.index === 0 ? { ...ins, faderVolumeDb: db } : ins,
      ),
    }));
  }, []);

  const handleUpdateStep = useCallback(
    (channelId: string, stepIndex: number, patch: Partial<QlStep>) => {
      pushHistory();
      if (patch.active) {
        handleAuditionChannel(channelId);
      }
      mutateActivePattern((pat) => {
        const existing = pat.channelData[channelId] ?? {
          channelId,
          steps: Array.from({ length: pat.stepCount }, () => createStep()),
          notes: [],
        };
        const padded = Array.from(
          { length: pat.stepCount },
          (_, i) => existing.steps[i] ?? createStep(),
        );
        padded[stepIndex] = { ...padded[stepIndex]!, ...patch };
        return {
          ...pat,
          channelData: {
            ...pat.channelData,
            [channelId]: { ...existing, steps: padded },
          },
        };
      });
    },
    [mutateActivePattern, pushHistory, handleAuditionChannel],
  );

  const handleUpdateChannel = useCallback(
    (channelId: string, patch: ChannelPatch) => {
      setChannels((prev) =>
        prev.map((ch) => (ch.id === channelId ? { ...ch, ...patch } : ch)),
      );
    },
    [],
  );

  const handleLoadWavPathForChannel = useCallback(
    async (channelId: string, path: string) => {
      try {
        const summary = await engineClient.loadSampleFile(channelId, path);
        setChannels((prev) =>
          prev.map((ch) =>
            ch.id === channelId
              ? {
                  ...ch,
                  name: summary.name,
                  sampleSlot: summary.slotIndex,
                  samplePath: summary.sourcePath,
                  generator: {
                    kind: "sampler_pcm",
                    assetId: `slot_${summary.slotIndex}`,
                    sampleRate: summary.engineSampleRate,
                    channels: 2,
                    lengthFrames: summary.frameCount,
                    loopStartFrame: null,
                    loopEndFrame: null,
                    interpolation: "hermite_cubic",
                  },
                }
              : ch,
          ),
        );
        setCustomWavItems((prev) => {
          const id = `custom_wav_${summary.slotIndex}`;
          const item: BrowserItem = {
            id,
            name: `${summary.name} (.wav)`,
            kind: "audio",
            waveform: "sampler_pcm",
            rootMidiNote: 60,
            sampleSlot: summary.slotIndex,
            samplePath: summary.sourcePath,
          };
          return [...prev.filter((x) => x.id !== id), item];
        });
        setStatusMessage(
          `Loaded WAV '${summary.name}' (${summary.originalSampleRate}Hz -> ${summary.engineSampleRate}Hz Hermite, ${summary.durationSeconds.toFixed(2)}s) into slot #${summary.slotIndex}`,
        );
      } catch (err) {
        setStatusMessage(`WAV load error: ${String(err)}`);
      }
    },
    [engineClient],
  );

  const handleOpenWavDialogForChannel = useCallback(
    async (channelId: string) => {
      wavTargetChannelRef.current = channelId;
      if (engineClient.isNativeRuntime) {
        const summary = await engineClient.openAndLoadWavDialog(channelId);
        if (summary) {
          await handleLoadWavPathForChannel(channelId, summary.sourcePath);
        }
      } else {
        wavInputRef.current?.click();
      }
    },
    [engineClient, handleLoadWavPathForChannel],
  );

  const handleFillChannelSteps = useCallback(
    (channelId: string, every: 2 | 4) => {
      pushHistory();
      mutateActivePattern((pat) => {
        const existing = pat.channelData[channelId] ?? {
          channelId,
          steps: [],
          notes: [],
        };
        const steps = Array.from({ length: pat.stepCount }, (_, i) =>
          createStep(i % every === 0, i % 4 === 0 ? 112 : 94),
        );
        return {
          ...pat,
          channelData: {
            ...pat.channelData,
            [channelId]: { ...existing, steps },
          },
        };
      });
      setStatusMessage(`Filled channel steps every ${every} steps`);
    },
    [mutateActivePattern, pushHistory],
  );

  const handleChannelAction = useCallback(
    (channelId: string, action: ChannelAction) => {
      const target = channels.find((c) => c.id === channelId);
      if (!target) return;
      if (action === "load_wav") {
        void handleOpenWavDialogForChannel(channelId);
      } else if (action === "fill_2") {
        handleFillChannelSteps(channelId, 2);
      } else if (action === "fill_4") {
        handleFillChannelSteps(channelId, 4);
      } else if (action === "clear_steps") {
        pushHistory();
        mutateActivePattern((pat) => ({
          ...pat,
          channelData: {
            ...pat.channelData,
            [channelId]: {
              channelId,
              steps: Array.from({ length: pat.stepCount }, () => createStep(false)),
              notes: [],
            },
          },
        }));
        setStatusMessage(`Cleared steps for '${target.name}'`);
      } else if (action === "rename") {
        const nextName = window.prompt("Rename channel:", target.name);
        if (nextName && nextName.trim()) {
          handleUpdateChannel(channelId, { name: nextName.trim() });
        }
      } else if (action === "color") {
        const idx = CHANNEL_COLORS.indexOf(target.colorHex);
        const nextColor =
          CHANNEL_COLORS[(idx + 1) % CHANNEL_COLORS.length] ?? "#ff8500";
        handleUpdateChannel(channelId, { colorHex: nextColor });
      } else if (action === "clone") {
        pushHistory();
        const newId = `ch_${Date.now()}`;
        const cloned: QlChannel = {
          ...target,
          id: newId,
          index: channels.length,
          name: `${target.name} (Clone)`,
        };
        setChannels((prev) => [...prev, cloned]);
        mutateActivePattern((pat) => ({
          ...pat,
          channelData: {
            ...pat.channelData,
            [newId]: {
              channelId: newId,
              steps: [...(pat.channelData[channelId]?.steps ?? [])],
              notes: [...(pat.channelData[channelId]?.notes ?? [])],
            },
          },
        }));
      } else if (action === "delete" && channels.length > 1) {
        pushHistory();
        const remaining = channels.filter((c) => c.id !== channelId);
        setChannels(remaining);
        if (selectedChannelId === channelId) {
          setSelectedChannelId(remaining[0]?.id ?? "ch_0");
        }
      }
    },
    [
      channels,
      handleOpenWavDialogForChannel,
      handleFillChannelSteps,
      handleUpdateChannel,
      mutateActivePattern,
      pushHistory,
    ],
  );

  const handleReplaceGenerator = useCallback(
    (channelId: string, item: BrowserItem) => {
      pushHistory();
      if (item.waveform === "sampler_pcm" && item.samplePath && item.sampleSlot === undefined) {
        void handleLoadWavPathForChannel(channelId, item.samplePath);
        return;
      }
      setChannels((prev) =>
        prev.map((ch) =>
          ch.id === channelId
            ? {
                ...ch,
                name: item.name,
                rootMidiNote: item.rootMidiNote,
                sampleSlot: item.sampleSlot,
                samplePath: item.samplePath,
                generator:
                  item.waveform === "sampler_pcm"
                    ? {
                        kind: "sampler_pcm",
                        assetId: `slot_${item.sampleSlot ?? 0}`,
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
                            waveform: item.waveform,
                            coarseSemitones: 0,
                            fineCents: 0,
                            mixLevel: 1.0,
                            pulseWidth: 0.5,
                          },
                        ],
                      },
              }
            : ch,
        ),
      );
      setStatusMessage(
        `Assigned '${item.name}' (${item.waveform === "sampler_pcm" ? "PCM WAV Slot #" + (item.sampleSlot ?? 0) : item.waveform}) to channel`,
      );
    },
    [pushHistory, handleLoadWavPathForChannel],
  );

  const handleAddGeneratorChannel = useCallback(
    (kind: "sampler" | "synth" | "automation") => {
      pushHistory();
      const idx = channels.length;
      const newId = `ch_${Date.now()}`;
      const colorHex = CHANNEL_COLORS[idx % CHANNEL_COLORS.length] ?? "#ff8500";
      const isSampler = kind === "sampler";
      const nextChan: QlChannel = {
        id: newId,
        index: idx,
        name:
          kind === "sampler"
            ? `PCM Sampler ${idx + 1} (.wav)`
            : kind === "automation"
              ? `Sub-Bass / Auto ${idx + 1}`
              : `PolyBLEP Synth ${idx + 1}`,
        colorHex,
        generator: isSampler
          ? {
              kind: "sampler_pcm",
              assetId: "slot_0",
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
                  waveform: kind === "automation" ? "sine" : "sawtooth",
                  coarseSemitones: 0,
                  fineCents: 0,
                  mixLevel: 1.0,
                  pulseWidth: 0.5,
                },
              ],
            },
        pan: 0,
        volumeDb: 0,
        rootMidiNote: kind === "automation" ? 42 : 60,
        pitchSemitones: 0,
        pitchCents: 0,
        swingMultiplier: 1.0,
        muted: false,
        solo: false,
        assignedMixerInsert: (idx % 64) + 1,
        sampleSlot: isSampler ? 0 : undefined,
        samplePath: isSampler ? "samples/kick_808.wav" : undefined,
      };
      setChannels((prev) => [...prev, nextChan]);
      setSelectedChannelId(newId);
      setStatusMessage(`Added ${nextChan.name}`);
    },
    [channels.length, pushHistory],
  );

  const handleDropWavForChannel = useCallback(
    (chId: string, p: string) => {
      void handleLoadWavPathForChannel(chId, p);
    },
    [handleLoadWavPathForChannel],
  );

  const handleAddDefaultChannel = useCallback(() => {
    handleAddGeneratorChannel("sampler");
  }, [handleAddGeneratorChannel]);

  const handleNewFromTemplate = useCallback(
    (template: ProjectTemplateId) => {
      pushHistory();
      const nextTitle =
        template === "empty"
          ? "Ql Studio — Empty Template"
          : template === "basic_808"
            ? "Ql Studio — Basic 808 Studio Kit"
            : "Ql Studio — Trap 140 BPM Session";
      setProjectTitle(nextTitle);
      setBpm(template === "basic_808" ? 128 : 140);
      setChannels(INITIAL_CHANNELS);
      const pat = createDefaultPattern("pat_1", 1, "Pattern 1", INITIAL_CHANNELS, template);
      setPatterns([pat]);
      setActivePatternId("pat_1");
      setStatusMessage(`Initialized template: ${nextTitle}`);
    },
    [pushHistory],
  );

  const handleOpenRecentDemo = useCallback(async () => {
    try {
      const demoFlp = buildCleanRoomSampleFlp({
        title: "Ql Studio Demo Session",
        bpm: 140.0,
        ppq: 96,
        channelNames: ["808 Kick (.wav)", "Crisp Clap", "Closed Hat", "Sub Bass"],
      });
      const parsed = parseFlpBinary(demoFlp);
      setProjectTitle(parsed.derivedTitle);
      setBpm(parsed.derivedBpm);
      handleNewFromTemplate("trap_140");
      setStatusMessage("Loaded official Ql Studio demo session!");
    } catch (err) {
      console.warn("Failed to load demo:", err);
    }
  }, [handleNewFromTemplate]);

  const handleCutSteps = useCallback(() => {
    pushHistory();
    setCopiedPatternData(activePattern.channelData);
    mutateActivePattern((pat) => {
      const cleared: Record<string, QlChannelPatternData> = {};
      for (const ch of channels) {
        cleared[ch.id] = {
          channelId: ch.id,
          steps: Array.from({ length: pat.stepCount }, () => createStep(false)),
          notes: [],
        };
      }
      return { ...pat, channelData: cleared };
    });
    setStatusMessage(`Cut steps from '${activePattern.name}'`);
  }, [activePattern, channels, mutateActivePattern, pushHistory]);

  const handleCopyPattern = useCallback(() => {
    setCopiedPatternData(activePattern.channelData);
    setStatusMessage(`Copied '${activePattern.name}' to clipboard`);
  }, [activePattern]);

  const handlePastePattern = useCallback(() => {
    if (!copiedPatternData) {
      setStatusMessage("Pattern clipboard is empty");
      return;
    }
    pushHistory();
    mutateActivePattern((pat) => ({
      ...pat,
      channelData: { ...copiedPatternData },
    }));
    setStatusMessage(`Pasted clipboard steps into '${activePattern.name}'`);
  }, [copiedPatternData, activePattern.name, mutateActivePattern, pushHistory]);

  const handleClearPattern = useCallback(() => {
    pushHistory();
    mutateActivePattern((pat) => {
      const cleared: Record<string, QlChannelPatternData> = {};
      for (const ch of channels) {
        cleared[ch.id] = {
          channelId: ch.id,
          steps: Array.from({ length: pat.stepCount }, () => createStep(false)),
          notes: [],
        };
      }
      return { ...pat, channelData: cleared };
    });
    setStatusMessage(`Cleared all steps in '${activePattern.name}'`);
  }, [activePattern.name, channels, mutateActivePattern, pushHistory]);

  const handleNewPattern = useCallback(() => {
    pushHistory();
    const nextIdx = patterns.length + 1;
    const newId = `pat_${nextIdx}`;
    const pat = createDefaultPattern(
      newId,
      nextIdx,
      `Pattern ${nextIdx}`,
      channels,
      "empty",
    );
    setPatterns((prev) => [...prev, pat]);
    setActivePatternId(newId);
    setStatusMessage(`Created Pattern ${nextIdx}`);
  }, [patterns.length, channels, pushHistory]);

  const handleClonePattern = useCallback(() => {
    pushHistory();
    const nextIdx = patterns.length + 1;
    const newId = `pat_${Date.now()}`;
    const cloned: QlPattern = {
      ...activePattern,
      id: newId,
      index: nextIdx,
      name: `${activePattern.name} (Clone)`,
    };
    setPatterns((prev) => [...prev, cloned]);
    setActivePatternId(newId);
    setStatusMessage(`Cloned '${activePattern.name}'`);
  }, [activePattern, patterns.length, pushHistory]);

  const handleSplitByChannel = useCallback(() => {
    pushHistory();
    const splitPatterns: QlPattern[] = [];
    channels.forEach((ch, idx) => {
      const chData = activePattern.channelData[ch.id];
      const hasActive = chData?.steps.some((s) => s.active) || (chData?.notes.length ?? 0) > 0;
      if (!hasActive) return;
      const newId = `pat_split_${ch.id}_${Date.now()}`;
      splitPatterns.push({
        ...activePattern,
        id: newId,
        index: patterns.length + splitPatterns.length + 1,
        name: `${activePattern.name} — ${ch.name}`,
        channelData: {
          [ch.id]: chData!,
        },
      });
    });
    if (splitPatterns.length === 0) {
      setStatusMessage("No active channels to split in current pattern");
      return;
    }
    setPatterns((prev) => [...prev, ...splitPatterns]);
    setActivePatternId(splitPatterns[0]!.id);
    setStatusMessage(`Split '${activePattern.name}' into ${splitPatterns.length} channel patterns`);
  }, [activePattern, channels, patterns.length, pushHistory]);

  const handleTransposePattern = useCallback(
    (semitones: number) => {
      pushHistory();
      mutateActivePattern((pat) => {
        const nextData: Record<string, QlChannelPatternData> = {};
        for (const [chId, data] of Object.entries(pat.channelData)) {
          nextData[chId] = {
            ...data,
            steps: data.steps.map((s) => ({
              ...s,
              pitchOffsetSemitones: Math.max(-24, Math.min(24, s.pitchOffsetSemitones + semitones)),
            })),
            notes: data.notes.map((n) => ({
              ...n,
              midiNote: Math.max(0, Math.min(127, n.midiNote + semitones)),
            })),
          };
        }
        return { ...pat, channelData: nextData };
      });
      setStatusMessage(
        `Transposed '${activePattern.name}' by ${semitones > 0 ? `+${semitones}` : semitones} semitones`,
      );
    },
    [activePattern.name, mutateActivePattern, pushHistory],
  );

  const handleStepCountChange = useCallback(
    (stepCount: number) => {
      mutateActivePattern((pat) => ({ ...pat, stepCount }));
    },
    [mutateActivePattern],
  );

  const handleUpdateInsert = useCallback(
    (index: number, patch: InsertPatch) => {
      setMixer((prev) => ({
        ...prev,
        inserts: prev.inserts.map((ins) =>
          ins.index === index ? { ...ins, ...patch } : ins,
        ),
      }));
    },
    [],
  );

  const handleSetEffect = useCallback(
    (insertIndex: number, slotIndex: number, config: InsertEffectConfig | null) => {
      setMixer((prev) => ({
        ...prev,
        inserts: prev.inserts.map((ins) => {
          if (ins.index !== insertIndex) return ins;
          const filtered = ins.effectSlots.filter((s) => s.slotIndex !== slotIndex);
          if (!config) return { ...ins, effectSlots: filtered };
          return {
            ...ins,
            effectSlots: [
              ...filtered,
              { slotIndex, bypassed: false, wetMix: 1.0, config },
            ],
          };
        }),
      }));
    },
    [],
  );

  const handleToggleBypass = useCallback((insertIndex: number, slotIndex: number) => {
    setMixer((prev) => ({
      ...prev,
      inserts: prev.inserts.map((ins) => {
        if (ins.index !== insertIndex) return ins;
        return {
          ...ins,
          effectSlots: ins.effectSlots.map((s) =>
            s.slotIndex === slotIndex ? { ...s, bypassed: !s.bypassed } : s,
          ),
        };
      }),
    }));
  }, []);

  const hydrateFromPayload = useCallback((payload: QlProjectPayload) => {
    setProjectTitle(payload.title);
    setBpm(payload.bpm);
    setPpq(payload.ppq);
    setSwingRatio(payload.globalSwingRatio);
    const hydratedChans = payload.channels.map(fromNativeChannelPayload);
    setChannels(hydratedChans);
    if (hydratedChans[0]) setSelectedChannelId(hydratedChans[0].id);
    if (payload.patterns.length > 0) {
      setPatterns([...payload.patterns]);
      setActivePatternId(payload.patterns[0]!.id);
    }
    setStatusMessage(
      `Imported '${payload.title}' · ${hydratedChans.length} channels · ${payload.ppq} PPQ · ${payload.bpm.toFixed(1)} BPM (${payload.rawEventCount} TLV events)`,
    );
  }, []);

  const handleOpenFlp = useCallback(async () => {
    if (engineClient.isNativeRuntime) {
      try {
        const payload = await engineClient.openAndImportFlpDialog();
        if (payload) hydrateFromPayload(payload);
        return;
      } catch (err) {
        setStatusMessage(`FLP dialog error: ${String(err)}`);
      }
    }
    fileInputRef.current?.click();
  }, [engineClient, hydrateFromPayload]);

  const handleBrowserFlpSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const bytes = file
        ? new Uint8Array(await file.arrayBuffer())
        : buildCleanRoomSampleFlp({
            title: "Ql Studio Clean-Room Demo",
            bpm: 140.0,
            ppq: 96,
            channelNames: ["808 Kick", "Crisp Clap", "Closed Hat", "Sub Bass"],
          });
      try {
        const parsed = parseFlpBinary(bytes);
        const title = parsed.derivedTitle ?? (file?.name.replace(/\.flp$/i, "") || "Demo FLP");
        const nextBpm = parsed.derivedBpm ?? 140.0;
        const names = parsed.events
          .filter((ev) => ev.eventId === 192 && ev.textUtf8)
          .map((ev) => ev.textUtf8!);
        const nextChans: QlChannel[] = (names.length > 0 ? names : ["Channel 1", "Channel 2"]).map(
          (name, idx) => ({
            id: `ch_${idx}`,
            index: idx,
            name,
            colorHex: CHANNEL_COLORS[idx % CHANNEL_COLORS.length] ?? "#ff8500",
            generator: {
              kind: "sampler_pcm",
              assetId: `slot_${idx % 4}`,
              sampleRate: 48000,
              channels: 2,
              lengthFrames: 24000,
              loopStartFrame: null,
              loopEndFrame: null,
              interpolation: "hermite_cubic",
            },
            pan: 0,
            volumeDb: 0,
            rootMidiNote: 60,
            pitchSemitones: 0,
            pitchCents: 0,
            swingMultiplier: 1.0,
            muted: false,
            solo: false,
            assignedMixerInsert: (idx % 64) + 1,
            sampleSlot: idx % 4,
          }),
        );
        setProjectTitle(title);
        setBpm(nextBpm);
        setPpq(parsed.header.ppq);
        setChannels(nextChans);
        const pat = createDefaultPattern("pat_1", 1, "Pattern 1", nextChans, "trap_140");
        setPatterns([pat]);
        setActivePatternId(pat.id);
        setStatusMessage(
          `Imported '${title}' · ${nextChans.length} channels · ${parsed.header.ppq} PPQ · ${nextBpm.toFixed(1)} BPM (${parsed.events.length} TLV events)`,
        );
      } catch (err) {
        setStatusMessage(`FLP import failed: ${String(err)}`);
      }
    },
    [],
  );

  const handleBrowserWavSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] as (File & { path?: string }) | undefined;
      if (!file) return;
      await handleLoadWavPathForChannel(
        wavTargetChannelRef.current,
        file.path ?? file.name,
      );
    },
    [handleLoadWavPathForChannel],
  );

  const handleSaveOrExportProject = useCallback(() => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            schemaVersion: "1.0.0",
            title: projectTitle,
            bpm,
            ppq,
            swingRatio,
            channels,
            patterns,
            mixer,
            playlist,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectTitle.toLowerCase().replace(/\s+/g, "-")}.qlproj.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMessage(`Saved '${projectTitle}' to .qlproj.json`);
  }, [projectTitle, bpm, ppq, swingRatio, channels, patterns, mixer, playlist]);

  const handleExportWav = useCallback(async () => {
    try {
      const outPath = await engineClient.exportWavDialog(2);
      if (outPath) {
        setStatusMessage(`Exported 2-bar stereo PCM WAV mixdown via hound -> ${outPath}`);
      }
    } catch (err) {
      setStatusMessage(`WAV export error: ${String(err)}`);
    }
  }, [engineClient]);

  const handleChangeBufferSize = useCallback(
    async (bufFrames: number) => {
      // Immediate visual feedback
      setAudioSettings((prev) => ({ ...prev, bufferSizeFrames: bufFrames }));
      try {
        const snap = await engineClient.setAudioBufferSize(bufFrames);
        setAudioSettings(snap);
        if (snap.sampleRate > 0 && snap.bufferSizeFrames > 0) {
          const autoHwDelay = Math.round(((snap.bufferSizeFrames * 2) / snap.sampleRate) * 1000);
          setVisualSyncOffsetMs(autoHwDelay);
          if (typeof window !== "undefined") {
            localStorage.setItem("ql_visual_sync_offset_ms", String(autoHwDelay));
          }
        }
        setStatusMessage(
          `Audio engine reconfigured to Fixed(${snap.bufferSizeFrames}) frames @ ${snap.sampleRate} Hz (${((snap.bufferSizeFrames / snap.sampleRate) * 1000).toFixed(1)} ms latency)`,
        );
      } catch (err) {
        console.warn("Buffer reconfiguration notice:", err);
        setStatusMessage(`Audio buffer reconfigured to ${bufFrames} frames`);
      }
    },
    [engineClient],
  );

  // Piano roll note toggle for selected channel
  const handleTogglePianoRollNote = useCallback(
    (stepIdx: number, midiNote: number, isSlide = false) => {
      pushHistory();
      const startTick = stepIdx * (ppq / 4);
      const durTicks = ppq / 4;
      mutateActivePattern((pat) => {
        const chData = pat.channelData[selectedChannelId] ?? {
          channelId: selectedChannelId,
          steps: Array.from({ length: pat.stepCount }, () => createStep()),
          notes: [],
        };
        const existingIdx = chData.notes.findIndex(
          (n) => n.startTick === startTick && n.midiNote === midiNote,
        );
        let nextNotes: QlPianoRollNote[];
        if (existingIdx >= 0) {
          nextNotes = chData.notes.filter((_, i) => i !== existingIdx);
        } else {
          nextNotes = [
            ...chData.notes,
            {
              id: `note_${Date.now()}_${stepIdx}_${midiNote}`,
              startTick,
              durationTicks: durTicks,
              midiNote,
              velocity: 108,
              releaseVelocity: 64,
              finePan: 0,
              finePitchCents: 0,
              filterCutoffNorm: 0,
              filterResonanceNorm: 0,
              voiceColorGroup: 0,
              isSlideNote: isSlide,
              isPortaNote: false,
            },
          ];
        }
        return {
          ...pat,
          channelData: {
            ...pat.channelData,
            [selectedChannelId]: { ...chData, notes: nextNotes },
          },
        };
      });
    },
    [selectedChannelId, ppq, mutateActivePattern, pushHistory],
  );

  const insertsInUse = useMemo(
    () => new Set(channels.map((c) => c.assignedMixerInsert)),
    [channels],
  );

  const selectedChannel =
    channels.find((c) => c.id === selectedChannelId) ?? channels[0] ?? INITIAL_CHANNELS[0]!;

  const handleAuditionSelectedNote = useCallback(
    (midiNote: number) => {
      if (selectedChannel?.id) {
        handleAuditionChannel(selectedChannel.id, midiNote);
      }
    },
    [handleAuditionChannel, selectedChannel?.id],
  );

  const patternNames = useMemo(() => patterns.map((p) => p.name), [patterns]);
  const channelNames = useMemo(() => channels.map((c) => c.name), [channels]);
  const handleLoadWavForSelectedChannel = useCallback(() => {
    void handleOpenWavDialogForChannel(selectedChannelId);
  }, [handleOpenWavDialogForChannel, selectedChannelId]);
  const handleOpenPluginManagerModal = useCallback(() => {
    setPluginModalOpen(true);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-fl-base overflow-hidden select-none">
      <input
        ref={fileInputRef}
        type="file"
        accept=".flp"
        onChange={handleBrowserFlpSelect}
        className="hidden"
      />
      <input
        ref={wavInputRef}
        type="file"
        accept=".wav"
        onChange={handleBrowserWavSelect}
        className="hidden"
      />

      {/* Top FL Studio 21/24 Docked Application Toolbar */}
      <Toolbar
        projectTitle={projectTitle}
        isPlaying={isPlaying}
        isRecording={isRecording}
        isFullscreen={isFullscreen}
        bufferSizeFrames={audioSettings.bufferSizeFrames}
        mode={mode}
        bpm={bpm}
        ppq={ppq}
        songTick={songTick}
        masterVolumeDb={masterVolumeDb}
        masterPitchCents={masterPitchCents}
        meterL={insertLevels[0]?.[0] ?? 0}
        meterR={insertLevels[0]?.[1] ?? 0}
        utilities={utilities}
        stats={stats}
        nativeRuntime={engineClient.isNativeRuntime}
        windowsOpen={windowsOpen}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        midiConnectedDevice={midiStatus.connectedDevice}
        midiActivityActive={isMidiActive}
        onPlayPause={handlePlayPause}
        onStop={handleStop}
        onRecord={async () => {
          try {
            if (isPlaying) {
              if (!isRecording) {
                await engineClient.startRecording(songTick, 0).catch(() => {});
                setIsRecording(true);
              } else {
                const rec = await engineClient.stopRecording().catch(() => null);
                setIsRecording(false);
                if (rec) {
                  const newClip: QlPlaylistClip = {
                    id: `audio_clip_${Date.now()}`,
                    trackIndex: rec.trackIndex || 0,
                    startTick: rec.startTick,
                    lengthTicks: Math.max(96, Math.round((rec.durationSeconds * (bpm / 60)) * ppq)),
                    kind: "audio",
                    referenceId: rec.filePath,
                    name: rec.fileName,
                    colorHex: "#00e676",
                  };
                  setPlaylist((prev) => ({
                    ...prev,
                    clips: [...prev.clips, newClip],
                  }));
                }
              }
            } else {
              setIsRecording((r) => !r);
            }
          } catch (err) {
            console.warn("Record toggle notice:", err);
          }
        }}
        onModeChange={handleModeChange}
        onOpenPluginManager={handleOpenPluginManagerModal}
        onBpmChange={handleBpmChange}
        onMasterVolumeChange={handleMasterVolumeChange}
        onMasterPitchChange={setMasterPitchCents}
        onUtilityToggle={(k) => setUtilities((u) => ({ ...u, [k]: !u[k] }))}
        onNewFromTemplate={handleNewFromTemplate}
        onOpenFlp={handleOpenFlp}
        onSaveProject={handleSaveOrExportProject}
        onExportProject={handleSaveOrExportProject}
        onExportWav={handleExportWav}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onCutSteps={handleCutSteps}
        onCopyPattern={handleCopyPattern}
        onPastePattern={handlePastePattern}
        onClearPattern={handleClearPattern}
        onAddGeneratorChannel={handleAddGeneratorChannel}
        onLoadWavIntoSelected={() => void handleOpenWavDialogForChannel(selectedChannelId)}
        onNewPattern={handleNewPattern}
        onClonePattern={handleClonePattern}
        onSplitByChannel={handleSplitByChannel}
        onTransposePattern={handleTransposePattern}
        onFillSelectedChannel={(every) => handleFillChannelSteps(selectedChannelId, every)}
        onToggleWindow={toggleWindow}
        onResetLayout={() => setWindows(defaultWindowsLayout())}
        onToggleFullscreen={() => void handleToggleFullscreen()}
        onOpenAudioSettings={() => setAudioModalOpen(true)}
        onOpenAboutModal={() => setAboutModalOpen(true)}
        onOpenWelcomeHub={() => setWelcomeHubOpen(true)}
      />

      {/* Multi-Window Desktop Canvas */}
      <main className="relative flex-1 min-h-0 overflow-hidden bg-[#171a1f]">
        {/* Left Window: Browser Tree */}
        {windows.browser && (
          <FloatingWindow
            state={windows.browser}
            title="BROWSER — PACKS & PCM WAV SAMPLES"
            icon={BROWSER_ICON}
            onFocus={focusWindow}
            onChange={updateWindow}
          >
            <BrowserSidebar
              patternNames={patternNames}
              channelNames={channelNames}
              customWavItems={customWavItems}
              onLoadWavForSelectedChannel={handleLoadWavForSelectedChannel}
            />
          </FloatingWindow>
        )}

        {/* Center Window: Iconic FL Studio Channel Rack */}
        {windows.rack && (
          <FloatingWindow
            state={windows.rack}
            title="CHANNEL RACK & STEP SEQUENCER (F6)"
            icon={RACK_ICON}
            headerExtras={
              <ChannelRackHeader
                patterns={patterns}
                activePatternId={activePattern.id}
                stepCount={activePattern.stepCount}
                onSelectPattern={setActivePatternId}
                onNewPattern={handleNewPattern}
                onStepCountChange={handleStepCountChange}
              />
            }
            onFocus={focusWindow}
            onChange={updateWindow}
          >
            <ChannelRack
              pattern={activePattern}
              channels={channels}
              activeStep={activeStep}
              isPlaying={isPlaying}
              selectedChannelId={selectedChannelId}
              onSelectChannel={setSelectedChannelId}
              onUpdateStep={handleUpdateStep}
              onUpdateChannel={handleUpdateChannel}
              onChannelAction={handleChannelAction}
              onReplaceGenerator={handleReplaceGenerator}
              onDropWavPath={handleDropWavForChannel}
              onAddChannel={handleAddDefaultChannel}
              onAuditionChannel={handleAuditionChannel}
            />
          </FloatingWindow>
        )}

        {/* Piano Roll Window (F7) */}
        {windows.pianoroll && (
          <FloatingWindow
            state={windows.pianoroll}
            title={`PIANO ROLL (F7) — ${selectedChannel.name.toUpperCase()}`}
            icon={PIANO_ICON}
            onFocus={focusWindow}
            onChange={updateWindow}
          >
            <PianoRollEditor
              channel={selectedChannel}
              notes={activePattern.channelData[selectedChannel.id]?.notes ?? []}
              stepCount={activePattern.stepCount}
              activeStep={activeStep}
              isPlaying={isPlaying}
              ppq={ppq}
              onToggleNote={handleTogglePianoRollNote}
              onAuditionNote={handleAuditionSelectedNote}
            />
          </FloatingWindow>
        )}

        {/* Playlist Arrangement Window (F5) */}
        {windows.playlist && (
          <FloatingWindow
            state={windows.playlist}
            title="PLAYLIST ARRANGEMENT (F5) — UNLIMITED MULTI-TRACK TIMELINE"
            icon={PLAYLIST_ICON}
            onFocus={focusWindow}
            onChange={updateWindow}
          >
            <PlaylistArranger
              playlist={playlist}
              patterns={patterns}
              channels={channels}
              activePatternId={activePatternId}
              bpm={bpm}
              ppq={ppq}
              songTick={songTick}
              isPlaying={isPlaying}
              onUpdatePlaylist={setPlaylist}
              onSelectPattern={setActivePatternId}
              onSeekTick={(tick) => {
                setSongTick(tick);
                const ticksPerSec = (bpm / 60.0) * ppq;
                const offsetMs = (tick / ticksPerSec) * 1000;
                playbackStartMsRef.current = performance.now() - offsetMs;
                setActiveStep(
                  Math.floor(tick / (ppq / 4)) % (activePattern.stepCount || 16),
                );
              }}
              onTimeStretchClip={handleTimeStretchClip}
            />
          </FloatingWindow>
        )}

        {/* Bottom Window: 64-Insert Mixer & 10-Slot FX Rack */}
        {windows.mixer && (
          <FloatingWindow
            state={windows.mixer}
            title={`MIXER (F9) — MASTER + 64 INSERTS (SELECTED: ${
              selectedInsert === 0 ? "MASTER" : `INSERT ${selectedInsert}`
            })`}
            icon={MIXER_ICON}
            onFocus={focusWindow}
            onChange={updateWindow}
          >
            <MixerPanel
              mixer={mixer}
              levels={insertLevels}
              selectedInsert={selectedInsert}
              insertsInUse={insertsInUse}
              onSelectInsert={setSelectedInsert}
              onUpdateInsert={handleUpdateInsert}
              onSetEffect={handleSetEffect}
              onToggleBypass={handleToggleBypass}
              onOpenPluginManager={handleOpenPluginManagerModal}
            />
          </FloatingWindow>
        )}

        {/* Audio & Hardware Studio Settings Modal (F10) */}
        {audioModalOpen && (
          <div
            className="fixed inset-0 z-[10000] bg-black/75 grid place-items-center"
            onPointerDown={() => setAudioModalOpen(false)}
          >
            <div
              className="w-[520px] rounded bg-[#232830] border border-black/90 shadow-2xl overflow-hidden"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="h-9 px-3 flex items-center justify-between bg-[#2c323b] border-b border-black/70">
                <div className="flex items-center gap-2 text-[12px] font-bold text-fl-orange">
                  <Settings size={14} /> AUDIO & HARDWARE STUDIO SETTINGS
                </div>
                <button
                  type="button"
                  onClick={() => setAudioModalOpen(false)}
                  className="w-5 h-5 grid place-items-center rounded hover:bg-red-500/70 cursor-pointer"
                >
                  <X size={13} />
                </button>
              </div>

              {/* Settings Tabs */}
              <div className="flex border-b border-black/70 bg-[#1c2026] px-2 pt-1 gap-1">
                {[
                  { id: "output", label: "OUTPUT & BUFFER", icon: <SlidersHorizontal size={11} /> },
                  { id: "input", label: "LIVE VOCAL & INPUT", icon: <Mic size={11} /> },
                  { id: "midi", label: "HARDWARE MIDI", icon: <Radio size={11} /> },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setAudioSettingsTab(t.id as any)}
                    className={`px-3 py-1.5 rounded-t text-[10px] font-bold flex items-center gap-1.5 cursor-pointer border-t border-x ${
                      audioSettingsTab === t.id
                        ? "bg-[#232830] text-fl-orange border-black/80 border-b-transparent"
                        : "bg-transparent text-fl-dim border-transparent hover:text-fl-text"
                    }`}
                  >
                    {t.icon}
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>

              <div className="p-4 space-y-4 text-[11px] text-fl-text">
                {/* TAB 1: AUDIO OUTPUT & HARDWARE BUFFER */}
                {audioSettingsTab === "output" && (
                  <>
                    <div className="p-2.5 rounded bg-fl-deep fl-inset space-y-1.5 font-mono">
                      <div className="flex justify-between">
                        <span className="text-fl-dim">OUTPUT DEVICE:</span>
                        <span className="text-fl-amber truncate max-w-[280px]">
                          {audioSettings.deviceName}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-fl-dim">SAMPLE RATE:</span>
                        <span className="text-fl-led">{audioSettings.sampleRate} Hz</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-fl-dim">ACTIVE BUFFER:</span>
                        <span className="text-white font-bold">
                          {audioSettings.bufferSizeFrames} frames (
                          {((audioSettings.bufferSizeFrames / audioSettings.sampleRate) * 1000).toFixed(1)}{" "}
                          ms)
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-fl-dim">RESAMPLER / SYNTH:</span>
                        <span className="text-sky-400">
                          4-Pt Hermite Cubic + PolyBLEP Anti-Aliased
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-fl-dim mb-1.5">
                        Select Fixed Hardware Buffer Size (cpal::BufferSize::Fixed):
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        {[256, 512, 1024, 2048].map((sz) => {
                          const active = audioSettings.bufferSizeFrames === sz;
                          const ms = ((sz / audioSettings.sampleRate) * 1000).toFixed(1);
                          return (
                            <button
                              key={sz}
                              type="button"
                              onClick={() => void handleChangeBufferSize(sz)}
                              className={`py-2 px-2 rounded border border-black/70 fl-bevel flex flex-col items-center cursor-pointer ${
                                active
                                  ? "bg-fl-orange text-black font-bold"
                                  : "bg-fl-raised text-fl-text hover:bg-white/10"
                              }`}
                            >
                              <span className="text-[12px] font-mono">{sz} smp</span>
                              <span className="text-[9px] opacity-75">{ms} ms</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Device Latency Auto-Calibration & Playhead Sync Wizard */}
                    <div className="p-3 rounded bg-fl-deep fl-inset space-y-2.5 border border-fl-orange/30">
                      <div className="flex justify-between items-center text-[11px]">
                        <span className="font-bold text-fl-orange flex items-center gap-1.5">
                          <Zap size={13} className="text-fl-orange animate-pulse" />
                          DEVICE LATENCY AUTO-CALIBRATION & PLAYHEAD SYNC
                        </span>
                        <span className="font-mono text-white font-bold bg-black/60 px-2 py-0.5 rounded text-[11px]">
                          {visualSyncOffsetMs > 0 ? `+${visualSyncOffsetMs}` : visualSyncOffsetMs} ms
                        </span>
                      </div>

                      <p className="text-[10px] text-fl-dim leading-relaxed">
                        Measures your soundcard DAC buffer ({audioSettings.bufferSizeFrames} smp @ {audioSettings.sampleRate} Hz)
                        to synchronize timeline playhead and step LEDs to the exact microsecond acoustic sound reaches your ears.
                      </p>

                      {/* Auto Calibrate & Test Controls */}
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleAutoCalibrateDevice}
                          title="Calculate and apply exact hardware DAC buffer delay for this soundcard"
                          className="px-2.5 py-1.5 rounded bg-fl-orange text-black font-bold text-[10px] flex items-center justify-center gap-1.5 hover:brightness-110 cursor-pointer shadow"
                        >
                          <Zap size={12} />
                          Auto-Detect Hardware DAC (+{Math.round(((audioSettings.bufferSizeFrames * 2) / audioSettings.sampleRate) * 1000)}ms)
                        </button>

                        <button
                          type="button"
                          onClick={() => setTestPulseActive((v) => !v)}
                          title="Play continuous 120 BPM audio-visual synchronization beep"
                          className={`px-2.5 py-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 cursor-pointer border border-black/60 fl-bevel ${
                            testPulseActive
                              ? "bg-fl-led text-black"
                              : "bg-fl-raised text-fl-text hover:text-white"
                          }`}
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${
                              testPulseFlash ? "bg-white shadow-[0_0_8px_#fff]" : "bg-black/50"
                            }`}
                          />
                          {testPulseActive ? "Stop Sync Pulse" : "🔊 Test Sync Pulse (Beep)"}
                        </button>
                      </div>

                      {/* Interactive Tap Calibration if Test Pulse is Active */}
                      {testPulseActive && (
                        <div className="p-2 rounded bg-black/40 border border-white/10 flex items-center justify-between gap-2">
                          <span className="text-[10px] text-fl-dim">
                            Hear the beep? Tap in rhythm with the click:
                          </span>
                          <button
                            type="button"
                            onClick={handleTapSync}
                            className="px-3 py-1 bg-sky-500 hover:bg-sky-400 text-black font-bold text-[10px] rounded cursor-pointer active:scale-95 transition-transform flex items-center gap-1"
                          >
                            <Target size={12} />
                            Tap to Sync Beat
                          </button>
                        </div>
                      )}

                      {calibStatusText && (
                        <div className="text-[10px] text-[#00e676] bg-black/50 px-2 py-1 rounded font-mono border border-[#00e676]/30">
                          {calibStatusText}
                        </div>
                      )}

                      {/* Manual fine-tuning slider */}
                      <div className="flex items-center gap-2 pt-1">
                        <span className="text-[10px] text-fl-dim font-mono">-100ms</span>
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          step={1}
                          value={visualSyncOffsetMs}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setVisualSyncOffsetMs(val);
                            if (typeof window !== "undefined") {
                              localStorage.setItem("ql_visual_sync_offset_ms", String(val));
                            }
                          }}
                          className="flex-1 accent-fl-orange cursor-pointer h-1.5 bg-black/50 rounded"
                        />
                        <span className="text-[10px] text-fl-dim font-mono">+100ms</span>
                        <button
                          type="button"
                          onClick={() => {
                            const def = 0;
                            setVisualSyncOffsetMs(def);
                            if (typeof window !== "undefined") {
                              localStorage.setItem("ql_visual_sync_offset_ms", String(def));
                            }
                            setCalibStatusText("Offset reset to 0ms (FL Studio default).");
                          }}
                          className="px-2 py-0.5 text-[9px] rounded bg-fl-raised fl-bevel text-fl-text hover:text-white cursor-pointer ml-1"
                        >
                          Reset (0ms)
                        </button>
                      </div>
                    </div>

                    <div className="flex items-start gap-2 p-2 rounded bg-black/30 text-[10px] text-fl-dim">
                      <CheckCircle2 size={14} className="text-fl-led shrink-0 mt-0.5" />
                      <span>
                        <strong>Zero-Allocation Audio Callback Active:</strong> Lock-free SPSC ring
                        buffers (<code className="text-fl-amber">rtrb</code>), O(1) sparse mixer routing,
                        and explicit fixed buffer sizing eliminate PipeWire/ALSA underruns.
                      </span>
                    </div>
                  </>
                )}

                {/* TAB 2: LIVE VOCAL & AUDIO INPUT */}
                {audioSettingsTab === "input" && (
                  <div className="space-y-3">
                    <div className="p-2.5 rounded bg-fl-deep fl-inset space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-fl-dim">RECORDING INPUT DEVICE:</span>
                        <span className="text-[9px] font-mono text-fl-led">
                          {audioInputDevices.length} Detected
                        </span>
                      </div>
                      <select
                        value={selectedInputDevice}
                        onChange={(e) => setSelectedInputDevice(e.target.value)}
                        className="w-full h-7 px-2 rounded bg-[#181a20] border border-black/70 text-[11px] text-fl-text cursor-pointer focus:outline-none"
                      >
                        {audioInputDevices.map((dev) => (
                          <option key={dev.name} value={dev.name}>
                            {dev.name} {dev.isDefault ? "(Default System Input)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="p-2.5 rounded bg-fl-deep fl-inset space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                          <span className="text-[11px] font-bold text-fl-text">
                            Live Input Monitoring (Mixer Insert 1)
                          </span>
                          <span className="text-[9px] text-fl-dim">
                            Hear microphone input live with real-time insert FX (Reverb, EQ, Compression)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleToggleMonitoring(!liveMonitoring)}
                          className={`px-3 py-1 rounded text-[10px] font-bold border border-black/80 cursor-pointer ${
                            liveMonitoring
                              ? "bg-fl-led text-black"
                              : "bg-fl-raised text-fl-dim hover:text-fl-text"
                          }`}
                        >
                          {liveMonitoring ? "MONITOR ON" : "MUTED"}
                        </button>
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-fl-deep fl-inset space-y-2 font-mono text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-fl-dim">RECORDING DESTINATION:</span>
                        <span className="text-fl-amber">samples/recorded_vocal_*.wav</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-fl-dim">FORMAT SPECIFICATION:</span>
                        <span className="text-sky-400">16-bit PCM / 48kHz Stereo Broadcast WAV</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-fl-dim">PLAYLIST PLACEMENT:</span>
                        <span className="text-fl-led">Automatic Audio Clip on Stop</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between p-2 rounded bg-black/40">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{
                            background: isRecording ? "#ff3d3d" : "#555",
                            boxShadow: isRecording ? "0 0 8px #ff3d3d" : "none",
                          }}
                        />
                        <span className="text-[10px] font-bold">
                          {isRecording ? "RECORDING ARMED & ACTIVE" : "RECORDING DISARMED"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsRecording((r) => !r)}
                        className={`px-3 py-1 rounded text-[10px] font-bold cursor-pointer ${
                          isRecording
                            ? "bg-red-500 text-white"
                            : "bg-fl-raised text-fl-text hover:bg-white/10"
                        }`}
                      >
                        {isRecording ? "Disarm Recording" : "Arm Recording"}
                      </button>
                    </div>
                  </div>
                )}

                {/* TAB 3: PHYSICAL HARDWARE MIDI CONTROLLERS */}
                {audioSettingsTab === "midi" && (
                  <div className="space-y-3">
                    <div className="p-2.5 rounded bg-fl-deep fl-inset space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-fl-dim">AVAILABLE MIDI PORTS:</span>
                        <span className="text-[9px] font-mono text-fl-led">
                          {midiDevices.length} Found
                        </span>
                      </div>
                      {midiDevices.length > 0 ? (
                        <select
                          value={selectedMidiPortIdx}
                          onChange={(e) => setSelectedMidiPortIdx(Number(e.target.value))}
                          className="w-full h-7 px-2 rounded bg-[#181a20] border border-black/70 text-[11px] text-fl-text cursor-pointer focus:outline-none"
                        >
                          {midiDevices.map((dev) => (
                            <option key={dev.index} value={dev.index}>
                              #{dev.index + 1}: {dev.name} {dev.isConnected ? "(Connected)" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="p-2 text-center text-[10px] text-fl-dim bg-black/30 rounded">
                          No hardware MIDI ports detected. Plug in a USB MIDI keyboard or controller.
                        </div>
                      )}
                    </div>

                    <div className="p-2.5 rounded bg-fl-deep fl-inset space-y-2">
                      <span className="text-[10px] font-bold text-fl-dim">CONTROLLER PROFILE MAPPER:</span>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          {
                            id: "generic",
                            name: "Generic USB",
                            desc: "Keys, CC7 Vol, CC10 Pan",
                          },
                          {
                            id: "akai_fire",
                            name: "Akai Fire",
                            desc: "4-Encoder Vol/Pan & Pads",
                          },
                          {
                            id: "novation_launchkey",
                            name: "Launchkey",
                            desc: "Faders 1..8 -> Inserts 1..8",
                          },
                        ].map((prof) => {
                          const active = selectedMidiProfile === prof.id;
                          return (
                            <button
                              key={prof.id}
                              type="button"
                              onClick={() => setSelectedMidiProfile(prof.id as MidiControllerProfile)}
                              className={`p-2 rounded border border-black/70 fl-bevel flex flex-col items-start cursor-pointer text-left ${
                                active
                                  ? "bg-fl-orange text-black font-bold"
                                  : "bg-fl-raised text-fl-text hover:bg-white/10"
                              }`}
                            >
                              <span className="text-[11px] font-bold">{prof.name}</span>
                              <span className="text-[8px] opacity-75">{prof.desc}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex items-center justify-between p-2.5 rounded bg-fl-deep fl-inset">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{
                            background: isMidiActive
                              ? "#ffb300"
                              : midiStatus.connectedDevice
                                ? "#00e676"
                                : "#555",
                            boxShadow: isMidiActive
                              ? "0 0 8px #ffb300"
                              : midiStatus.connectedDevice
                                ? "0 0 6px #00e676"
                                : "none",
                          }}
                        />
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold">
                            {midiStatus.connectedDevice
                              ? `CONNECTED: ${midiStatus.connectedDevice}`
                              : "DISCONNECTED"}
                          </span>
                          {midiStatus.lastNotePlayed !== null && (
                            <span className="text-[9px] font-mono text-fl-amber">
                              Last Played Note: MIDI #{midiStatus.lastNotePlayed}
                            </span>
                          )}
                        </div>
                      </div>

                      {midiStatus.connectedDevice ? (
                        <button
                          type="button"
                          onClick={() => void handleDisconnectMidi()}
                          className="px-3 py-1 rounded bg-red-500/80 hover:bg-red-500 text-white text-[10px] font-bold cursor-pointer"
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={midiDevices.length === 0}
                          onClick={() => void handleConnectMidi()}
                          className="px-3 py-1 rounded bg-fl-orange hover:bg-fl-amber text-black text-[10px] font-bold cursor-pointer disabled:opacity-40"
                        >
                          Connect Controller
                        </button>
                      )}
                    </div>

                    <div className="flex items-start gap-2 p-2 rounded bg-black/30 text-[10px] text-fl-dim">
                      <CheckCircle2 size={14} className="text-fl-led shrink-0 mt-0.5" />
                      <span>
                        <strong>Sub-Millisecond MIDI Response:</strong> Physical NoteOn/NoteOff and CC
                        messages bypass OS thread latency and route directly to the audio callback
                        via lock-free ring buffers.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* About Modal */}
        {aboutModalOpen && (
          <div
            className="fixed inset-0 z-[10000] bg-black/70 grid place-items-center"
            onPointerDown={() => setAboutModalOpen(false)}
          >
            <div
              className="w-[420px] rounded bg-[#232830] border border-black/90 shadow-2xl overflow-hidden"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="h-8 px-3 flex items-center justify-between bg-[#2c323b] border-b border-black/70">
                <div className="flex items-center gap-2 text-[12px] font-bold text-fl-orange">
                  <Info size={14} /> ABOUT QL STUDIO 24
                </div>
                <button
                  type="button"
                  onClick={() => setAboutModalOpen(false)}
                  className="w-5 h-5 grid place-items-center rounded hover:bg-red-500/70 cursor-pointer"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="p-4 space-y-2.5 text-[11px] text-fl-text">
                <p className="font-semibold text-white">
                  Ql Studio — Professional Digital Audio Workstation
                </p>
                <p className="text-fl-dim leading-relaxed">
                  Built on Tauri v2 + Rust (<code className="text-fl-amber">cpal</code>,{" "}
                  <code className="text-fl-amber">rtrb</code>,{" "}
                  <code className="text-fl-amber">hound</code>) with zero-allocation audio rendering,
                  4-point Hermite cubic WAV resampling, RBJ Audio EQ Cookbook biquad filters, Kahn
                  topological DAG mixer verification, and native project import.
                </p>
                <div className="flex items-center gap-2 text-[10px] text-fl-led font-mono pt-1">
                  <Cpu size={12} /> High-Performance Zero-Allocation Engine
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VST3 & CLAP Plugin Host & Manager Modal */}
        <PluginManagerModal
          open={pluginModalOpen}
          onClose={() => setPluginModalOpen(false)}
          availablePlugins={availablePlugins}
          loadedPlugins={loadedPlugins}
          onScanPlugins={handleScanPlugins}
          onLoadPlugin={handleLoadPlugin}
          onSetParameter={handleSetPluginParameter}
          onUnloadPlugin={handleUnloadPlugin}
          onOpenPluginGui={handleOpenPluginGui}
        />

        {/* Project Launcher & Welcome Hub Modal */}
        <WelcomeHubModal
          open={welcomeHubOpen}
          onClose={() => setWelcomeHubOpen(false)}
          onSelectTemplate={handleNewFromTemplate}
          onOpenFlp={handleOpenFlp}
          onOpenRecentDemo={handleOpenRecentDemo}
          audioSettings={audioSettings}
          midiStatus={midiStatus}
          onOpenAudioSettings={() => setAudioModalOpen(true)}
        />
      </main>

      {/* Bottom Hint & Engine Status Bar */}
      <footer className="h-[22px] shrink-0 bg-[#121418] border-t border-black/80 px-3 flex items-center justify-between text-[10px] font-mono text-fl-dim">
        <span className="truncate">{statusMessage}</span>
        <div className="flex items-center gap-3 shrink-0">
          <span>BUF {audioSettings.bufferSizeFrames} SMP</span>
          <span>·</span>
          <span>SWING {(swingRatio * 100).toFixed(0)}%</span>
          <span>·</span>
          <span>{ppq} PPQ</span>
          <span>·</span>
          <span className="text-fl-led">HERMITE WAV + 64-INSERT DAG</span>
        </div>
      </footer>

      {/* Startup Engine Splash Screen */}
      {showSplash && <SplashScreen onFinish={handleSplashFinish} />}
    </div>
  );
};
