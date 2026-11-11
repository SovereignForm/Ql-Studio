import { CheckCircle2, Circle, Headphones, Mic, Music, Volume2, X } from "lucide-react";
import React, { useState } from "react";
import type { AudioInputDeviceInfo } from "../schemas.ts";

export interface RecordAudioModalProps {
  readonly open: boolean;
  readonly isRecording: boolean;
  readonly isPlaying: boolean;
  readonly inputDevices: readonly AudioInputDeviceInfo[];
  readonly selectedDevice: string;
  readonly destinationTrackIndex: number;
  readonly trackCount?: number;
  readonly liveMonitoring: boolean;
  readonly onSelectDevice: (deviceName: string) => void;
  readonly onSelectTrack: (trackIndex: number) => void;
  readonly onToggleMonitoring: (enabled: boolean) => void;
  readonly onStartRecording: () => void;
  readonly onStopRecording: () => void;
  readonly onClose: () => void;
}

export const RecordAudioModal: React.FC<RecordAudioModalProps> = ({
  open,
  isRecording,
  isPlaying,
  inputDevices,
  selectedDevice,
  destinationTrackIndex,
  trackCount = 16,
  liveMonitoring,
  onSelectDevice,
  onSelectTrack,
  onToggleMonitoring,
  onStartRecording,
  onStopRecording,
  onClose,
}) => {
  const [recordMode, setRecordMode] = useState<"audio" | "midi">("audio");

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 backdrop-blur-xs select-none"
      onPointerDown={onClose}
    >
      <div
        className="w-[480px] rounded-lg bg-[#20242b] border border-[#ff3d3d]/50 shadow-[0_16px_50px_rgba(0,0,0,0.9)] overflow-hidden"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Title Bar */}
        <div className="h-9 px-3.5 flex items-center justify-between bg-[#191d22] border-b border-black/80">
          <div className="flex items-center gap-2 text-[12px] font-black tracking-wider text-red-400">
            <Mic size={14} className="text-red-400 drop-shadow-[0_0_8px_#ff3d3d]" />
            <span>RECORD AUDIO & VOCALS</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-5 h-5 grid place-items-center rounded hover:bg-red-500/80 text-white/70 hover:text-white transition-colors cursor-pointer"
          >
            <X size={13} />
          </button>
        </div>

        <div className="p-5 space-y-4 text-[11px] text-fl-text">
          {/* FL-Style Mode Selection Cards */}
          <div className="space-y-1.5">
            <span className="text-[10px] font-bold tracking-wider uppercase text-fl-dim">
              What would you like to record?
            </span>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRecordMode("audio")}
                className={`p-3 rounded border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                  recordMode === "audio"
                    ? "bg-red-500/15 border-red-500/80 shadow-[0_0_12px_rgba(255,61,61,0.25)]"
                    : "bg-white/[0.03] border-white/10 hover:border-white/20 text-fl-dim"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5 text-[11px]">
                    <Mic size={13} className="text-red-400" /> Audio into Playlist
                  </span>
                  {recordMode === "audio" && <CheckCircle2 size={13} className="text-red-400" />}
                </div>
                <span className="text-[9.5px] text-fl-dim leading-tight">
                  Record microphone, vocal, or instrument directly into Playlist as a WAV clip
                </span>
              </button>

              <button
                type="button"
                onClick={() => setRecordMode("midi")}
                className={`p-3 rounded border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                  recordMode === "midi"
                    ? "bg-fl-orange/15 border-fl-orange/80 shadow-[0_0_12px_rgba(255,133,0,0.25)]"
                    : "bg-white/[0.03] border-white/10 hover:border-white/20 text-fl-dim"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5 text-[11px]">
                    <Music size={13} className="text-fl-orange" /> Notes & Automation
                  </span>
                  {recordMode === "midi" && <CheckCircle2 size={13} className="text-fl-orange" />}
                </div>
                <span className="text-[9.5px] text-fl-dim leading-tight">
                  Record MIDI keyboard or PC typing notes directly into active Channel Pattern
                </span>
              </button>
            </div>
          </div>

          {/* Microphone & Device Configuration */}
          <div className="p-3 rounded bg-black/40 border border-white/5 space-y-3">
            <div>
              <label className="text-[10px] font-bold text-fl-dim uppercase tracking-wider block mb-1">
                Microphone / Input Device
              </label>
              <select
                value={selectedDevice}
                onChange={(e) => onSelectDevice(e.target.value)}
                className="w-full bg-[#16191e] border border-white/15 rounded px-2.5 py-1.5 text-[11px] text-white font-mono focus:border-red-400 outline-none cursor-pointer"
              >
                {inputDevices.length === 0 ? (
                  <option value="">Default System Microphone</option>
                ) : (
                  inputDevices.map((dev) => (
                    <option key={dev.name} value={dev.name}>
                      {dev.name} {dev.isDefault ? "(Default System)" : ""}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-fl-dim uppercase tracking-wider block mb-1">
                  Destination Playlist Track
                </label>
                <select
                  value={destinationTrackIndex}
                  onChange={(e) => onSelectTrack(Number(e.target.value))}
                  className="w-full bg-[#16191e] border border-white/15 rounded px-2.5 py-1.5 text-[11px] text-white font-mono focus:border-red-400 outline-none cursor-pointer"
                >
                  {Array.from({ length: trackCount }, (_, i) => (
                    <option key={i} value={i}>
                      Track {i + 1} {i === 0 ? "(Default Audio Lane)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] font-bold text-fl-dim uppercase tracking-wider block mb-1">
                  Headphone Live Monitoring
                </label>
                <button
                  type="button"
                  onClick={() => onToggleMonitoring(!liveMonitoring)}
                  className={`w-full py-1.5 px-2 rounded border text-[10px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                    liveMonitoring
                      ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300"
                      : "bg-white/5 border-white/10 text-fl-dim hover:text-white"
                  }`}
                  title="Only enable with headphones plugged in to avoid feedback loops"
                >
                  <Headphones size={12} />
                  <span>{liveMonitoring ? "MONITORING ON" : "MUTED (SAFE)"}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Action / Recording Execution Bar */}
          <div className="pt-1 flex items-center justify-between">
            <span className="text-[10px] text-fl-dim flex items-center gap-1 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              16-bit 48kHz Broadcast WAV
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded bg-fl-deep hover:bg-white/10 text-[11px] text-fl-text cursor-pointer"
              >
                Cancel
              </button>

              {isRecording ? (
                <button
                  type="button"
                  onClick={() => {
                    onStopRecording();
                    onClose();
                  }}
                  className="px-4 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] flex items-center gap-1.5 shadow-[0_0_12px_#ff3d3d] cursor-pointer animate-pulse"
                >
                  <Circle size={10} fill="currentColor" /> Stop Recording & Save
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onStartRecording();
                    onClose();
                  }}
                  className="px-5 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-black tracking-wider text-[11px] flex items-center gap-1.5 shadow-[0_0_14px_rgba(255,61,61,0.5)] cursor-pointer"
                >
                  <Circle size={10} fill="currentColor" /> START RECORDING NOW
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
