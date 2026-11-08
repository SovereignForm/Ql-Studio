/**
 * QL STUDIO — VST3 & CLAP Plugin Manager & Parameter Tweak Host
 *
 * Allows producers to:
 * 1. Scan system VST3 & CLAP plugin paths (`/usr/lib/vst3`, `~/.vst3`, `/usr/lib/clap`, etc.)
 * 2. Browse installed plugins with format badges and vendor metadata
 * 3. Load VST3/CLAP plugins into any of the 65 Mixer Insert FX slots or Channel Rack
 * 4. Tweak plugin parameters live with interactive knobs, sliders, and real-time DSP preview.
 */

import React, { useState } from "react";
import {
  Cpu,
  RefreshCw,
  Search,
  Sliders,
  Sparkles,
  Trash2,
  X,
  Plus,
  Layers,
  CheckCircle2,
} from "lucide-react";
import type {
  PluginDescriptor,
  PluginInstanceSummary,
} from "../schemas.ts";
import { Knob } from "../ui/primitives.tsx";

export interface PluginManagerModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly availablePlugins: readonly PluginDescriptor[];
  readonly loadedPlugins: readonly PluginInstanceSummary[];
  readonly onScanPlugins: (customPaths?: string[]) => Promise<void>;
  readonly onLoadPlugin: (
    pluginId: string,
    targetKind: "mixer_slot" | "channel",
    targetIndex: number,
    slotIndex?: number,
  ) => Promise<void>;
  readonly onSetParameter: (
    instanceId: string,
    paramId: number,
    value: number,
  ) => Promise<void>;
  readonly onUnloadPlugin: (instanceId: string) => Promise<void>;
}

