/**
 * FL-style Channel Rack: channel strips with LED mute, pan/volume knobs, color-coded channel
 * buttons with context menu, mixer-target LCD, skeuomorphic 4-step-grouped grid, and a
 * Graph Editor drawer (velocity / pan / pitch) aligned under the steps of the selected channel.
 */
import { ChevronDown, FolderOpen, Plus } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import type { QlChannel, QlPattern, QlStep } from "../schemas.ts";
import { Knob, Led, formatDb, formatPan } from "../ui/primitives.tsx";
import { BROWSER_DRAG_MIME, type BrowserItem } from "./BrowserSidebar.tsx";

export type ChannelPatch = Partial<
  Pick<
    QlChannel,
    "muted" | "solo" | "pan" | "volumeDb" | "assignedMixerInsert" | "name" | "colorHex" | "sampleSlot" | "samplePath"
  >
>;
export type ChannelAction =
  | "rename"
  | "color"
  | "clone"
  | "delete"
  | "load_wav"
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
}> = ({ patterns, activePatternId, stepCount, onSelectPattern, onNewPattern, onStepCountChange }) => (
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
);

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
}) => {
  const [graphOpen, setGraphOpen] = useState(true);
  const [graphParam, setGraphParam] = useState<GraphParam>("velocity");
  const [menu, setMenu] = useState<{ channelId: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
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
                  onClick={() => onSelectChannel(ch.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSelectChannel(ch.id);
                    setMenu({ channelId: ch.id, x: e.clientX, y: e.clientY });
                  }}
                  title="Left-click: select · Right-click: channel menu · Drop browser item to replace generator"
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
                        }}
                        onPointerEnter={() => {
                          const p = paintRef.current;
                          if (p && p.channelId === ch.id && st.active !== p.value) onUpdateStep(ch.id, i, { active: p.value });
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
                onChannelAction(menu.channelId, actionKey);
                setMenu(null);
              }}
              className="w-full text-left px-3 py-1 text-[11px] hover:bg-fl-orange hover:text-black cursor-pointer"
            >
              {label}
            </button>
          ))}
        </div>
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
