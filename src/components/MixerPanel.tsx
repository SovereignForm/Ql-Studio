/**
 * 64-insert mixer: Master (0) + Inserts 1..64 as vertical strips with peak meter, long-throw
 * fader, pan and stereo-separation knobs, mute/solo; right-hand inspector with 10 FX slots.
 *
 * Native processing note: the Rust core currently applies, per insert, fader gain, pan,
 * stereo separation, mute and the FIRST enabled parametric-EQ band (see tauriBridge
 * toNativeMixerStatePayload). Delay/Reverb/Waveshaper slots are stored in project state only.
 */
import React, { useRef } from "react";
import type { BiquadFilterMode, InsertEffectConfig, ParametricEqBand, QlMixerInsert, QlMixerState } from "../schemas.ts";
import { Knob, Led, PeakMeter, formatDb, formatPan } from "../ui/primitives.tsx";

export type InsertPatch = Partial<
  Pick<QlMixerInsert, "faderVolumeDb" | "pan" | "stereoSeparation" | "muted" | "solo" | "name">
>;

export interface MixerPanelProps {
  readonly mixer: QlMixerState;
  /** Display levels per insert index, linear 0..1 [L, R]. */
  readonly levels: readonly (readonly [number, number])[];
  readonly selectedInsert: number;
  readonly insertsInUse: ReadonlySet<number>;
  readonly onSelectInsert: (index: number) => void;
  readonly onUpdateInsert: (index: number, patch: InsertPatch) => void;
  readonly onSetEffect: (insertIndex: number, slotIndex: number, config: InsertEffectConfig | null) => void;
  readonly onToggleBypass: (insertIndex: number, slotIndex: number) => void;
  readonly onOpenPluginManager?: () => void;
}

const FADER_MIN = -60;
const FADER_MAX = 5.6;
const ZERO_LEVEL: readonly [number, number] = [0, 0];

export const MixerPanel: React.FC<MixerPanelProps> = React.memo(({
  mixer,
  levels,
  selectedInsert,
  insertsInUse,
  onSelectInsert,
  onUpdateInsert,
  onSetEffect,
  onToggleBypass,
  onOpenPluginManager,
}) => {
  const sel = mixer.inserts.find((i) => i.index === selectedInsert) ?? mixer.inserts[0]!;
  return (
    <div className="flex h-full bg-[#1c1f24]">
      <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden fl-scroll">
        <div className="flex h-full gap-[2px] p-1">
          {mixer.inserts.map((ins) => (
            <MixerStrip
              key={ins.index}
              insert={ins}
              level={levels[ins.index] ?? ZERO_LEVEL}
              selected={ins.index === selectedInsert}
              inUse={insertsInUse.has(ins.index)}
              onSelectInsert={onSelectInsert}
              onUpdateInsert={onUpdateInsert}
            />
          ))}
        </div>
      </div>
      <Inspector
        insert={sel}
        onSetEffect={onSetEffect}
        onToggleBypass={onToggleBypass}
        onOpenPluginManager={onOpenPluginManager}
      />
    </div>
  );
});