export const PluginManagerModal: React.FC<PluginManagerModalProps> = React.memo((props) => {
  const {
    open,
    onClose,
    availablePlugins,
    loadedPlugins,
    onScanPlugins,
    onLoadPlugin,
    onSetParameter,
    onUnloadPlugin,
  } = props;

  const [activeTab, setActiveTab] = useState<"catalog" | "active">("catalog");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterFormat, setFilterFormat] = useState<"all" | "vst3" | "clap" | "builtin">("all");
  const [filterCategory, setFilterCategory] = useState<"all" | "instrument" | "effect">("all");
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  // Selected target mixer insert
  const [selectedInsert, setSelectedInsert] = useState<number>(1);
  const [selectedSlot, setSelectedSlot] = useState<number>(0);

  if (!open) return null;

  const handleScan = async () => {
    setScanning(true);
    setScanMessage("Scanning system directories (/usr/lib/vst3, ~/.vst3, /usr/lib/clap)...");
    try {
      await onScanPlugins();
      setScanMessage("System plugin scan completed!");
    } catch (err) {
      setScanMessage(`Scan error: ${err}`);
    } finally {
      setScanning(false);
      setTimeout(() => setScanMessage(null), 4000);
    }
  };

  const filteredPlugins = availablePlugins.filter((p) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = p.name.toLowerCase().includes(q);
      const matchVendor = p.vendor.toLowerCase().includes(q);
      if (!matchName && !matchVendor) return false;
    }
    if (filterFormat !== "all" && p.format !== filterFormat) return false;
    if (filterCategory !== "all" && p.category !== filterCategory) return false;
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs select-none">
      <div className="w-[840px] h-[580px] bg-[#1e2229] border border-black/80 rounded shadow-2xl flex flex-col overflow-hidden text-fl-text">
        {/* Modal Window Header */}
        <div className="h-9 px-3 bg-[#262b34] border-b border-black/80 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-fl-amber" />
            <span className="text-[12px] font-bold tracking-wide">
              VST3 & CLAP PLUGIN HOST & MANAGER
            </span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-fl-deep text-fl-led border border-black/60">
              ZERO-CRACKLE DSP CORE
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-fl-dim hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        {/* Top Control Bar: Tabs, Search, Scan Button */}
        <div className="p-2.5 bg-[#1b1e25] border-b border-black/60 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1 bg-fl-deep rounded p-0.5 border border-black/60 fl-inset">
            <button
              type="button"
              onClick={() => setActiveTab("catalog")}
              className={`px-3 py-1 rounded text-[11px] font-bold cursor-pointer transition-colors ${
                activeTab === "catalog"
                  ? "bg-fl-orange text-black"
                  : "text-fl-dim hover:text-fl-text"
              }`}
            >
              Plugin Catalog ({availablePlugins.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("active")}
              className={`px-3 py-1 rounded text-[11px] font-bold cursor-pointer transition-colors ${
                activeTab === "active"
                  ? "bg-fl-orange text-black"
                  : "text-fl-dim hover:text-fl-text"
              }`}
            >
              Active Loaded Instances ({loadedPlugins.length})
            </button>
          </div>

          <div className="flex items-center gap-2 flex-1 justify-end">
            {activeTab === "catalog" && (
              <>
                <div className="relative w-56">
                  <Search size={12} className="absolute left-2.5 top-2 text-fl-dim" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search plugins & vendors..."
                    className="w-full h-7 bg-fl-deep pl-8 pr-2 text-[11px] rounded border border-black/60 text-fl-text focus:outline-none focus:border-fl-amber font-mono"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleScan}
                  disabled={scanning}
                  className="px-3 h-7 rounded bg-fl-raised hover:bg-white/10 border border-black/60 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw size={12} className={scanning ? "animate-spin text-fl-amber" : ""} />
                  {scanning ? "Scanning..." : "Scan System"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Scan notification banner */}
        {scanMessage && (
          <div className="px-3 py-1 bg-fl-deep/90 border-b border-black/40 text-[10px] font-mono text-fl-led flex items-center gap-1.5">
            <CheckCircle2 size={11} className="text-fl-amber" />
            {scanMessage}
          </div>
        )}

        {/* Main Tab Views */}
        <div className="flex-1 overflow-hidden p-3 bg-[#181a1f]">
          {activeTab === "catalog" ? (
            <div className="flex flex-col h-full gap-2">
              {/* Filter Pills */}
              <div className="flex items-center justify-between text-[10px] shrink-0">
                <div className="flex items-center gap-1">
                  <span className="text-fl-dim mr-1">Format:</span>
                  {(["all", "vst3", "clap", "builtin"] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setFilterFormat(fmt)}
                      className={`px-2 py-0.5 rounded cursor-pointer uppercase font-mono ${
                        filterFormat === fmt
                          ? "bg-fl-amber text-black font-bold"
                          : "bg-fl-deep text-fl-dim hover:text-fl-text"
                      }`}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1">
                  <span className="text-fl-dim mr-1">Type:</span>
                  {(["all", "instrument", "effect"] as const).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setFilterCategory(cat)}
                      className={`px-2 py-0.5 rounded cursor-pointer capitalize ${
                        filterCategory === cat
                          ? "bg-fl-amber text-black font-bold"
                          : "bg-fl-deep text-fl-dim hover:text-fl-text"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Plugin List Table */}
              <div className="flex-1 overflow-auto fl-scroll border border-black/60 rounded bg-[#131518]">
                <div className="grid grid-cols-12 gap-2 px-3 py-1.5 bg-[#1b1e24] border-b border-black/60 text-[10px] font-mono text-fl-dim sticky top-0 z-10">
                  <span className="col-span-5">PLUGIN NAME</span>
                  <span className="col-span-2">VENDOR</span>
                  <span className="col-span-1">FORMAT</span>
                  <span className="col-span-1">CATEGORY</span>
                  <span className="col-span-3 text-right">INSERT TARGET</span>
                </div>

                {filteredPlugins.length === 0 ? (
                  <div className="p-8 text-center text-fl-dim text-[11px]">
                    No plugins match query. Click "Scan System" to discover VST3 / CLAP plugins on disk.
                  </div>
                ) : (
                  filteredPlugins.map((plugin) => (
                    <div
                      key={plugin.id}
                      className="grid grid-cols-12 gap-2 px-3 py-2 border-b border-black/30 items-center hover:bg-white/5 transition-colors text-[11px]"
                    >
                      <div className="col-span-5 flex items-center gap-2 min-w-0">
                        {plugin.category === "instrument" ? (
                          <Sparkles size={13} className="text-fl-amber shrink-0" />
                        ) : (
                          <Sliders size={13} className="text-fl-led shrink-0" />
                        )}
                        <span className="font-semibold text-fl-text truncate">
                          {plugin.name}
                        </span>
                      </div>

                      <span className="col-span-2 text-fl-dim truncate text-[10px]">
                        {plugin.vendor}
                      </span>

                      <div className="col-span-1">
                        <span
                          className={`text-[9px] font-mono px-1 py-0.5 rounded uppercase font-bold ${
                            plugin.format === "vst3"
                              ? "bg-blue-900/60 text-blue-300"
                              : plugin.format === "clap"
                              ? "bg-purple-900/60 text-purple-300"
                              : "bg-amber-900/60 text-amber-300"
                          }`}
                        >
                          {plugin.format}
                        </span>
                      </div>

                      <span className="col-span-1 text-[10px] text-fl-dim capitalize">
                        {plugin.category}
                      </span>

                      <div className="col-span-3 flex items-center justify-end gap-1.5">
                        <select
                          value={selectedInsert}
                          onChange={(e) => setSelectedInsert(Number(e.target.value))}
                          className="bg-fl-deep border border-black/60 rounded px-1 text-[10px] text-fl-text cursor-pointer"
                        >
                          <option value={0}>Master (0)</option>
                          {Array.from({ length: 64 }, (_, i) => (
                            <option key={i + 1} value={i + 1}>
                              Insert {i + 1}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => {
                            void onLoadPlugin(
                              plugin.id,
                              plugin.category === "instrument" ? "channel" : "mixer_slot",
                              selectedInsert,
                              selectedSlot,
                            );
                            setActiveTab("active");
                          }}
                          className="px-2 py-1 rounded bg-fl-orange hover:bg-fl-amber text-black font-bold text-[10px] flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Plus size={11} /> Load
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Active Loaded Instances & Live Parameters Inspector */
            <div className="flex flex-col h-full gap-3 overflow-auto fl-scroll">
              {loadedPlugins.length === 0 ? (
                <div className="p-12 text-center text-fl-dim text-[11px] flex flex-col items-center gap-2">
                  <Sliders size={28} className="text-fl-dim/40" />
                  <span>No plugins loaded yet into Mixer slots or Channel Rack.</span>
                  <span className="text-[10px]">
                    Go to the <b>Plugin Catalog</b> tab and click <b>+ Load</b> on any plugin!
                  </span>
                </div>
              ) : (
                loadedPlugins.map((inst) => (
                  <div
                    key={inst.instanceId}
                    className="p-3 rounded bg-[#1b1e25] border border-black/80 flex flex-col gap-3 shadow-sm"
                  >
                    <div className="flex items-center justify-between border-b border-black/50 pb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase font-bold ${
                            inst.descriptor.format === "vst3"
                              ? "bg-blue-900/60 text-blue-300"
                              : "bg-purple-900/60 text-purple-300"
                          }`}
                        >
                          {inst.descriptor.format}
                        </span>
                        <span className="text-[13px] font-bold text-fl-text">
                          {inst.descriptor.name}
                        </span>
                        <span className="text-[10px] text-fl-amber font-mono">
                          [{inst.targetKind === "mixer_slot" ? `MIXER INSERT ${inst.targetIndex} (SLOT #${(inst.slotIndex ?? 0) + 1})` : `CHANNEL #${inst.targetIndex}`}]
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void onUnloadPlugin(inst.instanceId)}
                          className="px-2 py-1 rounded bg-red-900/60 hover:bg-red-800 text-red-200 text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 size={11} /> Unload
                        </button>
                      </div>
                    </div>

                    {/* Exposed Plugin Parameter Knobs & Sliders */}
                    <div className="flex flex-wrap gap-4 items-center pt-1">
                      {inst.parameters.map((param) => (
                        <div
                          key={param.id}
                          className="flex flex-col items-center bg-fl-deep/60 px-3 py-2 rounded border border-black/40 min-w-[90px]"
                        >
                          <Knob
                            value={param.value}
                            min={param.minValue}
                            max={param.maxValue}
                            defaultValue={param.defaultValue}
                            size={32}
                            color="#ff8500"
                            onChange={(val) => {
                              void onSetParameter(inst.instanceId, param.id, val);
                            }}
                          />
                          <span className="text-[9px] font-semibold text-fl-text truncate max-w-[85px] mt-1 text-center">
                            {param.name}
                          </span>
                          <span className="text-[9px] font-mono text-fl-amber">
                            {param.value.toFixed(1)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Modal Window Footer */}
        <div className="h-8 px-3 bg-[#1e2229] border-t border-black/70 flex items-center justify-between text-[10px] text-fl-dim shrink-0">
          <span>Standard paths: /usr/lib/vst3 · ~/.vst3 · /usr/lib/clap · ~/.clap</span>
          <span>Zero-crackle 1024-sample hardware lock-free architecture</span>
        </div>
      </div>
    </div>
  );
});
