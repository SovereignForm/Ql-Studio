<p align="center">
  <img src="public/logo.svg" width="160" height="160" alt="Ql Studio Logo" />
</p>

<h1 align="center">Ql Studio</h1>

<p align="center">
  <b>High-Performance Next-Generation Digital Audio Workstation (DAW) & Desktop Music Production Suite</b><br>
  Engineered with React 19, Tailwind CSS v4, HTML5 Canvas, and Tauri v2 (Rust Real-Time Audio Core).
</p>

<p align="center">
  <a href="https://github.com/SovereignForm/Ql-Studio/stargazers"><img src="https://img.shields.io/github/stars/SovereignForm/Ql-Studio?style=for-the-badge&logo=star&color=ff8500" alt="GitHub Stars" /></a>
  <a href="https://github.com/SovereignForm/Ql-Studio/releases"><img src="https://img.shields.io/github/v/release/SovereignForm/Ql-Studio?style=for-the-badge&color=00e676" alt="Latest Release" /></a>
  <a href="#-license"><img src="https://img.shields.io/badge/License-GPLv3%20%2B%20VST%20Exception-38bdf8?style=for-the-badge" alt="License GPLv3 with VST Exception" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Audio%20Core-Rust%20(cpal%20%2B%20rtrb)-orange?style=flat-square" alt="Rust Audio" />
  <img src="https://img.shields.io/badge/Plugin%20Host-VST3%20%2B%20CLAP-red?style=flat-square" alt="VST3 CLAP" />
  <img src="https://img.shields.io/badge/Time--Stretch-WSOLA%20%2B%204--pt%20Hermite-orange?style=flat-square" alt="WSOLA Time-Stretch" />
  <img src="https://img.shields.io/badge/Hardware-USB%20MIDI%20(midir)-yellow?style=flat-square" alt="Hardware MIDI" />
  <img src="https://img.shields.io/badge/WAV%20Sampler-hound%20%2B%20Hermite%204--pt-green?style=flat-square" alt="Hound WAV" />
  <img src="https://img.shields.io/badge/GUI-Tauri%20v2%20%2B%20React%2019-blue?style=flat-square" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/Platforms-Linux%20%7C%20Windows%20%7C%20macOS-purple?style=flat-square" alt="Platforms" />
</p>

---

## ⚡ Key Highlights & Capabilities

### 🔌 VST3 & CLAP Third-Party Plugin Hosting & Dedicated Popout Native Windows
* **Cross-Format Plugin Host (`vst3-host` & `clack-host`):** Scan standard system paths (`/usr/lib/vst3`, `~/.vst3`, `/Library/Audio/Plug-Ins/VST3`, `C:\Program Files\Common Files\VST3`) and host external third-party VST3 / CLAP synthesizers and effects (Serum, FabFilter, Vital, Kontakt, etc.).
* **Dedicated Popout Native Windows (`tauri::WebviewWindow`):** Pop out any loaded plugin into its own dedicated desktop window with native title bar, arbitrary resizing, parameter sync, and floating focus.
* **Studio Hardware-Modeled Skeuomorphic GUI Panels:**
  * **Vintage Tape Saturator:** Brushed aluminum and real wood cheeks, dual backlit analog illuminated VU needle meters with needle physics, tape speed/bias, flutter, and warm tube drive.
  * **Mastering Precision Limiter:** Dark slate chassis, high-contrast LED gain reduction bar ladder (0 to -24 dB), true-peak ISP limiter, threshold, and lookahead.
  * **303 Acid Bassline Synth:** Roland TB-303 silver faceplate, 18Hz to 10kHz low-pass cutoff, self-oscillating resonance, envelope mod, accent, and an interactive 16-key silver keyboard.
  * **Stereo Field Imager:** Real-time Lissajous vector oscilloscope / goniometer phase correlation display, 0% mono to 200% super-wide stereo field expander, and bass mono crossover.
* **Zero-Allocation Audio Thread Slots:** 10 insert slots per mixer channel processed lock-free in real time.

---

### 🎚️ WSOLA Time-Stretching & Hermite Cubic Pitch-Shifting Motor
* **Waveform Similarity Overlap-Add (WSOLA):** Artifact-free, phase-aligned time-stretching ($0.25\times$ to $4.0\times$) that preserves original pitch and formants without comb-filtering or phase cancellation.
* **Independent Pitch-Shifter:** Shift pitch up or down by $\pm 24$ semitones ($\pm 2$ full octaves) with zero duration alteration using 4-point Hermite cubic resampling combined with WSOLA phase matching.
* **Timeline Stretch Tool (`S`):** Grab the right edge of any audio clip on the Arranger to stretch its duration to match the project tempo in real time.
* **Clip Properties Inspector:** Double-click any audio clip to inspect and tweak time-stretch multipliers and semitone transposition with instant waveform recalculation.

---

### 🎙️ Live Vocal & Instrument Recording (Direct Monitoring)
* **Hardware Input Bus (`cpal`):** Direct capture from physical audio interfaces, USB microphones, and line-in devices.
* **Zero-Latency Direct FX Monitoring:** Live microphone audio is routed over a lock-free SPSC ring buffer straight into **Mixer Insert 1**, allowing the vocalist to hear their voice live with Reverb, Delay, and Parametric EQ without audible latency.
* **Timeline Clip Placement:** Captured audio is encoded into broadcast **16-bit / 48kHz Stereo WAV** (`samples/recorded_vocal_*.wav`) and automatically placed as a green audio waveform clip onto the Playlist Arranger at the exact recording tick.

---

