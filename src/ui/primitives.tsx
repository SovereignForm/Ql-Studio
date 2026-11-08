/**
 * Shared skeuomorphic controls: canvas rotary knob, canvas peak meter, LED button, LCD.
 */
import React, { useEffect, useRef } from "react";

/* ------------------------------------------------------------------ */
/* Rotary knob (canvas). Vertical drag; Shift = fine; double-click = reset. */
/* ------------------------------------------------------------------ */
export interface KnobProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  readonly size?: number;
  readonly color?: string;
  /** Draw the arc from the center (bipolar, e.g. pan) instead of from min. */
  readonly bipolar?: boolean;
  readonly title: string;
  readonly format?: (v: number) => string;
  readonly onChange: (v: number) => void;
}

export const Knob: React.FC<KnobProps> = ({
  value,
  min,
  max,
  defaultValue,
  size = 26,
  color = "#ff8500",
  bipolar = false,
  title,
  format,
  onChange,
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ y: number; v: number } | null>(null);
  const norm = Math.min(1, Math.max(0, (value - min) / (max - min)));

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2;
    const r = size * 0.36;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const av = a0 + norm * (a1 - a0);
    const aMid = a0 + 0.5 * (a1 - a0);
    ctx.clearRect(0, 0, size, size);

    // track ring
    ctx.lineCap = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#0d0f12";
    ctx.beginPath();
    ctx.arc(cx, cx, r + 3, a0, a1);
    ctx.stroke();

    // value ring
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    if (bipolar) ctx.arc(cx, cx, r + 3, Math.min(aMid, av), Math.max(aMid, av));
    else ctx.arc(cx, cx, r + 3, a0, av);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // knob body (convex gradient)
    const g = ctx.createRadialGradient(cx - r * 0.35, cx - r * 0.45, r * 0.1, cx, cx, r);
    g.addColorStop(0, "#5a626d");
    g.addColorStop(1, "#23272d");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // pointer
    ctx.strokeStyle = "#f2f4f7";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(av) * r * 0.25, cx + Math.sin(av) * r * 0.25);
    ctx.lineTo(cx + Math.cos(av) * r * 0.9, cx + Math.sin(av) * r * 0.9);
    ctx.stroke();
  }, [norm, size, color, bipolar]);

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size }}
      className="cursor-ns-resize shrink-0"
      title={`${title}: ${format ? format(value) : value.toFixed(2)}`}
      onDoubleClick={() => onChange(defaultValue)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const range = max - min;
        const sens = e.shiftKey ? 600 : 150;
        const next = drag.current.v + ((drag.current.y - e.clientY) / sens) * range;
        onChange(Math.min(max, Math.max(min, next)));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    />
  );
};

/* ------------------------------------------------------------------ */
/* Stereo peak meter (canvas). Levels are linear 0..1 per side.         */
/* ------------------------------------------------------------------ */
export interface PeakMeterProps {
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
  readonly orientation?: "vertical" | "horizontal";
}

export const PeakMeter: React.FC<PeakMeterProps> = ({
  left,
  right,
  width,
  height,
  orientation = "vertical",
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    c.width = width;
    c.height = height;
    ctx.fillStyle = "#0a0b0d";
    ctx.fillRect(0, 0, width, height);
    const vertical = orientation === "vertical";
    const len = vertical ? height : width;
    const grad = vertical
      ? ctx.createLinearGradient(0, height, 0, 0)
      : ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, "#00c853");
    grad.addColorStop(0.68, "#7cff3a");
    grad.addColorStop(0.82, "#ffb300");
    grad.addColorStop(0.94, "#ff3d3d");
    const lanes = [left, right];
    const laneSize = (vertical ? width : height) / 2;
    lanes.forEach((lvl, i) => {
      // map linear -> dB-ish display (−60 dB floor)
      const db = lvl <= 1e-4 ? -60 : 20 * Math.log10(lvl);
      const fill = Math.min(1, Math.max(0, (db + 60) / 66)) * len;
      ctx.fillStyle = grad;
      if (vertical) ctx.fillRect(i * laneSize + 1, height - fill, laneSize - 2, fill);
      else ctx.fillRect(0, i * laneSize + 1, fill, laneSize - 2);
    });
    // segment gaps
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    for (let p = 3; p < len; p += 3) {
      if (vertical) ctx.fillRect(0, p, width, 1);
      else ctx.fillRect(p, 0, 1, height);
    }
  }, [left, right, width, height, orientation]);
  return <canvas ref={ref} className="rounded-[2px] fl-inset" style={{ width, height }} />;
};

/* ------------------------------------------------------------------ */
/* LED toggle                                                           */
/* ------------------------------------------------------------------ */
export const Led: React.FC<{
  readonly on: boolean;
  readonly color?: string;
  readonly title: string;
  readonly onClick?: () => void;
  readonly size?: number;
}> = ({ on, color = "#25d366", title, onClick, size = 11 }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="rounded-full border border-black/70 shrink-0 cursor-pointer"
    style={{
      width: size,
      height: size,
      background: on
        ? `radial-gradient(circle at 35% 30%, #ffffff 0%, ${color} 45%, ${color} 100%)`
        : "radial-gradient(circle at 35% 30%, #4a5058, #1a1d21)",
      boxShadow: on ? `0 0 6px ${color}` : "inset 0 1px 1px rgba(0,0,0,0.6)",
    }}
  />
);

/* ------------------------------------------------------------------ */
/* Toolbar icon button with active backlight                            */
/* ------------------------------------------------------------------ */
export const ToolButton: React.FC<{
  readonly active?: boolean;
  readonly glow?: string;
  readonly title: string;
  readonly onClick?: () => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}> = ({ active = false, glow = "#ff8500", title, onClick, children, className = "" }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`h-7 min-w-7 px-1.5 rounded-[3px] border border-black/60 fl-bevel flex items-center justify-center gap-1 transition cursor-pointer ${
      active ? "text-black" : "bg-fl-raised text-fl-text hover:brightness-125"
    } ${className}`}
    style={
      active
        ? { background: `linear-gradient(180deg, ${glow}, ${glow}cc)`, boxShadow: `0 0 9px ${glow}aa` }
        : undefined
    }
  >
    {children}
  </button>
);

export function formatDb(db: number): string {
  if (db <= -60) return "-inf";
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export function formatPan(p: number): string {
  if (Math.abs(p) < 0.005) return "Centered";
  return `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? "L" : "R"}`;
}
