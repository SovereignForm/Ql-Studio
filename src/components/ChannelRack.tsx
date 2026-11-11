/**
 * FL-style Channel Rack: channel strips with LED mute, pan/volume knobs, color-coded channel
 * buttons with context menu, mixer-target LCD, skeuomorphic 4-step-grouped grid, and a
 * Graph Editor drawer (velocity / pan / pitch) aligned under the steps of the selected channel.
 */
import { Activity, ChevronDown, FolderOpen, Plus, Sliders, Volume2, Waves, X, Zap } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import type { QlChannel, QlPattern, QlStep, WaveformShape } from "../schemas.ts";
import { Knob, Led, formatDb, formatPan } from "../ui/primitives.tsx";
import { BROWSER_DRAG_MIME, type BrowserItem } from "./BrowserSidebar.tsx";

export type ChannelPatch = Partial<
  Pick<
    QlChannel,
    | "muted"
    | "solo"
    | "pan"
    | "volumeDb"
    | "assignedMixerInsert"
    | "name"
    | "colorHex"
    | "sampleSlot"
    | "samplePath"
    | "waveform"
    | "rootMidiNote"
    | "pitchSemitones"
  >
>;
export type ChannelAction =
  | "rename"
  | "color"
  | "clone"
  | "delete"
  | "load_wav"
  | "synth_settings"
  | "fill_2"
  | "fill_4"
  | "clear_steps";
type GraphParam = "velocity" | "pan" | "pitch";

export const CHANNEL_COLORS: readonly `#${string}`[] = [
  "#ff6b35", "#00b4d8", "#fee440", "#9b5de5", "#06d6a0", "#f15bb5", "#3a86ff", "#8ac926",
];

export const EMPTY_STEP: QlStep = {
  active: false,
  velocity: 100,
  finePan: 0,
  pitchOffsetSemitones: 0,
  finePitchCents: 0,
  gateRatio: 0.8,
  shiftTicks: 0,
};