### 🎛️ Physical Hardware MIDI Controller Integration
* **Plug-and-Play USB MIDI Engine (`midir`):** Automatically enumerates physical keyboards, synthesizers, and pad controllers.
* **Factory Controller Profiles:**
  * **Generic USB MIDI:** Note On/Off, dynamic velocity sensitivity, Pitch Bend, CC 7 (Volume), CC 10 (Pan).
  * **Akai Fire:** 4 endless rotary encoders mapped to volume, pan, low-pass filter cutoff, and resonance, plus pad matrix notes.
  * **Novation Launchkey:** InControl faders 1..8 mapped directly to Mixer Inserts 1..8 fader levels.
* **Sub-Millisecond Event Response:** Lock-free bypass routes hardware MIDI events straight to `RealTimeAudioEngine` without OS thread delay.
* **Live MIDI Activity LED:** Real-time toolbar indicator blinks amber on keypress and displays the active note (`MIDI IN: #60 C5`).

---

### 📜 Unlimited Multi-Track Playlist Arrangement
* **Infinite Arrangement Canvas:** Unlimited horizontal/vertical multi-track lanes (Tracks 1..32+) with individual track mute, solo, and custom color striping.
* **Pattern, Audio & Automation Clips:**
  * **Pattern Clips:** Note and step previews directly on the timeline.
  * **Audio Clips:** Waveform visualization with interactive edge resizing.
  * **Automation Clips:** Full Bezier curve automation with draggable tension control points for volume, pan, and filter sweeps.
* **Arrangement Tools:** Select (`S`), Pencil (`P`), Slice / Cut (`C`), Delete (`D`), and flexible snap-to-grid (Bar, Beat, 1/2 Step, 1/4 Step, None).

---

### 🎚️ 64-Insert Kahn DAG Mixer
* **Acyclic Routing Graph:** Enforces acyclic signal routing with Kahn's topological sort.
* **Channel Strip Features:** 3-band RBJ biquad parametric EQ, stereo separation slider (-100% mono to +100% side), polarity inversion, left/right swap, and pre/post fader sends.
* **High-Cadence Peak Meters:** Stereo peak level tracking with logarithmic decay and clip indicators.

---

### ⚡ Zero-Allocation Audio Engine (Rust Core)
* Hard real-time audio thread executing exclusively with stack-allocated buffers and lock-free SPSC ring buffers (`rtrb`).
* Dedicated 4ms non-RT lookahead scheduling thread resolves patterns, slides, and swing without blocking the audio driver.
* Hardware buffer size options: `256`, `512`, `1024`, and `2048` frames (`cpal::BufferSize::Fixed`) for crackle-free stability on PipeWire, ALSA, CoreAudio, and WASAPI.

---

## 🎹 Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| **`Space`** | Play / Pause Transport |
| **`F5`** | Toggle Playlist Arrangement Window |
| **`F6`** | Toggle Channel Rack & Step Sequencer |
| **`F7`** | Toggle Piano Roll Editor |
| **`Alt + F8`** | Toggle Sample & Preset Browser |
| **`F9`** | Toggle 64-Insert Mixer |
| **`F10`** | Open Audio, Vocal & Hardware MIDI Settings Modal |
| **`F11`** | Toggle Borderless Fullscreen Workstation |
| **`Ctrl + E`** | Export Pattern / Song Mixdown as WAV |
| **`Ctrl + S`** | Save Project State (`.qlproj.json`) |
| **`Ctrl + Z` / `Ctrl + Y`** | Undo / Redo |

---

## 🚀 Building & Running Locally

### Prerequisites
- Node.js >= 20
- Rust stable (`rustup default stable`)
- **Linux:** `sudo apt install libwebkit2gtk-4.1-dev libasound2-dev libpipewire-0.3-dev librsvg2-dev`

### Development
```bash
# Clone the repository
git clone https://github.com/SovereignForm/Ql-Studio.git
cd Ql-Studio

# Install frontend dependencies
npm install

# Run Desktop DAW in developer mode
npm run tauri:dev
```

### Unit Tests
```bash
# Run Rust unit tests (DSP, VST3/CLAP hosting, MIDI, audio recording, WAV sampler)
cd src-tauri
cargo test
```

### Production Build
```bash
# Build frontend and optimized release binary
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml
```

---

## 📦 Multi-Platform Downloads

Pre-built binaries are generated automatically on release:

- 🐧 **Linux:** `.deb` (Debian, Ubuntu, Mint, Pop!_OS)
- 🪟 **Windows:** `.exe` (NSIS Installer) & `.msi`
- 🍏 **macOS:** `.dmg` (Universal binary: Apple Silicon M1/M2/M3/M4 & Intel x86_64)

👉 Visit the [Releases Page](https://github.com/SovereignForm/Ql-Studio/releases) to download the latest desktop packages.

---

## 📈 Star History

<p align="center">
  <a href="https://star-history.com/#SovereignForm/Ql-Studio&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=SovereignForm/Ql-Studio&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=SovereignForm/Ql-Studio&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=SovereignForm/Ql-Studio&type=Date" />
    </picture>
  </a>
</p>

---

## 📄 License

This project is licensed under the **GNU General Public License, Version 3 (GPL-3.0-or-later)** with an explicit **Audio Plugin Exception** ([LICENSE](LICENSE)).

### Audio Plugin Exception Clause
As a special exception to the GNU GPLv3, the copyright holders of Ql Studio grant explicit permission to link, combine, and host third-party audio plugins, SDK interfaces, and software libraries (including, but not limited to, **VST, VST3, CLAP, LV2, and AudioUnit** formats) regardless of the license terms of those plugins, ensuring full freedom to use both open-source and commercial proprietary instruments and effects within Ql Studio, while guaranteeing that Ql Studio's own core engine remains 100% free and open-source forever.