const MixerStrip: React.FC<{
  readonly insert: QlMixerInsert;
  readonly level: readonly [number, number];
  readonly selected: boolean;
  readonly inUse: boolean;
  readonly onSelectInsert: (index: number) => void;
  readonly onUpdateInsert: (index: number, patch: InsertPatch) => void;
}> = React.memo(({ insert, level, selected, inUse, onSelectInsert, onUpdateInsert }) => {
  const isMaster = insert.index === 0;
  const onSelect = React.useCallback(() => onSelectInsert(insert.index), [onSelectInsert, insert.index]);
  const onUpdate = React.useCallback((patch: InsertPatch) => onUpdateInsert(insert.index, patch), [onUpdateInsert, insert.index]);
  return (
    <div
      onPointerDown={onSelect}
      className={`flex flex-col items-center shrink-0 h-full py-1 rounded-[3px] border fl-bevel ${
        isMaster ? "w-[62px] mr-2" : "w-[46px]"
      } ${selected ? "bg-[#3a414c] border-fl-orange/70" : "bg-fl-raised border-black/70"}`}
    >
      <div className={`text-[9px] font-bold ${isMaster ? "text-fl-orange" : inUse ? "text-fl-text" : "text-fl-dim"}`}>
        {isMaster ? "M" : insert.index}
      </div>
      <div className="text-[9px] text-fl-dim truncate w-full text-center px-0.5" title={insert.name}>
        {isMaster ? "Master" : insert.name.replace("Insert ", "Ins ")}
      </div>
      <div className="flex gap-1 my-1">
        <Led on={!insert.muted} title="Mute" size={9} onClick={() => onUpdate({ muted: !insert.muted })} />
        <button
          type="button"
          title="Solo"
          onClick={() => onUpdate({ solo: !insert.solo })}
          className={`w-[11px] h-[11px] text-[7px] font-black rounded-[2px] leading-none cursor-pointer ${
            insert.solo ? "bg-fl-amber text-black" : "bg-fl-deep text-fl-dim"
          }`}
        >
          S
        </button>
      </div>
      <Knob
        value={insert.pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={20}
        bipolar
        color="#38bdf8"
        title="Pan"
        format={formatPan}
        onChange={(v) => onUpdate({ pan: Number(v.toFixed(3)) })}
      />
      <Knob
        value={insert.stereoSeparation}
        min={-1}
        max={1}
        defaultValue={0}
        size={20}
        bipolar
        color="#c084fc"
        title="Stereo separation (−100% merged … +100% separated)"
        format={(v) => `${v < 0 ? "Merged" : v > 0 ? "Separated" : "Original"} ${Math.round(Math.abs(v) * 100)}%`}
        onChange={(v) => onUpdate({ stereoSeparation: Number(v.toFixed(3)) })}
      />
      <div className="flex-1 min-h-0 flex gap-1 mt-1.5 w-full justify-center">
        <PeakMeter left={level[0]} right={level[1]} width={isMaster ? 12 : 8} height={150} />
        <Fader value={insert.faderVolumeDb} onChange={(db) => onUpdate({ faderVolumeDb: db })} />
      </div>
      <div className="fl-lcd fl-inset rounded-sm text-[8px] px-0.5 mt-1 w-[40px] text-center">
        {insert.faderVolumeDb <= FADER_MIN ? "-inf" : insert.faderVolumeDb.toFixed(1)}
      </div>
    </div>
  );
});
MixerStrip.displayName = "MixerStrip";

/** Long-throw vertical fader (dB-linear travel). Double-click resets to 0 dB. */
const Fader: React.FC<{ readonly value: number; readonly onChange: (db: number) => void }> = ({ value, onChange }) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const H = 150;
  const pos = (Math.max(FADER_MIN, Math.min(FADER_MAX, value)) - FADER_MIN) / (FADER_MAX - FADER_MIN);
  const unityPos = (0 - FADER_MIN) / (FADER_MAX - FADER_MIN);
  const setFromY = (clientY: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    const t = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
    const db = FADER_MIN + t * (FADER_MAX - FADER_MIN);
    onChange(db <= FADER_MIN + 0.3 ? -96 : Number(db.toFixed(1)));
  };
  return (
    <div
      ref={trackRef}
      className="relative w-[16px] cursor-ns-resize"
      style={{ height: H }}
      title={formatDb(value)}
      onDoubleClick={() => onChange(0)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromY(e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) setFromY(e.clientY);
      }}
    >
      <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-[3px] rounded bg-black/80 fl-inset" />
      <div className="absolute left-0 right-0 h-px bg-fl-amber/50" style={{ bottom: `${unityPos * 100}%` }} />
      <div
        className="absolute left-[-2px] right-[-2px] h-[22px] rounded-[2px] border border-black/80"
        style={{
          bottom: `calc(${pos * 100}% - 11px)`,
          background: "linear-gradient(180deg,#6d7682,#3b424c 45%,#2a2f36 55%,#545c67)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 2px 3px rgba(0,0,0,0.6)",
        }}
      >
        <div className="absolute left-0.5 right-0.5 top-1/2 h-px bg-fl-orange" />
      </div>
    </div>
  );
};

const DEFAULT_EQ_BAND: ParametricEqBand = {
  enabled: true,
  mode: "peaking",
  frequencyHz: 1000,
  gainDb: 0,
  qFactor: 1,
};

function defaultEffect(kind: InsertEffectConfig["kind"]): InsertEffectConfig {
  switch (kind) {
    case "parametric_eq":
      return { kind, bands: [DEFAULT_EQ_BAND] };
    case "stereo_delay":
      return { kind, timeTicksLeft: 72, timeTicksRight: 48, feedback: 0.35, lowCutHz: 200, highCutHz: 8000, pingPong: true };
    case "algorithmic_reverb":
      return { kind, preDelayMs: 20, decaySeconds: 2.2, dampingFreqHz: 6000, roomSize: 0.6, diffusion: 0.7 };
    case "waveshaper_distortion":
      return { kind, driveDb: 12, asymmetry: 0, curveExponent: 1.5 };
  }
}

const EFFECT_LABEL: Record<InsertEffectConfig["kind"], string> = {
  parametric_eq: "Parametric EQ",
  stereo_delay: "Stereo Delay",
  algorithmic_reverb: "Reverb",
  waveshaper_distortion: "Waveshaper",
};

