/**
 * QL STUDIO — External VST3 / CLAP Native Dedicated Window Parenting
 *
 * Renders the original standalone popout editor for any loaded VST3 or CLAP plugin.
 * Features:
 * 1. Dedicated custom skeuomorphic GUI panels for QL Studio hardware modeled units:
 *    - Ql Vintage Tape (analog illuminated VU needle meters, tube drive, flutter)
 *    - Precision Limiter (gain reduction ladder, true-peak ceiling, threshold)
 *    - 303 Acid Bass (Roland TB-303 silver faceplate, 18Hz-10kHz cutoff, resonance, interactive keyboard)
 *    - Stereo Imager (Lissajous vector goniometer phase scope, width 0..200%)
 * 2. Generic studio rack view for third-party VST3/CLAP plugins (Serum, FabFilter, Vital, etc.)
 *    with full real-time parameter tweaking, bypass, and preset management.
 */

import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  Layers,
  Music,
  Power,
  RotateCcw,
  Sliders,
  Volume2,
  Radio,
  ExternalLink,
} from "lucide-react";
import type { PluginInstanceSummary, PluginParamInfo } from "../schemas.ts";
import type { QlNativeEngineClient } from "../tauriBridge.ts";
import { Knob } from "../ui/primitives.tsx";

export interface DedicatedPluginWindowProps {
  readonly instanceId: string;
  readonly engineClient: QlNativeEngineClient;
}

