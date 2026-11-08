/**
 * FL-style browser tree. Includes the bundled 4-piece PCM `.wav` studio drum kit
 * (`kick_808.wav`, `clap_studio.wav`, `hihat_closed.wav`, `snare_808.wav`) decoded via `hound`,
 * oscillator presets, and custom `.wav` disk loading.
 * Dragging an item onto a Channel Rack row replaces that channel's sample/generator.
 */
import {
  AudioWaveform,
  Bone,
  ChevronDown,
  ChevronRight,
  Drum,
  FileAudio,
  Folder,
  FolderOpen,
  History,
  Mic,
  Piano,
  Plug,
  Search,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WaveformShape } from "../schemas.ts";

export const BROWSER_DRAG_MIME = "application/x-ql-browser-item";

export interface BrowserItem {
  readonly id: string;
  readonly name: string;
  readonly kind: "audio" | "plugin";
  readonly waveform: WaveformShape;
  readonly rootMidiNote: number;
  readonly sampleSlot?: number;
  readonly samplePath?: string;
}

interface BrowserFolder {
  readonly id: string;
  readonly name: string;
  readonly icon: React.ReactNode;
  readonly children: readonly (BrowserFolder | BrowserItem)[];
}

const isFolder = (n: BrowserFolder | BrowserItem): n is BrowserFolder => "children" in n;

const item = (
  id: string,
  name: string,
  waveform: WaveformShape,
  root: number,
  kind: BrowserItem["kind"] = "audio",
  sampleSlot?: number,
  samplePath?: string,
): BrowserItem => ({
  id,
  name,
  kind,
  waveform,
  rootMidiNote: root,
  sampleSlot,
  samplePath,
});

function buildTree(
  patternNames: readonly string[],
  channelNames: readonly string[],
  customWavItems: readonly BrowserItem[],
): BrowserFolder[] {
  return [
    {
      id: "current",
      name: "Current project",
      icon: <History size={13} />,
      children: [
        { id: "cur-hist", name: "History", icon: <History size={12} />, children: [] },
        {
          id: "cur-pat",
          name: "Patterns",
          icon: <Folder size={12} />,
          children: patternNames.map((n, i) => item(`pat-${i}`, n, "sine", 60, "plugin")),
        },
        {
          id: "cur-gen",
          name: "Generators",
          icon: <Plug size={12} />,
          children: channelNames.map((n, i) => item(`gen-${i}`, n, "sawtooth", 60, "plugin")),
        },
        {
          id: "cur-fx",
          name: "Effects",
          icon: <Plug size={12} />,
          children: [item("fx-eq", "Parametric EQ (RBJ biquad)", "sine", 60, "plugin")],
        },
      ],
    },
    {
      id: "packs",
      name: "Packs (PCM WAV + Synth)",
      icon: <Folder size={13} />,
      children: [
        {
          id: "starter-wav",
          name: "Starter Studio Kit (.wav)",
          icon: <Drum size={12} />,
          children: [
            item("wav-kick", "808 Kick (kick_808.wav)", "sampler_pcm", 60, "audio", 0, "samples/kick_808.wav"),
            item("wav-clap", "Studio Clap (clap_studio.wav)", "sampler_pcm", 60, "audio", 1, "samples/clap_studio.wav"),
            item("wav-hat", "Closed Hi-Hat (hihat_closed.wav)", "sampler_pcm", 60, "audio", 2, "samples/hihat_closed.wav"),
            item("wav-snare", "808 Snare (snare_808.wav)", "sampler_pcm", 60, "audio", 3, "samples/snare_808.wav"),
            ...customWavItems,
          ],
        },
        {
          id: "drums",
          name: "Synth Drums",
          icon: <Drum size={12} />,
          children: [
            {
              id: "kick",
              name: "Kick",
              icon: <Folder size={12} />,
              children: [
                item("k1", "Sub Kick 808", "sine", 36),
                item("k2", "Punch Kick", "sine", 40),
                item("k3", "Tri Kick", "triangle", 38),
              ],
            },
            {
              id: "snare",
              name: "Snare",
              icon: <Folder size={12} />,
              children: [
                item("s1", "Noise Snare", "noise", 62),
                item("s2", "Crisp Clap", "noise", 64),
              ],
            },
            {
              id: "hat",
              name: "HiHat",
              icon: <Folder size={12} />,
              children: [
                item("h1", "Closed Hat", "noise", 84),
                item("h2", "Open Hat", "noise", 80),
              ],
            },
            {
              id: "perc",
              name: "Perc",
              icon: <Folder size={12} />,
              children: [
                item("p1", "Square Blip", "pulse", 76),
                item("p2", "Tri Tom", "triangle", 50),
              ],
            },
          ],
        },
        {
          id: "instr",
          name: "Instruments",
          icon: <Piano size={12} />,
          children: [
            {
              id: "bass",
              name: "Bass",
              icon: <Folder size={12} />,
              children: [
                item("b1", "Saw Sub Bass", "sawtooth", 36),
                item("b2", "Square Reese", "pulse", 36),
              ],
            },
            {
              id: "keys",
              name: "Keys",
              icon: <Folder size={12} />,
              children: [
                item("kk1", "Sine Keys", "sine", 60),
                item("kk2", "Tri E-Piano", "triangle", 60),
              ],
            },
            {
              id: "synth",
              name: "Synth",
              icon: <Folder size={12} />,
              children: [
                item("sy1", "Saw Lead", "sawtooth", 72),
                item("sy2", "Pulse Pluck", "pulse", 67),
              ],
            },
          ],
        },
      ],
    },
    { id: "bones", name: "Project bones", icon: <Bone size={13} />, children: [] },
    { id: "rec", name: "Recorded audio", icon: <Mic size={13} />, children: [] },
  ];
}

