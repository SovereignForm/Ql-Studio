/**
 * Docked application shell: menu strip + master section + transport + monitor rack + utility switches + Fullscreen/Window controls.
 */
import {
  Circle,
  Clock3,
  Columns3,
  Cpu,
  FileAudio,
  FileDown,
  FolderOpen,
  Footprints,
  Gauge,
  Keyboard,
  LayoutGrid,
  ListMusic,
  Maximize,
  Minimize,
  Music2,
  PanelLeft,
  Pause,
  Piano,
  Play,
  Repeat,
  Save,
  Settings,
  SlidersHorizontal,
  Square,
  Timer,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Knob, PeakMeter, ToolButton, formatDb } from "../ui/primitives.tsx";

export type PlaybackMode = "pattern" | "song";
export type ProjectTemplateId = "empty" | "basic_808" | "trap_140";

export interface UtilitySwitches {
  readonly metronome: boolean;
  readonly typingKeyboard: boolean;
  readonly countdown: boolean;
  readonly loopRecord: boolean;
  readonly stepEdit: boolean;
}

export interface SystemStats {
  /** Main-thread UI load estimate (0..100) from frame timing; not the native audio thread. */
  readonly uiLoadPercent: number;
  readonly memoryMb: number | null;
  readonly polyphony: number;
  readonly maxPolyphony: number;
}

export interface ToolbarProps {
  readonly projectTitle: string;
  readonly isPlaying: boolean;
  readonly isRecording: boolean;
  readonly isFullscreen: boolean;
  readonly bufferSizeFrames: number;
  readonly mode: PlaybackMode;
  readonly bpm: number;
  readonly ppq: number;
  readonly songTick: number;
  readonly masterVolumeDb: number;
  readonly masterPitchCents: number;
  readonly meterL: number;
  readonly meterR: number;
  readonly utilities: UtilitySwitches;
  readonly stats: SystemStats;
  readonly nativeRuntime: boolean;
  readonly windowsOpen: Readonly<Record<string, boolean>>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onPlayPause: () => void;
  readonly onStop: () => void;
  readonly onRecord: () => void;
  readonly onModeChange: (m: PlaybackMode) => void;
  readonly onBpmChange: (bpm: number) => void;
  readonly onMasterVolumeChange: (db: number) => void;
  readonly onMasterPitchChange: (cents: number) => void;
  readonly onUtilityToggle: (key: keyof UtilitySwitches) => void;
  readonly onNewFromTemplate: (template: ProjectTemplateId) => void;
  readonly onOpenFlp: () => void;
  readonly onSaveProject: () => void;
  readonly onExportProject: () => void;
  readonly onExportWav: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onCutSteps: () => void;
  readonly onCopyPattern: () => void;
  readonly onPastePattern: () => void;
  readonly onClearPattern: () => void;
  readonly onAddGeneratorChannel: (kind: "sampler" | "synth" | "automation") => void;
  readonly onLoadWavIntoSelected: () => void;
  readonly onNewPattern: () => void;
  readonly onClonePattern: () => void;
  readonly onSplitByChannel: () => void;
  readonly onTransposePattern: (semitones: number) => void;
  readonly onFillSelectedChannel: (every: 2 | 4) => void;
  readonly onToggleWindow: (id: string) => void;
  readonly onResetLayout: () => void;
  readonly onToggleFullscreen: () => void;
  readonly onOpenAudioSettings: () => void;
  readonly onOpenAboutModal: () => void;
  readonly onOpenPluginManager?: () => void;
  readonly midiConnectedDevice?: string | null;
  readonly midiActivityActive?: boolean;
}

const MENUS = ["File", "Edit", "Add", "Patterns", "View", "Options", "Tools", "Help"] as const;

