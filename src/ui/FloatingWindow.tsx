/**
 * Lightweight pointer-event window manager for FL-style floating workspace panels.
 * Supports drag (title bar), focus/z-order, minimize (collapse to title), maximize, close.
 */
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import React, { useRef } from "react";

export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface WindowState {
  readonly id: string;
  readonly rect: WindowRect;
  readonly z: number;
  readonly open: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
}

export interface FloatingWindowProps {
  readonly state: WindowState;
  readonly title: string;
  readonly icon?: React.ReactNode;
  /** Extra controls rendered inside the title bar (pattern selector, etc.). */
  readonly headerExtras?: React.ReactNode;
  readonly onFocus: (id: string) => void;
  readonly onChange: (id: string, patch: Partial<WindowState>) => void;
  readonly children: React.ReactNode;
}

export const FloatingWindow: React.FC<FloatingWindowProps> = React.memo(({
  state,
  title,
  icon,
  headerExtras,
  onFocus,
  onChange,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; curX: number; curY: number } | null>(null);
  const rafRef = useRef<number>(0);

  if (!state.open) return null;

  const style: React.CSSProperties = state.maximized
    ? { left: 0, top: 0, width: "100%", height: "100%", zIndex: state.z }
    : {
        left: state.rect.x,
        top: state.rect.y,
        width: state.rect.w,
        height: state.minimized ? 26 : state.rect.h,
        zIndex: state.z,
      };

  return (
    <div
      ref={containerRef}
      className="absolute flex flex-col rounded-[4px] border border-black/80 bg-fl-panel shadow-[0_10px_30px_rgba(0,0,0,0.6)] overflow-hidden will-change-[left,top]"
      style={style}
      onPointerDown={() => onFocus(state.id)}
    >
      <div
        className="h-[26px] shrink-0 flex items-center gap-2 px-2 fl-matte bg-[#2a2f36] border-b border-black/70 cursor-grab active:cursor-grabbing select-none"
        onDoubleClick={() => onChange(state.id, { maximized: !state.maximized })}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
          if (state.maximized) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            px: e.clientX,
            py: e.clientY,
            x: state.rect.x,
            y: state.rect.y,
            curX: state.rect.x,
            curY: state.rect.y,
          };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const maxW = typeof window !== "undefined" ? Math.max(200, window.innerWidth - 120) : 1600;
          const maxH = typeof window !== "undefined" ? Math.max(120, window.innerHeight - 96) : 900;
          const nextX = Math.min(maxW, Math.max(0, drag.current.x + e.clientX - drag.current.px));
          const nextY = Math.min(maxH, Math.max(0, drag.current.y + e.clientY - drag.current.py));
          drag.current.curX = nextX;
          drag.current.curY = nextY;

          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.style.left = `${nextX}px`;
              containerRef.current.style.top = `${nextY}px`;
            }
          });
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (drag.current) {
            const finalX = drag.current.curX;
            const finalY = drag.current.curY;
            drag.current = null;
            if (finalX !== state.rect.x || finalY !== state.rect.y) {
              onChange(state.id, {
                rect: {
                  ...state.rect,
                  x: finalX,
                  y: finalY,
                },
              });
            }
          }
        }}
        onPointerCancel={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          drag.current = null;
        }}
      >
        <span className="text-fl-orange">{icon}</span>
        <span className="text-[11px] font-semibold tracking-wide text-fl-text truncate">{title}</span>
        <div data-no-drag className="flex items-center gap-1.5 ml-2 flex-1 min-w-0">
          {headerExtras}
        </div>
        <div data-no-drag className="flex items-center gap-0.5">
          <button
            type="button"
            title="Minimize"
            className="w-5 h-5 grid place-items-center rounded hover:bg-white/10 cursor-pointer"
            onClick={() => onChange(state.id, { minimized: !state.minimized, maximized: false })}
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            title={state.maximized ? "Restore" : "Maximize"}
            className="w-5 h-5 grid place-items-center rounded hover:bg-white/10 cursor-pointer"
            onClick={() => onChange(state.id, { maximized: !state.maximized, minimized: false })}
          >
            {state.maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          <button
            type="button"
            title="Close"
            className="w-5 h-5 grid place-items-center rounded hover:bg-red-500/70 cursor-pointer"
            onClick={() => onChange(state.id, { open: false })}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {!state.minimized && <div className="flex-1 min-h-0 flex flex-col">{children}</div>}
    </div>
  );
});