const Inspector: React.FC<{
  readonly insert: QlMixerInsert;
  readonly onSetEffect: MixerPanelProps["onSetEffect"];
  readonly onToggleBypass: MixerPanelProps["onToggleBypass"];
  readonly onOpenPluginManager?: () => void;
}> = ({ insert, onSetEffect, onToggleBypass, onOpenPluginManager }) => {
  const firstEqSlot = insert.effectSlots.find((s) => !s.bypassed && s.config.kind === "parametric_eq")?.slotIndex;
  return (
    <div className="w-[250px] shrink-0 border-l border-black/80 bg-[#20242a] flex flex-col">
      <div className="h-6 px-2 flex items-center justify-between text-[11px] font-semibold border-b border-black/70">
        <div>
          <span className="text-fl-orange mr-1">{insert.index === 0 ? "Master" : `Insert ${insert.index}`}</span>
          <span className="text-fl-dim">· FX chain</span>
        </div>
        {onOpenPluginManager && (
          <button
            type="button"
            onClick={onOpenPluginManager}
            title="Open VST3 / CLAP Plugin Manager"
            className="text-[9px] font-bold text-fl-amber hover:text-white px-1.5 py-0.5 rounded bg-fl-deep border border-black/60 cursor-pointer"
          >
            + VST / CLAP
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto fl-scroll p-1.5 space-y-[3px]">
        {Array.from({ length: 10 }, (_, slotIndex) => {
          const slot = insert.effectSlots.find((s) => s.slotIndex === slotIndex);
          const native = slot && slotIndex === firstEqSlot;
          return (
            <div key={slotIndex} className="rounded-[3px] bg-fl-raised border border-black/70 fl-bevel">
              <div className="h-[22px] flex items-center gap-1.5 px-1.5">
                <Led
                  on={!!slot && !slot.bypassed}
                  color="#00e676"
                  size={9}
                  title={slot ? (slot.bypassed ? "Enable" : "Bypass") : "Empty slot"}
                  onClick={() => slot && onToggleBypass(insert.index, slotIndex)}
                />
                <span className="text-[9px] text-fl-dim w-3">{slotIndex + 1}</span>
                <select
                  value={slot?.config.kind ?? ""}
                  onChange={(e) =>
                    onSetEffect(
                      insert.index,
                      slotIndex,
                      e.target.value ? defaultEffect(e.target.value as InsertEffectConfig["kind"]) : null,
                    )
                  }
                  className="flex-1 h-[16px] text-[10px] bg-fl-deep fl-inset rounded-sm outline-none text-fl-text cursor-pointer"
                >
                  <option value="">(none)</option>
                  {(Object.keys(EFFECT_LABEL) as InsertEffectConfig["kind"][]).map((k) => (
                    <option key={k} value={k}>
                      {EFFECT_LABEL[k]}
                    </option>
                  ))}
                </select>
                {slot && (
                  <span
                    className={`text-[8px] px-1 rounded-sm ${native ? "bg-fl-led/20 text-fl-led" : "bg-white/5 text-fl-dim"}`}
                    title={native ? "Processed by the native Rust core" : "Stored in project state; not processed by the native core yet"}
                  >
                    {native ? "NATIVE" : "STATE"}
                  </span>
                )}
              </div>
              {slot?.config.kind === "parametric_eq" && (
                <EqBandEditor
                  band={slot.config.bands[0] ?? DEFAULT_EQ_BAND}
                  onChange={(band) => onSetEffect(insert.index, slotIndex, { kind: "parametric_eq", bands: [band] })}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const EQ_MODES: readonly BiquadFilterMode[] = ["peaking", "lowshelf", "highshelf", "lowpass", "highpass", "bandpass_csg", "notch"];

const EqBandEditor: React.FC<{ readonly band: ParametricEqBand; readonly onChange: (b: ParametricEqBand) => void }> = ({ band, onChange }) => {
  const logF = Math.log10(band.frequencyHz);
  return (
    <div className="flex items-center gap-2 px-2 pb-1.5 pt-0.5">
      <select
        value={band.mode}
        onChange={(e) => onChange({ ...band, mode: e.target.value as BiquadFilterMode })}
        className="h-[16px] text-[9px] bg-fl-deep fl-inset rounded-sm outline-none text-fl-amber cursor-pointer"
      >
        {EQ_MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <div className="flex flex-col items-center">
        <Knob value={logF} min={Math.log10(20)} max={Math.log10(20000)} defaultValue={3} size={20} title="Frequency"
          format={(v) => `${Math.round(10 ** v)} Hz`} onChange={(v) => onChange({ ...band, frequencyHz: Math.round(10 ** v) })} />
        <span className="text-[8px] text-fl-dim">FREQ</span>
      </div>
      <div className="flex flex-col items-center">
        <Knob value={band.gainDb} min={-24} max={24} defaultValue={0} size={20} bipolar title="Gain"
          format={(v) => `${v.toFixed(1)} dB`} onChange={(v) => onChange({ ...band, gainDb: Number(v.toFixed(1)) })} />
        <span className="text-[8px] text-fl-dim">GAIN</span>
      </div>
      <div className="flex flex-col items-center">
        <Knob value={band.qFactor} min={0.1} max={18} defaultValue={1} size={20} color="#c084fc" title="Q"
          format={(v) => v.toFixed(2)} onChange={(v) => onChange({ ...band, qFactor: Number(v.toFixed(2)) })} />
        <span className="text-[8px] text-fl-dim">Q</span>
      </div>
    </div>
  );
};
