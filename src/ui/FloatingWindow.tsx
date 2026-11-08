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
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    curX: number;
    curY: number;
  } | null>(null);
  const rafId = useRef<number>(0);

  if (!state.open) return null;

  const style: React.CSSProperties = state.maximized
    ? { transform: "translate3d(0px, 0px, 0px)", width: "100%", height: "100%", zIndex: state.z }
    : {
        transform: `translate3d(${state.rect.x}px, ${state.rect.y}px, 0px)`,
        width: state.rect.w,
        height: state.minimized ? 26 : state.rect.h,
        zIndex: state.z,
      };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    if (state.maximized) return;
    e.stopPropagation();
    onFocus(state.id);

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: state.rect.x,
      origY: state.rect.y,
      curX: state.rect.x,
      curY: state.rect.y,
    };

    const targetEl = containerRef.current;
    if (targetEl) {
      targetEl.style.pointerEvents = "none";
    }

    const onPointerMove = (moveEv: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const nextX = Math.max(0, cur.origX + moveEv.clientX - cur.startX);
      const nextY = Math.max(0, cur.origY + moveEv.clientY - cur.startY);
      cur.curX = nextX;
      cur.curY = nextY;

      if (!rafId.current) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = 0;
          if (containerRef.current) {
            containerRef.current.style.transform = `translate3d(${cur.curX}px, ${cur.curY}px, 0px)`;
          }
        });
      }
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);

      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }

      if (targetEl) {
        targetEl.style.pointerEvents = "";
      }

      const cur = dragRef.current;
      if (cur) {
        const finalX = cur.curX;
        const finalY = cur.curY;
        dragRef.current = null;
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
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
  };

  return (
    <div
      ref={containerRef}
      className="absolute left-0 top-0 flex flex-col rounded-[4px] border border-black/80 bg-fl-panel overflow-hidden will-change-transform select-none"
      style={style}
      onPointerDown={() => {
        if (!dragRef.current) onFocus(state.id);
      }}
    >
      <div
        className="h-[26px] shrink-0 flex items-center gap-2 px-2 bg-[#2a2f36] border-b border-black/70 cursor-grab active:cursor-grabbing select-none"
        onDoubleClick={() => onChange(state.id, { maximized: !state.maximized })}
        onPointerDown={handlePointerDown}
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
