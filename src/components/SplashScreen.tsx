/**
 * QL STUDIO — Professional Studio Startup Splash Screen
 *
 * Provides a fluid, branded initialization experience:
 * 1. Masks hardware audio initialization, buffer allocation, and VST3 directory discovery.
 * 2. Visualizes engine startup milestones (Zero-allocation Rust Core, Hermite Cubic Sampler, Kahn DAG Mixer, USB MIDI).
 * 3. Instant dismiss on click or keyboard press.
 */

import React, { useEffect, useState } from "react";
import { Cpu, Music, Sparkles } from "lucide-react";

export interface SplashScreenProps {
  readonly onFinish: () => void;
  readonly durationMs?: number;
}

const STAGES = [
  { percent: 15, text: "Initializing Zero-Allocation Audio Engine (cpal)..." },
  { percent: 35, text: "Loading 4-Point Hermite Voice Sampler & Drum Kit..." },
  { percent: 60, text: "Constructing 64-Insert Kahn Topological DAG Mixer Matrix..." },
  { percent: 80, text: "Scanning VST3 / CLAP Plugins & USB MIDI Ports..." },
  { percent: 95, text: "Calibrating WSOLA Time-Stretch & Pitch-Shift Core..." },
  { percent: 100, text: "Studio Engine Ready." },
];

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onFinish,
  durationMs = 1600,
}) => {
  const [progress, setProgress] = useState(0);
  const [fadingOut, setFadingOut] = useState(false);
  const [statusText, setStatusText] = useState(STAGES[0]!.text);

  useEffect(() => {
    const startTime = performance.now();
    let animId: number;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const rawPct = Math.min(100, (elapsed / durationMs) * 100);
      setProgress(rawPct);

      const curStage = STAGES.find((s) => s.percent >= rawPct) ?? STAGES[STAGES.length - 1]!;
      setStatusText(curStage.text);

      if (rawPct < 100) {
        animId = requestAnimationFrame(tick);
      } else {
        setFadingOut(true);
        setTimeout(() => {
          onFinish();
        }, 300);
      }
    };

    animId = requestAnimationFrame(tick);

    const handleSkip = () => {
      cancelAnimationFrame(animId);
      setFadingOut(true);
      setTimeout(onFinish, 150);
    };

    window.addEventListener("keydown", handleSkip, { once: true });
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("keydown", handleSkip);
    };
  }, [durationMs, onFinish]);

  return (
    <div
      onClick={() => {
        setFadingOut(true);
        setTimeout(onFinish, 150);
      }}
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-radial from-[#1e222a] via-[#101217] to-[#07080a] select-none cursor-pointer transition-opacity duration-300 ${
        fadingOut ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      {/* Subtle Studio Grid Overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none" />

      {/* Main Splash Center Container */}
      <div className="relative flex flex-col items-center z-10 max-w-md w-full px-8 py-6">
        {/* Glowing DAW Logo */}
        <div className="relative mb-6">
          <div className="absolute -inset-4 bg-fl-orange/20 rounded-full blur-2xl animate-pulse" />
          <img
            src="./logo.svg"
            alt="QL Studio Logo"
            className="w-24 h-24 drop-shadow-[0_0_24px_rgba(255,133,0,0.65)] relative transform hover:scale-105 transition-transform"
          />
        </div>

        {/* Title & Brand Typography */}
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-3xl font-black tracking-widest text-white drop-shadow">
            QUICKLAYER <span className="text-fl-orange">STUDIO</span>
          </h1>
          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-fl-orange/20 border border-fl-orange/50 text-fl-orange">
            v1.0.0
          </span>
        </div>

        <p className="text-[11px] font-medium tracking-wide text-fl-dim mb-6 text-center">
          LAYER, COMPOSE AND MASTER WITH ZERO LATENCY &bull; QL AUDIO ENGINE
        </p>

        {/* Neon Dual-Color Loading Bar */}
        <div className="w-full bg-black/80 h-2.5 rounded-full border border-white/10 p-[2px] shadow-inner relative overflow-hidden mb-3">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#ff8500] via-[#ffb703] to-[#00e676] transition-all duration-75 relative shadow-[0_0_12px_rgba(255,133,0,0.8)]"
            style={{ width: `${progress}%` }}
          >
            {/* Glowing Leading Head */}
            <div className="absolute right-0 top-0 bottom-0 w-2 bg-white rounded-full shadow-[0_0_8px_#ffffff]" />
          </div>
        </div>

        {/* Dynamic Status Text */}
        <div className="flex items-center justify-between w-full text-[10px] font-mono">
          <span className="text-fl-text/80 truncate pr-2 flex items-center gap-1.5">
            <Cpu size={12} className="text-[#00e676] shrink-0" />
            {statusText}
          </span>
          <span className="text-fl-amber font-bold shrink-0">
            {Math.round(progress)}%
          </span>
        </div>

        {/* Footer Badges & Skip Prompt */}
        <div className="mt-8 pt-4 border-t border-white/10 w-full flex items-center justify-between text-[9px] text-fl-dim font-mono">
          <span>GPL-3.0 + PLUGIN EXCEPTION</span>
          <span className="text-fl-dim/60 hover:text-white transition-colors">
            CLICK OR PRESS SPACE TO SKIP
          </span>
        </div>
      </div>
    </div>
  );
};