export const Toolbar: React.FC<ToolbarProps> = React.memo((p) => {
  const [openMenu, setOpenMenu] = useState<(typeof MENUS)[number] | null>(null);
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmDraft, setBpmDraft] = useState("");
  const bpmDrag = useRef<{ y: number; v: number } | null>(null);
  const taps = useRef<number[]>([]);
  const scopeRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef({ l: p.meterL, r: p.meterR, playing: p.isPlaying });
  levelRef.current = { l: p.meterL, r: p.meterR, playing: p.isPlaying };

  useEffect(() => {
    const close = () => setOpenMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  // Mini oscilloscope: renders a waveform whose amplitude follows the master meter level.
  useEffect(() => {
    const c = scopeRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    let raf = 0;
    let phase = 0;
    const draw = () => {
      const { l, r, playing } = levelRef.current;
      const amp = Math.max(l, r);
      ctx.fillStyle = "#07090a";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = "rgba(0,230,118,0.12)";
      for (let x = 0; x < c.width; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, c.height);
        ctx.stroke();
      }
      ctx.strokeStyle = "#00e676";
      ctx.shadowColor = "#00e676";
      ctx.shadowBlur = 4;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = 0; x < c.width; x++) {
        const t = x / c.width;
        const y =
          c.height / 2 +
          (Math.sin(t * 22 + phase) * 0.6 + Math.sin(t * 57 - phase * 1.7) * 0.4) *
            amp *
            (c.height * 0.45);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (playing || amp > 0.001) {
        if (playing) phase += 0.35;
        raf = requestAnimationFrame(draw);
      } else {
        raf = 0;
      }
    };
    if (levelRef.current.playing || Math.max(levelRef.current.l, levelRef.current.r) > 0.001) {
      raf = requestAnimationFrame(draw);
    }
    const interval = setInterval(() => {
      if (!raf && (levelRef.current.playing || Math.max(levelRef.current.l, levelRef.current.r) > 0.001)) {
        raf = requestAnimationFrame(draw);
      }
    }, 100);
    return () => {
      clearInterval(interval);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const ticksPerBeat = p.ppq;
  const bar = Math.floor(p.songTick / (ticksPerBeat * 4)) + 1;
  const beat = (Math.floor(p.songTick / ticksPerBeat) % 4) + 1;
  const tick = p.songTick % ticksPerBeat;

  const commitBpm = (raw: string) => {
    const v = parseFloat(raw.replace(",", "."));
    if (Number.isFinite(v)) p.onBpmChange(Math.min(522, Math.max(10, v)));
    setEditingBpm(false);
  };

  const tapTempo = () => {
    const now = performance.now();
    const recent = [...taps.current.filter((t) => now - t < 2500), now];
    taps.current = recent;
    if (recent.length >= 2) {
      const intervals = recent.slice(1).map((t, i) => t - recent[i]!);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      p.onBpmChange(Math.min(522, Math.max(10, Number((60000 / avg).toFixed(2)))));
    }
  };

  const menuItems: Record<
    (typeof MENUS)[number],
    { label: string; action?: () => void; hint?: string; divider?: boolean }[]
  > = {
    File: [
      { label: "New from Template: Trap 140 BPM (WAV)", action: () => p.onNewFromTemplate("trap_140") },
      { label: "New from Template: Basic 808 Kit", action: () => p.onNewFromTemplate("basic_808") },
      { label: "New from Template: Empty Studio", action: () => p.onNewFromTemplate("empty"), divider: true },
      { label: "Open Project (.flp / .ql)…", action: p.onOpenFlp, hint: "Ctrl+O" },
      { label: "Save Project (.ql.json)", action: p.onSaveProject, hint: "Ctrl+S" },
      { label: "Export Pattern Mixdown as WAV (.wav)…", action: p.onExportWav, hint: "Ctrl+E" },
      { label: "Export Project State (.json)", action: p.onExportProject, hint: "Ctrl+R" },
    ],
    Edit: [
      { label: "Undo", action: p.canUndo ? p.onUndo : undefined, hint: "Ctrl+Z" },
      { label: "Redo", action: p.canRedo ? p.onRedo : undefined, hint: "Ctrl+Y", divider: true },
      { label: "Cut Active Pattern Steps", action: p.onCutSteps, hint: "Ctrl+X" },
      { label: "Copy Active Pattern Steps", action: p.onCopyPattern, hint: "Ctrl+C" },
      { label: "Paste Pattern Steps", action: p.onPastePattern, hint: "Ctrl+V", divider: true },
      { label: "Clear Active Pattern", action: p.onClearPattern },
    ],
    Add: [
      { label: "Manage VST3 & CLAP Plugins…", action: p.onOpenPluginManager, hint: "F8" },
      { label: "Add Audio Sampler Channel (.wav)", action: () => p.onAddGeneratorChannel("sampler") },
      { label: "Add Subtractive Synth Channel (PolyBLEP)", action: () => p.onAddGeneratorChannel("synth") },
      { label: "Add Sub-Bass / Automation Track", action: () => p.onAddGeneratorChannel("automation"), divider: true },
      { label: "Load .WAV Sample into Selected Channel…", action: p.onLoadWavIntoSelected },
    ],
    Patterns: [
      { label: "New Pattern", action: p.onNewPattern, hint: "F4" },
      { label: "Clone Selected Pattern", action: p.onClonePattern, hint: "Ctrl+Shift+C" },
      { label: "Split Pattern by Channel", action: p.onSplitByChannel, divider: true },
      { label: "Transpose Pattern +1 Octave (+12 st)", action: () => p.onTransposePattern(12) },
      { label: "Transpose Pattern -1 Octave (-12 st)", action: () => p.onTransposePattern(-12) },
    ],
    View: [
      { label: "Playlist Arrangement", action: () => p.onToggleWindow("playlist"), hint: "F5" },
      { label: "Channel Rack & Step Sequencer", action: () => p.onToggleWindow("rack"), hint: "F6" },
      { label: "Piano Roll Note Editor", action: () => p.onToggleWindow("pianoroll"), hint: "F7" },
      { label: "Browser / Sample Picker", action: () => p.onToggleWindow("browser"), hint: "Alt+F8" },
      { label: "64-Insert DAG Mixer", action: () => p.onToggleWindow("mixer"), hint: "F9", divider: true },
      { label: "Reset Floating Windows Layout", action: p.onResetLayout },
      { label: "Toggle Fullscreen Workstation", action: p.onToggleFullscreen, hint: "F11" },
    ],
    Options: [
      { label: `Audio Settings (${p.bufferSizeFrames} smp fixed buffer)…`, action: p.onOpenAudioSettings, hint: "F10", divider: true },
      { label: "Toggle Metronome", action: () => p.onUtilityToggle("metronome") },
      { label: "Toggle Typing Keyboard to Piano", action: () => p.onUtilityToggle("typingKeyboard") },
      { label: "Toggle Fullscreen Mode", action: p.onToggleFullscreen, hint: "F11" },
    ],
    Tools: [
      { label: "Tap Tempo", action: tapTempo },
      { label: "Fill Selected Channel: Every 2 Steps", action: () => p.onFillSelectedChannel(2) },
      { label: "Fill Selected Channel: Every 4 Steps", action: () => p.onFillSelectedChannel(4) },
      { label: "Render 2-Bar Mixdown to WAV…", action: p.onExportWav, hint: "Ctrl+E" },
    ],
    Help: [
      { label: "About Ql Studio (Zero-Allocation DSP & WAV Engine)", action: p.onOpenAboutModal },
      { label: "Audio Settings & Crackle-Free Buffer Guide", action: p.onOpenAudioSettings, hint: "F10" },
    ],
  };

  return (
    <header className="shrink-0 bg-fl-panel border-b border-black/80">
      {/* Menu strip */}
      <div className="h-6 flex items-center gap-0.5 px-2 border-b border-black/60 bg-[#1f2328] relative">
        <img src="/logo.svg" alt="QL Studio Logo" className="w-4 h-4 mr-1.5 drop-shadow-[0_0_6px_#ff8500]" />
        <span className="text-[11px] font-extrabold text-fl-orange mr-3 tracking-widest">QL STUDIO</span>
        {MENUS.map((m) => (
          <div key={m} className="relative">
            <button
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation();
                setOpenMenu((cur) => (cur === m ? null : m));
              }}
              className={`px-2 h-5 text-[11px] rounded-sm cursor-pointer ${
                openMenu === m ? "bg-fl-orange text-black font-semibold" : "text-fl-text hover:bg-white/10"
              }`}
            >
              {m.toUpperCase()}
            </button>
            {openMenu === m && (
              <div
                className="absolute left-0 top-6 z-[9999] min-w-[280px] bg-[#2a2f36] border border-black/80 rounded shadow-2xl py-1"
                onPointerDown={(e) => e.stopPropagation()}
              >
                {menuItems[m].map((it) => (
                  <React.Fragment key={it.label}>
                    <button
                      type="button"
                      disabled={!it.action}
                      onClick={() => {
                        it.action?.();
                        setOpenMenu(null);
                      }}
                      className="w-full flex justify-between items-center gap-4 px-3 py-1.5 text-[11px] text-left enabled:hover:bg-fl-orange enabled:hover:text-black disabled:text-fl-dim cursor-pointer disabled:cursor-default"
                    >
                      <span>{it.label}</span>
                      {it.hint && <span className="opacity-65 font-mono text-[10px]">{it.hint}</span>}
                    </button>
                    {it.divider && <div className="my-1 border-t border-black/50" />}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={p.onOpenPluginManager}
            title="Open VST3 / CLAP Plugin Manager (F8)"
            className="px-2 h-4.5 rounded bg-fl-deep fl-inset text-[10px] font-mono text-fl-amber hover:text-white cursor-pointer flex items-center gap-1 border border-black/40"
          >
            <Cpu size={10} /> PLUGINS
          </button>
          <button
            type="button"
            onClick={p.onOpenAudioSettings}
            title="Configure Hardware Audio Buffer & Input / Output Devices"
            className="px-2 h-4.5 rounded bg-fl-deep fl-inset text-[10px] font-mono text-fl-led hover:text-fl-amber cursor-pointer flex items-center gap-1"
          >
            <Settings size={10} /> {p.bufferSizeFrames} smp
          </button>
          <button
            type="button"
            onClick={p.onOpenAudioSettings}
            title={
              p.midiConnectedDevice
                ? `Hardware MIDI Controller: ${p.midiConnectedDevice} (Active)`
                : "Hardware MIDI: Click to connect physical USB MIDI keyboard or pad controller"
            }
            className="px-2 h-4.5 rounded bg-fl-deep fl-inset text-[10px] font-mono cursor-pointer flex items-center gap-1.5 hover:bg-white/5 transition-colors"
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{
                background: p.midiActivityActive
                  ? "#ffb300"
                  : p.midiConnectedDevice
                    ? "#00e676"
                    : "#555",
                boxShadow: p.midiActivityActive
                  ? "0 0 6px #ffb300"
                  : p.midiConnectedDevice
                    ? "0 0 4px #00e676"
                    : "none",
              }}
            />
            <span className={p.midiConnectedDevice ? "text-fl-amber" : "text-fl-dim"}>
              {p.midiConnectedDevice ? p.midiConnectedDevice : "NO MIDI"}
            </span>
          </button>
          <span className="text-[10px] text-fl-dim truncate max-w-[260px]">
            {p.projectTitle} · {p.nativeRuntime ? "Tauri Native DSP" : "WebAudio Preview"}
          </span>
          <button
            type="button"
            onClick={p.onToggleFullscreen}
            title="Toggle Fullscreen Workstation (F11)"
            className={`px-1.5 h-4.5 rounded text-[10px] font-semibold flex items-center gap-1 cursor-pointer fl-bevel ${
              p.isFullscreen ? "bg-fl-orange text-black" : "bg-fl-raised text-fl-text hover:bg-white/10"
            }`}
          >
            {p.isFullscreen ? <Minimize size={10} /> : <Maximize size={10} />}
            <span>F11</span>
          </button>
        </div>
      </div>

      {/* Toolbar row */}
      <div className="h-[54px] flex items-center gap-2.5 px-2 overflow-x-auto">
        {/* Quick file buttons */}
        <div className="flex gap-1 shrink-0">
          <ToolButton title="Open .flp Project (Ctrl+O)" onClick={p.onOpenFlp}>
            <FolderOpen size={14} />
          </ToolButton>
          <ToolButton title="Save Project (.ql.json) (Ctrl+S)" onClick={p.onSaveProject}>
            <Save size={14} />
          </ToolButton>
          <ToolButton title="Export WAV Mixdown (.wav) (Ctrl+E)" onClick={p.onExportWav}>
            <FileAudio size={14} />
          </ToolButton>
          <ToolButton title="Export Project JSON" onClick={p.onExportProject}>
            <FileDown size={14} />
          </ToolButton>
        </div>

        {/* Master section */}
        <div className="flex items-center gap-2 px-2 py-1 rounded bg-fl-deep/60 fl-inset shrink-0">
          <div className="flex flex-col items-center">
            <Knob
              value={p.masterVolumeDb}
              min={-60}
              max={6}
              defaultValue={0}
              size={28}
              title="Master volume"
              format={formatDb}
              onChange={p.onMasterVolumeChange}
            />
            <span className="text-[8px] text-fl-dim">VOL</span>
          </div>
          <div className="flex flex-col items-center">
            <Knob
              value={p.masterPitchCents}
              min={-1200}
              max={1200}
              defaultValue={0}
              size={28}
              bipolar
              color="#38bdf8"
              title="Master pitch (cents)"
              format={(v) => `${v >= 0 ? "+" : ""}${Math.round(v)} ct`}
              onChange={(v) => p.onMasterPitchChange(Math.round(v))}
            />
            <span className="text-[8px] text-fl-dim">PITCH</span>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex flex-col gap-0.5">
            {(["pattern", "song"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => p.onModeChange(m)}
                className="flex items-center gap-1 text-[9px] font-bold cursor-pointer"
                title={m === "pattern" ? "Pattern mode (L)" : "Song mode (L)"}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    background: p.mode === m ? (m === "pattern" ? "#ff8500" : "#00e676") : "#2a2e34",
                    boxShadow: p.mode === m ? `0 0 5px ${m === "pattern" ? "#ff8500" : "#00e676"}` : undefined,
                  }}
                />
                <span className={p.mode === m ? "text-fl-text" : "text-fl-dim"}>
                  {m === "pattern" ? "PAT" : "SONG"}
                </span>
              </button>
            ))}
          </div>
          <ToolButton
            title="Play / Pause (Space)"
            active={p.isPlaying}
            glow="#00e676"
            onClick={p.onPlayPause}
            className="h-9 w-10"
          >
            {p.isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </ToolButton>
          <ToolButton title="Stop" onClick={p.onStop} className="h-9 w-10">
            <Square size={14} fill="currentColor" />
          </ToolButton>
          <ToolButton
            title="Record Armed Toggle"
            active={p.isRecording}
            glow="#ff3d3d"
            onClick={p.onRecord}
            className="h-9 w-10"
          >
            <Circle size={14} fill="currentColor" className={p.isRecording ? "" : "text-red-400"} />
          </ToolButton>
        </div>

        {/* Song position LCD */}
        <div className="fl-lcd fl-inset rounded px-2.5 py-1 flex flex-col items-end min-w-[108px] shrink-0">
          <span className="text-[8px] tracking-widest text-fl-dim [text-shadow:none]">BAR : BEAT : TICK</span>
          <span className="text-[17px] leading-none font-bold tracking-wider">
            {String(bar).padStart(3, "0")}:{String(beat).padStart(2, "0")}:{String(tick).padStart(2, "0")}
          </span>
        </div>

        {/* Tempo LCD */}
        <div
          className="fl-lcd fl-inset rounded px-2.5 py-1 flex flex-col items-end min-w-[92px] cursor-ns-resize shrink-0"
          title="Drag vertically (Shift = fine), wheel, double-click to type, right-click to tap tempo"
          onPointerDown={(e) => {
            if (editingBpm || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            bpmDrag.current = { y: e.clientY, v: p.bpm };
          }}
          onPointerMove={(e) => {
            if (!bpmDrag.current) return;
            const sens = e.shiftKey ? 0.05 : 0.5;
            p.onBpmChange(
              Math.min(522, Math.max(10, Number((bpmDrag.current.v + (bpmDrag.current.y - e.clientY) * sens).toFixed(2)))),
            );
          }}
          onPointerUp={() => {
            bpmDrag.current = null;
          }}
          onWheel={(e) => {
            const step = e.shiftKey ? 0.1 : 1;
            p.onBpmChange(Math.min(522, Math.max(10, Number((p.bpm + (e.deltaY < 0 ? step : -step)).toFixed(2)))));
          }}
          onDoubleClick={() => {
            setBpmDraft(p.bpm.toFixed(3));
            setEditingBpm(true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            tapTempo();
          }}
        >
          <span className="text-[8px] tracking-widest text-fl-dim [text-shadow:none]">TEMPO</span>
          {editingBpm ? (
            <input
              autoFocus
              value={bpmDraft}
              onChange={(e) => setBpmDraft(e.target.value)}
              onBlur={() => commitBpm(bpmDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitBpm(bpmDraft);
                if (e.key === "Escape") setEditingBpm(false);
              }}
              className="w-[72px] bg-transparent text-right text-[17px] leading-none font-bold outline-none text-fl-amber"
            />
          ) : (
            <span className="text-[17px] leading-none font-bold">{p.bpm.toFixed(3)}</span>
          )}
        </div>
        <ToolButton title="Tap tempo" onClick={tapTempo}>
          <Footprints size={13} />
        </ToolButton>

        {/* Utility switches */}
        <div className="flex gap-1 shrink-0">
          <ToolButton title="Metronome" active={p.utilities.metronome} onClick={() => p.onUtilityToggle("metronome")}>
            <Timer size={13} />
          </ToolButton>
          <ToolButton
            title="Typing keyboard to piano"
            active={p.utilities.typingKeyboard}
            onClick={() => p.onUtilityToggle("typingKeyboard")}
          >
            <Keyboard size={13} />
          </ToolButton>
          <ToolButton
            title="3-2-1 countdown before recording"
            active={p.utilities.countdown}
            onClick={() => p.onUtilityToggle("countdown")}
          >
            <Clock3 size={13} />
          </ToolButton>
          <ToolButton
            title="Loop recording"
            active={p.utilities.loopRecord}
            onClick={() => p.onUtilityToggle("loopRecord")}
          >
            <Repeat size={13} />
          </ToolButton>
          <ToolButton
            title="Step edit mode"
            active={p.utilities.stepEdit}
            onClick={() => p.onUtilityToggle("stepEdit")}
          >
            <ListMusic size={13} />
          </ToolButton>
        </div>

        {/* Window toggles */}
        <div className="flex gap-1 shrink-0">
          <ToolButton
            title="Browser (Alt+F8)"
            active={p.windowsOpen.browser}
            glow="#38bdf8"
            onClick={() => p.onToggleWindow("browser")}
          >
            <PanelLeft size={13} />
          </ToolButton>
          <ToolButton
            title="Channel Rack (F6)"
            active={p.windowsOpen.rack}
            glow="#38bdf8"
            onClick={() => p.onToggleWindow("rack")}
          >
            <LayoutGrid size={13} />
          </ToolButton>
          <ToolButton
            title="Piano Roll (F7)"
            active={p.windowsOpen.pianoroll}
            glow="#38bdf8"
            onClick={() => p.onToggleWindow("pianoroll")}
          >
            <Piano size={13} />
          </ToolButton>
          <ToolButton
            title="Playlist Arrangement (F5)"
            active={p.windowsOpen.playlist}
            glow="#38bdf8"
            onClick={() => p.onToggleWindow("playlist")}
          >
            <Columns3 size={13} />
          </ToolButton>
          <ToolButton
            title="Mixer (F9)"
            active={p.windowsOpen.mixer}
            glow="#38bdf8"
            onClick={() => p.onToggleWindow("mixer")}
          >
            <SlidersHorizontal size={13} />
          </ToolButton>
          <ToolButton
            title="Audio Settings (F10)"
            active={false}
            glow="#ff8500"
            onClick={p.onOpenAudioSettings}
          >
            <Settings size={13} />
          </ToolButton>
        </div>

        {/* Monitor & system rack */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <PeakMeter left={p.meterL} right={p.meterR} width={110} height={14} orientation="horizontal" />
          <canvas ref={scopeRef} width={110} height={38} className="rounded fl-inset" />
          <div className="fl-inset rounded bg-fl-deep px-2 py-1 text-[9px] leading-tight font-mono min-w-[112px]">
            <div
              className="flex items-center gap-1 text-fl-dim"
              title="Main-thread UI frame load estimate; native audio callback runs zero-allocation on a dedicated thread."
            >
              <Gauge size={10} /> UI
              <div className="flex-1 h-1.5 bg-black/60 rounded-sm overflow-hidden">
                <div
                  className="h-full"
                  style={{
                    width: `${p.stats.uiLoadPercent}%`,
                    background:
                      p.stats.uiLoadPercent > 75
                        ? "#ff3d3d"
                        : p.stats.uiLoadPercent > 45
                          ? "#ffb300"
                          : "#00e676",
                  }}
                />
              </div>
              <span className="text-fl-text">{p.stats.uiLoadPercent.toFixed(0)}%</span>
            </div>
            <div className="text-fl-dim">
              MEM{" "}
              <span className="text-fl-text">
                {p.stats.memoryMb === null ? "n/a" : `${p.stats.memoryMb.toFixed(0)} MB`}
              </span>
            </div>
            <div className="text-fl-dim flex items-center gap-1">
              <Music2 size={9} /> Poly{" "}
              <span className="text-fl-amber">
                {p.stats.polyphony} / {p.stats.maxPolyphony}
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
});
Toolbar.displayName = "Toolbar";