/* ------------------------------ Header ------------------------------ */
export const ChannelRackHeader: React.FC<{
  readonly patterns: readonly QlPattern[];
  readonly activePatternId: string;
  readonly stepCount: number;
  readonly onSelectPattern: (id: string) => void;
  readonly onNewPattern: () => void;
  readonly onStepCountChange: (n: number) => void;
}> = React.memo(({ patterns, activePatternId, stepCount, onSelectPattern, onNewPattern, onStepCountChange }) => (
  <>
    <div className="relative">
      <select
        value={activePatternId}
        onChange={(e) => onSelectPattern(e.target.value)}
        className="appearance-none h-[18px] pl-2 pr-5 text-[10px] rounded-sm bg-fl-deep fl-inset text-fl-amber outline-none cursor-pointer"
      >
        {patterns.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <ChevronDown size={10} className="absolute right-1 top-1 text-fl-dim pointer-events-none" />
    </div>
    <button
      type="button"
      title="New pattern"
      onClick={onNewPattern}
      className="h-[18px] w-[18px] grid place-items-center rounded-sm bg-fl-raised fl-bevel cursor-pointer hover:brightness-125"
    >
      <Plus size={11} />
    </button>
    <div className="flex items-center gap-0.5 ml-1">
      {[16, 32, 64].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onStepCountChange(n)}
          className={`h-[18px] px-1.5 text-[10px] rounded-sm fl-bevel cursor-pointer ${
            stepCount === n ? "bg-fl-orange text-black font-bold" : "bg-fl-raised text-fl-dim hover:text-fl-text"
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  </>
));
ChannelRackHeader.displayName = "ChannelRackHeader";

/* ------------------------------ Rack ------------------------------ */
export interface ChannelRackProps {
  readonly pattern: QlPattern;
  readonly channels: readonly QlChannel[];
  readonly activeStep: number;
  readonly isPlaying: boolean;
  readonly selectedChannelId: string;
  readonly onSelectChannel: (id: string) => void;
  readonly onUpdateStep: (channelId: string, stepIndex: number, patch: Partial<QlStep>) => void;
  readonly onUpdateChannel: (channelId: string, patch: ChannelPatch) => void;
  readonly onChannelAction: (channelId: string, action: ChannelAction) => void;
  readonly onReplaceGenerator: (channelId: string, item: BrowserItem) => void;
  readonly onDropWavPath?: (channelId: string, path: string) => void;
  readonly onAddChannel: () => void;
  readonly onAuditionChannel?: (channelId: string, midiNote?: number) => void;
}

const STEP_W = 22;

export const ChannelRack: React.FC<ChannelRackProps> = React.memo(({
  pattern,
  channels,
  activeStep,
  isPlaying,
  selectedChannelId,
  onSelectChannel,
  onUpdateStep,
  onUpdateChannel,
  onChannelAction,
  onReplaceGenerator,
  onDropWavPath,
  onAddChannel,
  onAuditionChannel,
}) => {
  const [graphOpen, setGraphOpen] = useState(true);
  const [graphParam, setGraphParam] = useState<GraphParam>("velocity");
  const [menu, setMenu] = useState<{ channelId: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [synthModalChannelId, setSynthModalChannelId] = useState<string | null>(null);
  const paintRef = useRef<{ channelId: string; value: boolean } | null>(null);

  useEffect(() => {
    const close = () => setMenu(null);
    const endPaint = () => {
      paintRef.current = null;
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("pointerup", endPaint);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("pointerup", endPaint);
    };
  }, []);

  const stepsOf = (id: string): readonly QlStep[] => {
    const s = pattern.channelData[id]?.steps ?? [];
    return Array.from({ length: pattern.stepCount }, (_, i) => s[i] ?? EMPTY_STEP);
  };

  const selected = channels.find((c) => c.id === selectedChannelId) ?? channels[0];

  return (
    <div className="flex flex-col h-full bg-fl-panel relative">
      <div className="flex-1 overflow-auto fl-scroll p-1.5">
        <div className="inline-flex flex-col gap-[3px] min-w-full">
          {channels.map((ch) => {
            const steps = stepsOf(ch.id);
            const isSel = ch.id === selected?.id;
            return (
              <div
                key={ch.id}
                onDragOver={(e) => {
                  if (
                    e.dataTransfer.types.includes(BROWSER_DRAG_MIME) ||
                    e.dataTransfer.types.includes("Files")
                  ) {
                    e.preventDefault();
                    setDropTarget(ch.id);
                  }
                }}
                onDragLeave={() => setDropTarget((d) => (d === ch.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  const raw = e.dataTransfer.getData(BROWSER_DRAG_MIME);
                  if (raw) {
                    onReplaceGenerator(ch.id, JSON.parse(raw) as BrowserItem);
                    return;
                  }
                  const file = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
                  if (file && onDropWavPath) {
                    onDropWavPath(ch.id, file.path ?? file.name);
                  }
                }}
                className={`flex items-center gap-1.5 h-[30px] pl-1 pr-1.5 rounded-[3px] border fl-bevel ${
                  dropTarget === ch.id
                    ? "border-fl-orange bg-fl-orange/15"
                    : isSel
                      ? "border-white/15 bg-[#323943]"
                      : "border-black/60 bg-fl-raised"
                }`}
              >
                <Led
                  on={!ch.muted}
                  color="#25d366"
                  title={ch.muted ? "Unmute (left-click)" : "Mute (left-click)"}
                  onClick={() => onUpdateChannel(ch.id, { muted: !ch.muted })}
                />
                <button
                  type="button"
                  title="Solo"
                  onClick={() => onUpdateChannel(ch.id, { solo: !ch.solo })}
                  className={`w-4 h-4 text-[9px] font-black rounded-sm border border-black/60 cursor-pointer ${
                    ch.solo ? "bg-fl-amber text-black shadow-[0_0_6px_#ffb300]" : "bg-fl-deep text-fl-dim"
                  }`}
                >
                  S
                </button>
                <Knob
                  value={ch.pan}
                  min={-1}
                  max={1}
                  defaultValue={0}
                  size={22}
                  bipolar
                  color="#38bdf8"
                  title="Pan"
                  format={formatPan}
                  onChange={(v) => onUpdateChannel(ch.id, { pan: Number(v.toFixed(3)) })}
                />
                <Knob
                  value={Math.max(-60, ch.volumeDb)}
                  min={-60}
                  max={6}
                  defaultValue={0}
                  size={22}
                  title="Volume"
                  format={formatDb}
                  onChange={(v) => onUpdateChannel(ch.id, { volumeDb: v <= -59.5 ? -96 : Number(v.toFixed(2)) })}
                />
                <MixerTargetLcd
                  value={ch.assignedMixerInsert}
                  onChange={(v) => onUpdateChannel(ch.id, { assignedMixerInsert: v })}
                />
                <button
                  type="button"
                  onClick={() => {
                    onSelectChannel(ch.id);
                    onAuditionChannel?.(ch.id);
                  }}
                  onDoubleClick={() => setSynthModalChannelId(ch.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSelectChannel(ch.id);
                    setMenu({ channelId: ch.id, x: e.clientX, y: e.clientY });
                  }}
                  title="Click: audition · Double-click: Open Synth & ADSR Editor · Right-click: channel menu"
                  className="w-[132px] h-[22px] shrink-0 flex items-center rounded-[3px] overflow-hidden border border-black/70 fl-bevel cursor-pointer"
                  style={{
                    background: `linear-gradient(180deg, ${ch.colorHex}55, ${ch.colorHex}22)`,
                  }}
                >
                  <span className="w-1.5 h-full shrink-0" style={{ background: ch.colorHex }} />
                  <span className={`px-1.5 text-[11px] truncate flex-1 text-left ${isSel ? "text-white font-semibold" : "text-fl-text"}`}>
                    {ch.name}
                  </span>
                  {ch.sampleSlot !== undefined && (
                    <span className="mr-1 px-1 py-0.2 rounded text-[8px] font-bold bg-black/50 text-fl-led">
                      WAV
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  title="Channel Synth & ADSR Envelope Inspector"
                  onClick={() => setSynthModalChannelId(ch.id)}
                  className="w-[18px] h-[22px] grid place-items-center rounded-[2px] bg-fl-deep hover:bg-fl-orange hover:text-black text-fl-dim border border-black/60 cursor-pointer shrink-0"
                >
                  <Activity size={10} />
                </button>
                <button
                  type="button"
                  title="Load .wav sample from disk (hound)"
                  onClick={() => onChannelAction(ch.id, "load_wav")}
                  className="w-[18px] h-[22px] grid place-items-center rounded-[2px] bg-fl-deep hover:bg-fl-orange hover:text-black text-fl-dim border border-black/60 cursor-pointer shrink-0"
                >
                  <FolderOpen size={10} />
                </button>

                {/* Step grid */}
                <div className="flex items-center gap-[3px] ml-1">
                  {steps.map((st, i) => {
                    const wine = Math.floor(i / 4) % 2 === 1;
                    const playhead = isPlaying && i === activeStep;
                    return (
                      <div
                        key={i}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          const value = e.button === 2 ? false : !st.active;
                          paintRef.current = { channelId: ch.id, value };
                          onUpdateStep(ch.id, i, { active: value });
                          if (value) {
                            onAuditionChannel?.(ch.id);
                          }
                        }}
                        onPointerEnter={() => {
                          const p = paintRef.current;
                          if (p && p.channelId === ch.id && st.active !== p.value) {
                            onUpdateStep(ch.id, i, { active: p.value });
                            if (p.value) {
                              onAuditionChannel?.(ch.id);
                            }
                          }
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                        title={`Step ${i + 1} · vel ${st.velocity}`}
                        className={`relative h-[22px] rounded-[3px] border border-black/70 cursor-pointer ${
                          i % 4 === 0 && i > 0 ? "ml-[5px]" : ""
                        } ${st.active ? "fl-step-on" : "fl-step"} ${playhead ? "outline outline-1 outline-white/70" : ""}`}
                        style={{
                          width: STEP_W,
                          backgroundColor: st.active ? undefined : wine ? "#543d46" : "#434952",
                          filter: playhead && !st.active ? "brightness(1.45)" : undefined,
                        }}
                      >
                        {/* center LED slit */}
                        <span
                          className="absolute left-1/2 -translate-x-1/2 top-[4px] h-[3px] w-[10px] rounded-full"
                          style={{
                            background: st.active ? "#fff6e0" : "#1a1c20",
                            boxShadow: st.active ? "0 0 5px #fff1c4" : "inset 0 1px 1px rgba(0,0,0,0.8)",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onAddChannel}
            className="self-start mt-1 ml-1 h-6 px-3 flex items-center gap-1 text-[11px] rounded-[3px] bg-fl-raised fl-bevel border border-black/60 text-fl-dim hover:text-fl-text cursor-pointer"
          >
            <Plus size={12} /> Add channel
          </button>
        </div>
      </div>

      {/* Graph editor drawer */}
      <div className="shrink-0 border-t border-black/80 bg-[#1e2227]">
        <div className="h-6 flex items-center gap-2 px-2">
          <button
            type="button"
            onClick={() => setGraphOpen((o) => !o)}
            className="text-[10px] font-semibold text-fl-text flex items-center gap-1 cursor-pointer"
          >
            <ChevronDown size={11} className={graphOpen ? "" : "-rotate-90"} /> Graph editor
          </button>
          <select
            value={graphParam}
            onChange={(e) => setGraphParam(e.target.value as GraphParam)}
            className="h-[18px] text-[10px] bg-fl-deep fl-inset rounded-sm text-fl-amber px-1 outline-none cursor-pointer"
          >
            <option value="velocity">Note velocity</option>
            <option value="pan">Note pan</option>
            <option value="pitch">Note pitch (±24 st)</option>
          </select>
          <span className="text-[10px] text-fl-dim truncate">
            {selected ? selected.name : "—"} · click/drag bars · double-click resets
          </span>
        </div>
        {graphOpen && selected && (
          <GraphEditor
            steps={stepsOf(selected.id)}
            param={graphParam}
            color={selected.colorHex}
            onEdit={(i, patch) => onUpdateStep(selected.id, i, patch)}
          />
        )}
      </div>

      {menu && (
        <div
          className="fixed z-[9999] min-w-[175px] py-1 bg-[#2a2f36] border border-black/80 rounded shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {(
            [
              ["synth_settings", "Channel Synth & ADSR..."],
              ["load_wav", "Load sample (.wav)..."],
              ["fill_2", "Fill each 2 steps"],
              ["fill_4", "Fill each 4 steps"],
              ["clear_steps", "Clear channel steps"],
              ["rename", "Rename channel..."],
              ["color", "Change color"],
              ["clone", "Clone channel"],
              ["delete", "Delete channel"],
            ] as const
          ).map(([actionKey, label]) => (
            <button
              key={actionKey}
              type="button"
              onClick={() => {
                if (actionKey === "synth_settings") {
                  setSynthModalChannelId(menu.channelId);
                } else {
                  onChannelAction(menu.channelId, actionKey);
                }
                setMenu(null);
              }}
              className="w-full text-left px-3 py-1 text-[11px] hover:bg-fl-orange hover:text-black cursor-pointer"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {synthModalChannelId && (
        <ChannelSynthModal
          channel={channels.find((c) => c.id === synthModalChannelId) ?? channels[0]!}
          onClose={() => setSynthModalChannelId(null)}
          onUpdateChannel={onUpdateChannel}
          onAuditionChannel={onAuditionChannel}
        />
      )}
    </div>
  );
});
ChannelRack.displayName = "ChannelRack";

/* Mixer target LCD: vertical drag or wheel, "---" = master. */
const MixerTargetLcd: React.FC<{ readonly value: number; readonly onChange: (v: number) => void }> = ({ value, onChange }) => {
  const drag = useRef<{ y: number; v: number } | null>(null);
  return (
    <div
      title="Target mixer insert (drag / wheel). --- = Master"
      className="fl-lcd fl-inset w-[30px] h-[18px] grid place-items-center rounded-sm text-[10px] cursor-ns-resize shrink-0"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onChange(Math.min(64, Math.max(0, Math.round(drag.current.v + (drag.current.y - e.clientY) / 6))));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onWheel={(e) => onChange(Math.min(64, Math.max(0, value + (e.deltaY < 0 ? 1 : -1))))}
    >
      {value === 0 ? "---" : value}
    </div>
  );
};

/* Graph editor: one bar per step, aligned to the step grid columns. */
const GraphEditor: React.FC<{
  readonly steps: readonly QlStep[];
  readonly param: GraphParam;
  readonly color: string;
  readonly onEdit: (i: number, patch: Partial<QlStep>) => void;
}> = ({ steps, param, color, onEdit }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const drawing = useRef(false);
  const H = 72;

  const norm = (s: QlStep): number =>
    param === "velocity" ? s.velocity / 127 : param === "pan" ? (s.finePan + 1) / 2 : (s.pitchOffsetSemitones + 24) / 48;

  const apply = (clientX: number, clientY: number) => {
    const host = ref.current;
    if (!host) return;
    const cells = Array.from(host.querySelectorAll<HTMLElement>("[data-step]"));
    const cell = cells.find((c) => {
      const r = c.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right;
    });
    if (!cell) return;
    const i = Number(cell.dataset.step);
    const r = cell.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
    if (param === "velocity") onEdit(i, { velocity: Math.max(1, Math.round(t * 127)) });
    else if (param === "pan") onEdit(i, { finePan: Number((t * 2 - 1).toFixed(2)) });
    else onEdit(i, { pitchOffsetSemitones: Math.round(t * 48 - 24) });
  };

  return (
    <div
      ref={ref}
      className="flex items-end gap-[3px] px-1.5 pb-1.5 overflow-x-auto fl-scroll"
      /* Aligns bars with step columns: rack padding + row border/padding + LED, S, 2 knobs, LCD, name, gaps. */
      style={{ paddingLeft: 6 + 1 + 4 + 11 + 6 + 16 + 6 + 22 + 6 + 22 + 6 + 30 + 6 + 132 + 6 + 18 + 6 + 4 }}
      onPointerDown={(e) => {
        drawing.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => drawing.current && apply(e.clientX, e.clientY)}
      onPointerUp={() => {
        drawing.current = false;
      }}
    >
      {steps.map((s, i) => {
        const n = norm(s);
        const bipolar = param !== "velocity";
        return (
          <div
            key={i}
            data-step={i}
            onDoubleClick={() =>
              onEdit(i, param === "velocity" ? { velocity: 100 } : param === "pan" ? { finePan: 0 } : { pitchOffsetSemitones: 0 })
            }
            className={`relative bg-fl-deep fl-inset rounded-[2px] cursor-ns-resize ${i % 4 === 0 && i > 0 ? "ml-[5px]" : ""}`}
            style={{ width: STEP_W, height: H, opacity: s.active ? 1 : 0.45 }}
            title={`Step ${i + 1}`}
          >
            {bipolar && <div className="absolute left-0 right-0 top-1/2 h-px bg-white/15" />}
            <div
              className="absolute left-[3px] right-[3px] rounded-t-[1px]"
              style={
                bipolar
                  ? {
                      background: color,
                      top: n >= 0.5 ? `${(1 - n) * 100}%` : "50%",
                      height: `${Math.abs(n - 0.5) * 100}%`,
                      minHeight: 1,
                    }
                  : { background: `linear-gradient(0deg, ${color}aa, ${color})`, bottom: 0, height: `${n * 100}%` }
              }
            />
          </div>
        );
      })}
    </div>
  );
};

const ChannelSynthModal: React.FC<{
  readonly channel: QlChannel;
  readonly onClose: () => void;
  readonly onUpdateChannel: (id: string, patch: ChannelPatch) => void;
  readonly onAuditionChannel?: (id: string, note?: number) => void;
}> = ({ channel, onClose, onUpdateChannel, onAuditionChannel }) => {
  const [attackMs, setAttackMs] = useState(15);
  const [decayMs, setDecayMs] = useState(180);
  const [sustain, setSustain] = useState(0.65);
  const [releaseMs, setReleaseMs] = useState(320);

  const [cutoffHz, setCutoffHz] = useState(2500);
  const [resonanceQ, setResonanceQ] = useState(2.8);
  const [filterType, setFilterType] = useState<"lowpass" | "bandpass" | "highpass">("lowpass");
  const [fmDepth, setFmDepth] = useState(0.2);

  const waveforms: readonly { shape: WaveformShape; label: string }[] = [
    { shape: "sawtooth", label: "Sawtooth" },
    { shape: "pulse", label: "Square / Pulse" },
    { shape: "sine", label: "Sine" },
    { shape: "triangle", label: "Triangle" },
    { shape: "noise", label: "White Noise" },
    { shape: "sampler_pcm", label: "PCM / 808 WAV" },
  ];

  const presets = [
    {
      name: "808 Deep Sub Bass",
      waveform: "sawtooth" as WaveformShape,
      attack: 5,
      decay: 450,
      sustain: 0.1,
      release: 250,
      cutoff: 220,
      res: 4.2,
      fm: 0.05,
      vol: 2.0,
      pitch: -12,
    },
    {
      name: "Acid 303 Resonance Lead",
      waveform: "sawtooth" as WaveformShape,
      attack: 10,
      decay: 260,
      sustain: 0.4,
      release: 180,
      cutoff: 1400,
      res: 8.5,
      fm: 0.35,
      vol: 0.0,
      pitch: 0,
    },
    {
      name: "Lush Poly FM Pad",
      waveform: "sine" as WaveformShape,
      attack: 180,
      decay: 600,
      sustain: 0.85,
      release: 800,
      cutoff: 4200,
      res: 1.8,
      fm: 0.80,
      vol: -1.5,
      pitch: 0,
    },
    {
      name: "Punchy Club Kick",
      waveform: "sine" as WaveformShape,
      attack: 2,
      decay: 140,
      sustain: 0.0,
      release: 80,
      cutoff: 650,
      res: 1.2,
      fm: 0.0,
      vol: 3.0,
      pitch: -12,
    },
    {
      name: "Analog Chiptune Pluck",
      waveform: "pulse" as WaveformShape,
      attack: 2,
      decay: 95,
      sustain: 0.05,
      release: 120,
      cutoff: 7500,
      res: 3.2,
      fm: 0.1,
      vol: -2.0,
      pitch: 12,
    },
  ];

  const applyPreset = (p: typeof presets[number]) => {
    setAttackMs(p.attack);
    setDecayMs(p.decay);
    setSustain(p.sustain);
    setReleaseMs(p.release);
    setCutoffHz(p.cutoff);
    setResonanceQ(p.res);
    setFmDepth(p.fm);
    onUpdateChannel(channel.id, {
      waveform: p.waveform,
      volumeDb: p.vol,
      pitchSemitones: p.pitch,
    });
    onAuditionChannel?.(channel.id, 60 + p.pitch);
  };

  const svgW = 280;
  const svgH = 90;
  const totalMs = attackMs + decayMs + 400 + releaseMs;
  const aX = (attackMs / totalMs) * svgW;
  const dX = aX + (decayMs / totalMs) * svgW;
  const sX = dX + (400 / totalMs) * svgW;
  const rX = svgW;
  const sY = (1.0 - sustain) * (svgH - 14) + 6;

  const adsrPath = `M 0 ${svgH} L ${aX} 6 L ${dX} ${sY} L ${sX} ${sY} L ${rX} ${svgH}`;
  const adsrArea = `${adsrPath} Z`;

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#1e222a] border border-fl-orange/70 rounded-lg w-full max-w-xl shadow-2xl overflow-hidden flex flex-col fl-bevel">
        <div className="h-9 px-3 bg-gradient-to-r from-[#292f3a] to-[#20252e] border-b border-black/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Waves size={15} className="text-fl-orange animate-pulse" />
            <span className="font-bold text-[12px] text-white">
              CHANNEL SYNTHESIS & ADSR ENVELOPE —{" "}
              <span className="text-fl-orange font-mono">{channel.name}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-fl-dim hover:text-white p-1 rounded hover:bg-white/10 cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[85vh] overflow-y-auto fl-scroll text-[11px]">
          <div className="flex flex-col gap-1.5 bg-[#171a21] p-2.5 rounded border border-black/60 fl-inset">
            <span className="text-[10px] font-bold text-fl-dim flex items-center gap-1">
              <Zap size={11} className="text-fl-amber" />
              QUICK SYNTH & BASS PRESETS
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {presets.map((pre) => (
                <button
                  key={pre.name}
                  type="button"
                  onClick={() => applyPreset(pre)}
                  className="px-2 py-1.5 rounded bg-fl-raised hover:bg-fl-orange hover:text-black border border-black/70 fl-bevel text-[10px] font-semibold text-fl-text flex items-center justify-between cursor-pointer transition-colors"
                >
                  <span className="truncate">{pre.name}</span>
                  <span className="text-[8px] font-mono opacity-70">
                    {pre.waveform.slice(0, 3).toUpperCase()}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-3 rounded bg-fl-deep border border-black/60 fl-inset flex flex-col gap-2.5">
              <div className="flex justify-between items-center">
                <span className="font-bold text-fl-orange flex items-center gap-1.5 text-[11px]">
                  <Activity size={13} />
                  ADSR VOLUME ENVELOPE
                </span>
                <span className="font-mono text-[9px] text-fl-dim">
                  A:{attackMs}ms · D:{decayMs}ms · S:{(sustain * 100).toFixed(0)}% · R:{releaseMs}ms
                </span>
              </div>

              <div className="w-full h-[90px] bg-[#121418] rounded border border-black/80 overflow-hidden relative shadow-inner">
                <svg className="w-full h-full" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="adsr_gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff8500" stopOpacity="0.45" />
                      <stop offset="100%" stopColor="#ff3c00" stopOpacity="0.05" />
                    </linearGradient>
                  </defs>
                  <path d={adsrArea} fill="url(#adsr_gradient)" />
                  <path
                    d={adsrPath}
                    fill="none"
                    stroke="#ff8500"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx={aX} cy={6} r={3.5} fill="#ffffff" stroke="#ff8500" strokeWidth="1.5" />
                  <circle cx={dX} cy={sY} r={3.5} fill="#ffffff" stroke="#ff8500" strokeWidth="1.5" />
                  <circle cx={sX} cy={sY} r={3.5} fill="#ffffff" stroke="#ff8500" strokeWidth="1.5" />
                </svg>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center text-[10px]">
                <div className="flex flex-col gap-1">
                  <span className="text-fl-dim font-bold">ATTACK</span>
                  <input
                    type="range"
                    min="1"
                    max="1000"
                    value={attackMs}
                    onChange={(e) => setAttackMs(Number(e.target.value))}
                    className="accent-fl-orange cursor-pointer"
                  />
                  <span className="font-mono text-[9px] text-fl-amber">{attackMs}ms</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-fl-dim font-bold">DECAY</span>
                  <input
                    type="range"
                    min="10"
                    max="1500"
                    value={decayMs}
                    onChange={(e) => setDecayMs(Number(e.target.value))}
                    className="accent-fl-orange cursor-pointer"
                  />
                  <span className="font-mono text-[9px] text-fl-amber">{decayMs}ms</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-fl-dim font-bold">SUSTAIN</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={sustain}
                    onChange={(e) => setSustain(Number(e.target.value))}
                    className="accent-fl-orange cursor-pointer"
                  />
                  <span className="font-mono text-[9px] text-fl-amber">
                    {(sustain * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-fl-dim font-bold">RELEASE</span>
                  <input
                    type="range"
                    min="10"
                    max="2500"
                    value={releaseMs}
                    onChange={(e) => setReleaseMs(Number(e.target.value))}
                    className="accent-fl-orange cursor-pointer"
                  />
                  <span className="font-mono text-[9px] text-fl-amber">{releaseMs}ms</span>
                </div>
              </div>
            </div>

            <div className="p-3 rounded bg-fl-deep border border-black/60 fl-inset flex flex-col gap-3">
              <span className="font-bold text-fl-orange flex items-center gap-1.5 text-[11px]">
                <Sliders size={13} />
                RESONANT MOOG FILTER & FM MODULATION
              </span>

              <div className="space-y-2">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-fl-text font-semibold">Cutoff Frequency:</span>
                  <span className="font-mono text-fl-amber font-bold">{cutoffHz} Hz</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="18000"
                  step="20"
                  value={cutoffHz}
                  onChange={(e) => setCutoffHz(Number(e.target.value))}
                  className="w-full accent-fl-orange cursor-pointer"
                />

                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-fl-text font-semibold">Resonance (Q):</span>
                  <span className="font-mono text-fl-amber font-bold">{resonanceQ.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="12.0"
                  step="0.1"
                  value={resonanceQ}
                  onChange={(e) => setResonanceQ(Number(e.target.value))}
                  className="w-full accent-fl-orange cursor-pointer"
                />

                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-fl-text font-semibold">FM Phase Modulation Index:</span>
                  <span className="font-mono text-[#00e676] font-bold">
                    {(fmDepth * 100).toFixed(0)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="2.5"
                  step="0.05"
                  value={fmDepth}
                  onChange={(e) => setFmDepth(Number(e.target.value))}
                  className="w-full accent-[#00e676] cursor-pointer"
                />
              </div>

              <div className="flex gap-1.5 pt-1">
                {(["lowpass", "bandpass", "highpass"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFilterType(t)}
                    className={`flex-1 py-1 rounded text-[9px] font-bold uppercase fl-bevel border border-black/70 cursor-pointer ${
                      filterType === t
                        ? "bg-fl-orange text-black"
                        : "bg-fl-raised text-fl-dim hover:text-white"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="p-3 rounded bg-fl-deep border border-black/60 fl-inset flex flex-col gap-2">
            <span className="font-bold text-fl-text text-[11px] flex items-center justify-between">
              <span>PRIMARY OSCILLATOR WAVEFORM</span>
              <span className="text-fl-dim text-[10px] font-mono">
                Current: {(channel.waveform ?? "sawtooth").toUpperCase()}
              </span>
            </span>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {waveforms.map((w) => {
                const active = (channel.waveform ?? "sawtooth") === w.shape;
                return (
                  <button
                    key={w.shape}
                    type="button"
                    onClick={() => {
                      onUpdateChannel(channel.id, { waveform: w.shape });
                      onAuditionChannel?.(channel.id);
                    }}
                    className={`py-2 px-1 rounded text-[10px] font-semibold flex flex-col items-center gap-1 border border-black/80 fl-bevel cursor-pointer transition-all ${
                      active
                        ? "bg-fl-orange text-black font-bold shadow-[0_0_8px_rgba(255,107,53,0.5)]"
                        : "bg-fl-raised text-fl-text hover:bg-white/10"
                    }`}
                  >
                    <span>{w.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="h-11 px-4 bg-[#181a20] border-t border-black/80 flex items-center justify-between">
          <button
            type="button"
            onClick={() => onAuditionChannel?.(channel.id, 60)}
            className="px-3 py-1.5 rounded bg-fl-raised hover:bg-white/10 text-fl-text text-[11px] font-bold border border-black/70 fl-bevel flex items-center gap-1.5 cursor-pointer"
          >
            <Volume2 size={13} className="text-fl-orange" />
            Audition Sound (C5)
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-fl-orange hover:bg-orange-500 text-black font-bold text-[11px] fl-bevel cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