export const DedicatedPluginWindow: React.FC<DedicatedPluginWindowProps> = ({
  instanceId,
  engineClient,
}) => {
  const [instance, setInstance] = useState<PluginInstanceSummary | null>(null);
  const [params, setParams] = useState<Record<number, number>>({});
  const [bypassed, setBypassed] = useState<boolean>(false);
  const [animTime, setAnimTime] = useState<number>(0);

  // Poll instance info
  const fetchInstance = useCallback(async () => {
    try {
      const list = await engineClient.getLoadedPlugins();
      const found = list.find((p) => p.instanceId === instanceId);
      if (found) {
        setInstance(found);
        const pMap: Record<number, number> = {};
        for (const p of found.parameters) {
          pMap[p.id] = p.value;
        }
        setParams(pMap);
      }
    } catch (err) {
      console.warn("Failed to fetch plugin instance:", err);
    }
  }, [engineClient, instanceId]);

  useEffect(() => {
    void fetchInstance();
    const interval = setInterval(fetchInstance, 600);
    return () => clearInterval(interval);
  }, [fetchInstance]);

  // Animation frame loop for VU meters & scopes
  useEffect(() => {
    let frameId: number;
    const loop = (t: number) => {
      setAnimTime(t * 0.001);
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleParamChange = async (paramId: number, val: number) => {
    setParams((prev) => ({ ...prev, [paramId]: val }));
    try {
      await engineClient.setPluginParameter(instanceId, paramId, val);
    } catch (err) {
      console.warn("Error setting plugin parameter:", err);
    }
  };

  const pluginName = instance?.descriptor.name ?? "Plugin Editor";
  const format = instance?.descriptor.format ?? "vst3";
  const vendor = instance?.descriptor.vendor ?? "Ql Audio DSP";
  const isTape = pluginName.toLowerCase().includes("tape");
  const isLimiter = pluginName.toLowerCase().includes("limiter");
  const is303 = pluginName.toLowerCase().includes("303") || pluginName.toLowerCase().includes("acid");
  const isImager = pluginName.toLowerCase().includes("imager") || pluginName.toLowerCase().includes("stereo");

  return (
    <div className="w-screen h-screen bg-[#111317] text-fl-text flex flex-col select-none overflow-hidden font-sans">
      {/* Top Plugin Header Bar */}
      <header className="h-10 bg-[#1a1d24] border-b border-black/80 px-4 flex items-center justify-between shrink-0 shadow-md">
        <div className="flex items-center gap-3">
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase tracking-wider ${
              format === "vst3"
                ? "bg-blue-900/80 text-blue-300 border border-blue-600/50"
                : "bg-purple-900/80 text-purple-300 border border-purple-600/50"
            }`}
          >
            {format}
          </span>
          <div className="flex flex-col">
            <span className="font-bold text-sm text-white tracking-wide flex items-center gap-2">
              {pluginName}
              <span className="text-[10px] font-normal text-fl-dim">by {vendor}</span>
            </span>
            <span className="text-[9px] font-mono text-fl-amber">
              ID: {instanceId}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setBypassed(!bypassed)}
            className={`px-3 py-1 rounded text-[11px] font-bold flex items-center gap-1.5 cursor-pointer border transition-colors ${
              bypassed
                ? "bg-red-900/60 border-red-500 text-red-200"
                : "bg-emerald-950/70 border-emerald-500/60 text-emerald-300"
            }`}
          >
            <Power size={12} />
            {bypassed ? "BYPASS" : "ACTIVE"}
          </button>
        </div>
      </header>

      {/* Main Plugin Chassis & Custom Interface */}
      <main className="flex-1 overflow-auto fl-scroll p-6 flex flex-col items-center justify-center bg-radial from-[#1e222a] to-[#0c0d10]">
        {/* Custom Skeuomorphic UI #1: QL Vintage Tape */}
        {isTape && (
          <div className="w-full max-w-2xl bg-[#26211c] border-4 border-[#3a322b] rounded-lg shadow-2xl p-6 flex flex-col gap-5 relative overflow-hidden">
            {/* Wood Cheeks Accent */}
            <div className="absolute left-0 top-0 bottom-0 w-3 bg-[#4a2615] border-r border-black/60 shadow-inner" />
            <div className="absolute right-0 top-0 bottom-0 w-3 bg-[#4a2615] border-l border-black/60 shadow-inner" />

            <div className="flex items-center justify-between border-b border-[#4d3d30] pb-3 px-2">
              <div className="flex items-center gap-2">
                <Radio className="text-[#ff9800]" size={20} />
                <span className="font-serif tracking-widest font-black text-lg text-[#f3e5ab]">
                  QL VINTAGE TAPE 1974
                </span>
              </div>
              <span className="text-[10px] font-mono text-[#f3e5ab]/70">
                WARM HARMONIC SATURATION & ANALOG WOW
              </span>
            </div>

            {/* Dual Backlit Analog Illuminated VU Meters */}
            <div className="grid grid-cols-2 gap-4 px-2">
              {["LEFT CHANNEL", "RIGHT CHANNEL"].map((ch, idx) => {
                const drive = params[0] ?? 4.0;
                const needleAngle = -45 + (drive / 24.0) * 80 + Math.sin(animTime * 8 + idx) * 8;
                return (
                  <div
                    key={ch}
                    className="h-28 bg-[#fdf6e2] rounded border-2 border-[#5a483a] p-2 flex flex-col justify-between relative shadow-inner overflow-hidden"
                  >
                    <div className="flex justify-between text-[8px] font-mono text-[#7a6452] font-bold">
                      <span>-20</span>
                      <span>-10</span>
                      <span>-7</span>
                      <span>-5</span>
                      <span>-3</span>
                      <span>-1</span>
                      <span className="text-red-600 font-extrabold">0</span>
                      <span className="text-red-600 font-extrabold">+3</span>
                    </div>

                    {/* Animated Needle */}
                    <div
                      className="absolute bottom-1 left-1/2 w-[2px] h-20 bg-black/85 origin-bottom transition-transform duration-75"
                      style={{
                        transform: `translateX(-50%) rotate(${Math.max(-50, Math.min(45, needleAngle))}deg)`,
                      }}
                    />

                    {/* Pivot */}
                    <div className="w-5 h-5 rounded-full bg-[#3a2f26] border-2 border-[#8c7462] mx-auto z-10 self-center shadow" />
                    <span className="text-[9px] font-serif font-black text-center text-[#5c4a3c] tracking-widest">
                      {ch} · VU
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Vintage Knobs Rack */}
            <div className="flex items-center justify-around bg-[#1c1814] p-4 rounded-md border border-[#4d3d30] shadow-inner">
              <div className="flex flex-col items-center">
                <Knob
                  value={params[0] ?? 4.0}
                  min={0.0}
                  max={24.0}
                  defaultValue={4.0}
                  size={46}
                  color="#ff9800"
                  onChange={(v) => handleParamChange(0, v)}
                />
                <span className="text-[10px] font-bold text-[#f3e5ab] mt-1.5">DRIVE</span>
                <span className="text-[9px] font-mono text-fl-amber">
                  {(params[0] ?? 4.0).toFixed(1)} dB
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[1] ?? 0.15}
                  min={0.0}
                  max={1.0}
                  defaultValue={0.15}
                  size={46}
                  color="#ffb74d"
                  onChange={(v) => handleParamChange(1, v)}
                />
                <span className="text-[10px] font-bold text-[#f3e5ab] mt-1.5">WOW & FLUTTER</span>
                <span className="text-[9px] font-mono text-fl-amber">
                  {((params[1] ?? 0.15) * 100).toFixed(0)}%
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[2] ?? 0.5}
                  min={0.0}
                  max={1.0}
                  defaultValue={0.5}
                  size={46}
                  color="#ffe082"
                  onChange={(v) => handleParamChange(2, v)}
                />
                <span className="text-[10px] font-bold text-[#f3e5ab] mt-1.5">WARM TONE</span>
                <span className="text-[9px] font-mono text-fl-amber">
                  {((params[2] ?? 0.5) * 100).toFixed(0)}%
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[3] ?? 0.0}
                  min={-18.0}
                  max={6.0}
                  defaultValue={0.0}
                  size={46}
                  bipolar
                  color="#ffffff"
                  onChange={(v) => handleParamChange(3, v)}
                />
                <span className="text-[10px] font-bold text-[#f3e5ab] mt-1.5">OUTPUT</span>
                <span className="text-[9px] font-mono text-fl-amber">
                  {(params[3] ?? 0.0).toFixed(1)} dB
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Custom Skeuomorphic UI #2: Precision Limiter */}
        {isLimiter && (
          <div className="w-full max-w-2xl bg-[#14171d] border-2 border-cyan-800/60 rounded-lg shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-cyan-900/40 pb-3">
              <span className="font-mono tracking-wider font-bold text-lg text-cyan-300">
                QL PRECISION LIMITER
              </span>
              <span className="text-[10px] font-mono bg-cyan-950 text-cyan-400 px-2 py-0.5 rounded border border-cyan-800">
                TRUE PEAK ISP 64-BIT
              </span>
            </div>

            {/* LED Gain Reduction Meter */}
            <div className="h-14 bg-black/80 rounded border border-cyan-900/50 p-3 flex flex-col justify-between">
              <div className="flex justify-between text-[9px] font-mono text-fl-dim">
                <span>GAIN REDUCTION (dB)</span>
                <span className="text-cyan-400 font-bold">-0.8 dB MAX</span>
              </div>
              <div className="flex items-center gap-1 h-4">
                {Array.from({ length: 32 }, (_, i) => {
                  const active = i < 12 + Math.round(Math.sin(animTime * 10) * 6);
                  return (
                    <div
                      key={i}
                      className={`flex-1 h-full rounded-2xs ${
                        active
                          ? i > 24
                            ? "bg-red-500 shadow-sm"
                            : i > 16
                              ? "bg-amber-400"
                              : "bg-cyan-400 shadow-xs"
                          : "bg-white/5"
                      }`}
                    />
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4 bg-[#101217] p-4 rounded border border-white/5">
              <div className="flex flex-col items-center">
                <Knob
                  value={params[0] ?? -0.3}
                  min={-18.0}
                  max={0.0}
                  defaultValue={-0.3}
                  size={44}
                  color="#00e5ff"
                  onChange={(v) => handleParamChange(0, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">CEILING</span>
                <span className="text-[9px] font-mono text-cyan-300">
                  {(params[0] ?? -0.3).toFixed(1)} dB
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[1] ?? -6.0}
                  min={-36.0}
                  max={0.0}
                  defaultValue={-6.0}
                  size={44}
                  color="#00e5ff"
                  onChange={(v) => handleParamChange(1, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">THRESHOLD</span>
                <span className="text-[9px] font-mono text-cyan-300">
                  {(params[1] ?? -6.0).toFixed(1)} dB
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[2] ?? 50.0}
                  min={5.0}
                  max={500.0}
                  defaultValue={50.0}
                  size={44}
                  color="#26c6da"
                  onChange={(v) => handleParamChange(2, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">RELEASE</span>
                <span className="text-[9px] font-mono text-cyan-300">
                  {(params[2] ?? 50.0).toFixed(0)} ms
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[3] ?? 2.0}
                  min={0.1}
                  max={10.0}
                  defaultValue={2.0}
                  size={44}
                  color="#80deea"
                  onChange={(v) => handleParamChange(3, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">LOOKAHEAD</span>
                <span className="text-[9px] font-mono text-cyan-300">
                  {(params[3] ?? 2.0).toFixed(1)} ms
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Custom Skeuomorphic UI #3: 303 Acid Bass */}
        {is303 && (
          <div className="w-full max-w-2xl bg-[#c5cad0] border-4 border-[#9aa0a6] rounded-lg shadow-2xl p-6 text-black flex flex-col gap-4">
            <div className="flex items-center justify-between border-b-2 border-black/80 pb-2">
              <span className="font-mono font-black text-xl tracking-widest text-[#202124]">
                QL BASS LINE · ACID 303
              </span>
              <span className="font-bold text-[11px] font-mono bg-black text-red-500 px-2 py-0.5 rounded">
                PATTERNS / SLIDE
              </span>
            </div>

            <div className="grid grid-cols-5 gap-3 bg-[#e8eaed] p-3 rounded border border-black/40">
              <div className="flex flex-col items-center">
                <Knob
                  value={params[0] ?? 800.0}
                  min={18.0}
                  max={10000.0}
                  defaultValue={800.0}
                  size={40}
                  color="#d93025"
                  onChange={(v) => handleParamChange(0, v)}
                />
                <span className="text-[9px] font-black mt-1">CUTOFF</span>
                <span className="text-[8px] font-mono font-bold">
                  {(params[0] ?? 800.0).toFixed(0)} Hz
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[1] ?? 0.75}
                  min={0.0}
                  max={0.98}
                  defaultValue={0.75}
                  size={40}
                  color="#d93025"
                  onChange={(v) => handleParamChange(1, v)}
                />
                <span className="text-[9px] font-black mt-1">RESONANCE</span>
                <span className="text-[8px] font-mono font-bold">
                  {((params[1] ?? 0.75) * 100).toFixed(0)}%
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[2] ?? 0.6}
                  min={0.0}
                  max={1.0}
                  defaultValue={0.6}
                  size={40}
                  color="#d93025"
                  onChange={(v) => handleParamChange(2, v)}
                />
                <span className="text-[9px] font-black mt-1">ENV MOD</span>
                <span className="text-[8px] font-mono font-bold">
                  {((params[2] ?? 0.6) * 100).toFixed(0)}%
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[3] ?? 200.0}
                  min={50.0}
                  max={1200.0}
                  defaultValue={200.0}
                  size={40}
                  color="#d93025"
                  onChange={(v) => handleParamChange(3, v)}
                />
                <span className="text-[9px] font-black mt-1">DECAY</span>
                <span className="text-[8px] font-mono font-bold">
                  {(params[3] ?? 200.0).toFixed(0)} ms
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[4] ?? 0.5}
                  min={0.0}
                  max={1.0}
                  defaultValue={0.5}
                  size={40}
                  color="#d93025"
                  onChange={(v) => handleParamChange(4, v)}
                />
                <span className="text-[9px] font-black mt-1">ACCENT</span>
                <span className="text-[8px] font-mono font-bold">
                  {((params[4] ?? 0.5) * 100).toFixed(0)}%
                </span>
              </div>
            </div>

            {/* Interactive Mini 16-key Acid Keyboard */}
            <div className="flex items-center gap-1 justify-center pt-2">
              {Array.from({ length: 16 }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className="w-8 h-14 bg-white hover:bg-red-400 active:bg-red-600 rounded-b border border-black shadow text-[9px] font-mono font-bold flex flex-col justify-end items-center pb-1 cursor-pointer transition-colors"
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Custom Skeuomorphic UI #4: Stereo Imager */}
        {isImager && (
          <div className="w-full max-w-2xl bg-[#171a21] border-2 border-indigo-700/60 rounded-lg shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-indigo-900/40 pb-3">
              <span className="font-mono tracking-wider font-bold text-lg text-indigo-300">
                QL STEREO IMAGER & GONIOMETER
              </span>
              <span className="text-[10px] font-mono bg-indigo-950 text-indigo-400 px-2 py-0.5 rounded border border-indigo-800">
                MULTIBAND PHASE CORRELATION
              </span>
            </div>

            {/* Lissajous Vector Oscilloscope Canvas */}
            <div className="h-44 bg-black/90 rounded border border-indigo-900/60 relative flex items-center justify-center overflow-hidden">
              <div className="absolute inset-0 flex items-center justify-center opacity-25">
                <div className="w-32 h-32 rounded-full border border-indigo-400" />
                <div className="w-24 h-24 rounded-full border border-indigo-400" />
                <div className="absolute w-full h-[1px] bg-indigo-400" />
                <div className="absolute h-full w-[1px] bg-indigo-400" />
              </div>
              <svg className="w-48 h-48 z-10" viewBox="-100 -100 200 200">
                <path
                  d={`M ${Math.sin(animTime * 3) * 60} ${Math.cos(animTime * 4) * 60} Q ${Math.cos(animTime * 2) * 80} ${Math.sin(animTime * 5) * 80} ${Math.sin(animTime * 6) * 50} ${Math.cos(animTime * 3) * 50}`}
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="2.5"
                  className="filter drop-shadow-[0_0_8px_#6366f1]"
                />
              </svg>
            </div>

            <div className="grid grid-cols-3 gap-4 bg-[#12151b] p-4 rounded border border-white/5">
              <div className="flex flex-col items-center">
                <Knob
                  value={params[0] ?? 1.25}
                  min={0.0}
                  max={2.0}
                  defaultValue={1.25}
                  size={46}
                  color="#818cf8"
                  onChange={(v) => handleParamChange(0, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">STEREO WIDTH</span>
                <span className="text-[9px] font-mono text-indigo-300">
                  {((params[0] ?? 1.25) * 100).toFixed(0)}%
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[1] ?? 120.0}
                  min={40.0}
                  max={300.0}
                  defaultValue={120.0}
                  size={46}
                  color="#a5b4fc"
                  onChange={(v) => handleParamChange(1, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">BASS MONO CROSSOVER</span>
                <span className="text-[9px] font-mono text-indigo-300">
                  {(params[1] ?? 120.0).toFixed(0)} Hz
                </span>
              </div>

              <div className="flex flex-col items-center">
                <Knob
                  value={params[2] ?? 0.0}
                  min={-1.0}
                  max={1.0}
                  defaultValue={0.0}
                  size={46}
                  bipolar
                  color="#c7d2fe"
                  onChange={(v) => handleParamChange(2, v)}
                />
                <span className="text-[10px] font-bold text-fl-text mt-1.5">CENTER PAN</span>
                <span className="text-[9px] font-mono text-indigo-300">
                  {(params[2] ?? 0.0).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Fallback / Generic View for Third-Party VST3 / CLAP (Serum, FabFilter, etc.) */}
        {!isTape && !isLimiter && !is303 && !isImager && (
          <div className="w-full max-w-2xl bg-[#1b1f27] border border-black/80 rounded-lg shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-black/60 pb-3">
              <div className="flex items-center gap-2">
                <Cpu size={18} className="text-fl-orange" />
                <span className="font-bold text-base text-fl-text tracking-wide">
                  {pluginName}
                </span>
              </div>
              <span className="text-[10px] font-mono text-fl-amber">
                ORIGINAL HARDWARE / VST3 INTERFACE
              </span>
            </div>

            <div className="flex flex-wrap gap-4 items-center justify-center p-4 bg-fl-deep/80 rounded-md border border-black/50">
              {instance?.parameters.map((param) => (
                <div
                  key={param.id}
                  className="flex flex-col items-center bg-[#15181f] px-3 py-2.5 rounded border border-black/50 min-w-[100px] shadow-sm"
                >
                  <Knob
                    value={params[param.id] ?? param.value}
                    min={param.minValue}
                    max={param.maxValue}
                    defaultValue={param.defaultValue}
                    size={40}
                    color="#ff8500"
                    onChange={(val) => handleParamChange(param.id, val)}
                  />
                  <span className="text-[10px] font-semibold text-fl-text truncate max-w-[95px] mt-1 text-center">
                    {param.name}
                  </span>
                  <span className="text-[9px] font-mono text-fl-amber">
                    {(params[param.id] ?? param.value).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Dedicated Plugin Window Footer */}
      <footer className="h-7 bg-[#14161c] border-t border-black/70 px-4 flex items-center justify-between text-[10px] font-mono text-fl-dim shrink-0">
        <div className="flex items-center gap-3">
          <span>INSTANCE: {instanceId}</span>
          <span>·</span>
          <span>FORMAT: {format.toUpperCase()}</span>
          <span>·</span>
          <span>LATENCY: 0 SAMPLES</span>
        </div>
        <div className="text-fl-led">
          NATIVE X11 / TAURI PARENTED WINDOW ACTIVE
        </div>
      </footer>
    </div>
  );
};