type FilterTab = "all" | "audio" | "plugin";

export interface BrowserSidebarProps {
  readonly patternNames: readonly string[];
  readonly channelNames: readonly string[];
  readonly customWavItems?: readonly BrowserItem[];
  readonly onLoadWavForSelectedChannel?: () => void;
  readonly onAuditionItem?: (item: BrowserItem) => void;
}

export const BrowserSidebar: React.FC<BrowserSidebarProps> = React.memo(({
  patternNames,
  channelNames,
  customWavItems = [],
  onLoadWavForSelectedChannel,
  onAuditionItem,
}) => {
  const tree = useMemo(
    () => buildTree(patternNames, channelNames, customWavItems),
    [patternNames, channelNames, customWavItems],
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(["packs", "starter-wav", "drums", "kick", "current"]),
  );
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [selected, setSelected] = useState<BrowserItem | null>(null);

  const matches = (it: BrowserItem) =>
    (tab === "all" || it.kind === tab) &&
    it.name.toLowerCase().includes(query.trim().toLowerCase());

  const folderHasMatch = (f: BrowserFolder): boolean =>
    f.children.some((c) => (isFolder(c) ? folderHasMatch(c) : matches(c)));

  const filtering = query.trim().length > 0 || tab !== "all";

  const renderNode = (node: BrowserFolder | BrowserItem, depth: number): React.ReactNode => {
    const pad = { paddingLeft: 6 + depth * 12 };
    if (isFolder(node)) {
      if (filtering && !folderHasMatch(node) && node.children.length > 0) return null;
      const open = filtering || expanded.has(node.id);
      return (
        <div key={node.id}>
          <button
            type="button"
            style={pad}
            onClick={() =>
              setExpanded((s) => {
                const n = new Set(s);
                if (n.has(node.id)) n.delete(node.id);
                else n.add(node.id);
                return n;
              })
            }
            className="w-full h-[20px] flex items-center gap-1 text-left text-[11px] text-fl-text hover:bg-white/5 cursor-pointer"
          >
            {open ? (
              <ChevronDown size={11} className="text-fl-dim" />
            ) : (
              <ChevronRight size={11} className="text-fl-dim" />
            )}
            <span className="text-fl-amber">{open ? <FolderOpen size={12} /> : node.icon}</span>
            <span className="truncate">{node.name}</span>
          </button>
          {open && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    if (!matches(node)) return null;
    const isSel = selected?.id === node.id;
    return (
      <div
        key={node.id}
        style={pad}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(BROWSER_DRAG_MIME, JSON.stringify(node));
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => {
          setSelected(node);
          onAuditionItem?.(node);
        }}
        className={`h-[20px] flex items-center gap-1.5 text-[11px] cursor-grab ${
          isSel ? "bg-fl-orange/25 text-white" : "text-fl-text/90 hover:bg-white/5"
        }`}
        title="Drag onto a Channel Rack row to assign sample/generator"
      >
        <AudioWaveform
          size={11}
          className={
            node.waveform === "sampler_pcm"
              ? "text-fl-orange"
              : node.kind === "audio"
                ? "text-fl-led"
                : "text-sky-400"
          }
        />
        <span className="truncate">{node.name}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[#1d2025]">
      <div className="p-1.5 border-b border-black/70 space-y-1.5">
        <div className="flex items-center gap-1 bg-fl-deep fl-inset rounded px-1.5 h-6">
          <Search size={11} className="text-fl-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search samples & presets..."
            className="flex-1 bg-transparent outline-none text-[11px] text-fl-text placeholder:text-fl-dim"
          />
        </div>
        <div className="flex gap-0.5">
          {(["all", "audio", "plugin"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 h-5 text-[10px] font-semibold rounded-sm cursor-pointer fl-bevel ${
                tab === t ? "bg-fl-orange text-black" : "bg-fl-raised text-fl-dim hover:text-fl-text"
              }`}
            >
              {t === "all" ? "All" : t === "audio" ? "Audio" : "Plugins"}
            </button>
          ))}
        </div>
        {onLoadWavForSelectedChannel && (
          <button
            type="button"
            onClick={onLoadWavForSelectedChannel}
            className="w-full h-6 flex items-center justify-center gap-1.5 text-[10px] font-semibold rounded-sm bg-fl-raised hover:bg-fl-orange hover:text-black text-fl-amber fl-bevel cursor-pointer transition-colors"
            title="Load a .wav file from disk into the selected channel via hound"
          >
            <FileAudio size={11} /> Load .WAV into Selected Channel
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto fl-scroll py-1">{tree.map((n) => renderNode(n, 0))}</div>
      <WaveformPreview item={selected} />
    </div>
  );
});
BrowserSidebar.displayName = "BrowserSidebar";

/** Draws waveform preview of the selected sample or oscillator shape. */
const WaveformPreview: React.FC<{ readonly item: BrowserItem | null }> = ({ item: it }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#0b0d0f";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(0, c.height / 2);
    ctx.lineTo(c.width, c.height / 2);
    ctx.stroke();
    if (!it) return;
    ctx.strokeStyle = it.waveform === "sampler_pcm" ? "#00e676" : "#ff8500";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let seed = 1234567;
    const cycles = it.waveform === "sampler_pcm" ? 9 : 6;
    for (let x = 0; x < c.width; x++) {
      const normX = x / c.width;
      const t = normX * cycles;
      const ph = t - Math.floor(t);
      const env = Math.exp(-normX * (it.sampleSlot === 2 ? 5.5 : 2.6));
      let v: number;
      if (it.waveform === "sampler_pcm") {
        if (it.sampleSlot === 0) {
          v = Math.sin(Math.pow(normX, 0.45) * 42);
        } else {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          const noise = ((seed >>> 0) / 0xffffffff) * 2 - 1;
          v = 0.65 * noise + 0.35 * Math.sin(ph * Math.PI * 2);
        }
      } else {
        switch (it.waveform) {
          case "sine":
            v = Math.sin(ph * Math.PI * 2);
            break;
          case "triangle":
            v = 1 - 4 * Math.abs(ph - 0.5);
            break;
          case "sawtooth":
            v = 2 * ph - 1;
            break;
          case "pulse":
            v = ph < 0.5 ? 1 : -1;
            break;
          default:
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            v = ((seed >>> 0) / 0xffffffff) * 2 - 1;
        }
      }
      const y = c.height / 2 - v * env * (c.height * 0.42);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [it]);
  return (
    <div className="border-t border-black/70 p-1.5">
      <div className="text-[10px] text-fl-dim mb-1 truncate">
        {it
          ? `${it.name} · ${it.waveform === "sampler_pcm" ? "PCM WAV (Hermite 4-pt)" : it.waveform}`
          : "Select or drag a sample to preview"}
      </div>
      <canvas ref={ref} width={220} height={48} className="w-full h-12 rounded fl-inset" />
    </div>
  );
};
