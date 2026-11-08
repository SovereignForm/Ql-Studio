<p align="center">
  <img src="public/logo.svg" width="160" height="160" alt="Ql Studio Logo" />
</p>

<h1 align="center">Ql Studio</h1>

<p align="center">
  <b>High-Performance Digital Audio Workstation (DAW) & Desktop Music Production Suite</b><br>
  Built with React 19, Tailwind CSS v4, HTML5 Canvas, and Tauri v2 (Rust Core).
</p>

<p align="center">
  <a href="https://github.com/SovereignForm/Ql-Studio/stargazers"><img src="https://img.shields.io/github/stars/SovereignForm/Ql-Studio?style=for-the-badge&logo=star&color=ff8500" alt="GitHub Stars" /></a>
  <a href="https://github.com/SovereignForm/Ql-Studio/releases"><img src="https://img.shields.io/github/v/release/SovereignForm/Ql-Studio?style=for-the-badge&color=00e676" alt="Latest Release" /></a>
  <a href="#-license"><img src="https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-38bdf8?style=for-the-badge" alt="License MIT or Apache-2.0" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Audio%20Core-Rust%20(cpal%20%2B%20rtrb)-orange?style=flat-square" alt="Rust Audio" />
  <img src="https://img.shields.io/badge/WAV%20Sampler-hound%20%2B%20Hermite%204--pt-green?style=flat-square" alt="Hound WAV" />
  <img src="https://img.shields.io/badge/GUI-Tauri%20v2%20%2B%20React%2019-blue?style=flat-square" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/Platforms-Linux%20%7C%20Windows%20%7C%20macOS-purple?style=flat-square" alt="Platforms" />
</p>

---

## ⚡ Features at a Glance

- **⚡ Zero-Allocation Audio Engine (Rust):** Real-time DSP callback running on a dedicated thread with wait-free SPSC lock-free ring buffers (`rtrb`) and explicit fixed hardware buffer sizes (`256 / 512 / 1024 / 2048` frames). No audio crackle under PipeWire, ALSA, CoreAudio, or WASAPI.
- **🥁 Native PCM WAV Sampler (`hound`):** 4-point Hermite cubic interpolation resampling with bundled starter studio drum kit (`808 Kick`, `Studio Clap`, `Closed Hi-Hat`, `808 Snare`). Drag-and-drop `.wav` files directly into channel rows.
- **🎛️ 64-Insert Kahn DAG Mixer:** Verified acyclic routing graph with RBJ biquad parametric filters, stereo separation, polarity invert, and non-linear soft limiter ($\tanh$).
- **🎹 Pattern-Based Studio Workflow:**
  - Multi-window workspace (Channel Rack, Piano Roll `F7`, Playlist Arrangement `F5`, Browser `Alt+F8`, 64-Insert Mixer `F9`).
  - True borderless fullscreen workstation mode (`F11`).
  - Graph editor drawer (Velocity, Pan, Pitch micro-adjustments).
  - Undo/Redo history stack (`Ctrl+Z`, `Ctrl+Y`).
  - Native `.flp` binary project format import support.
  - Export pattern mixdown directly as 16-bit PCM WAV (`Ctrl+E`).

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
| **`F10`** | Open Audio Settings (Buffer Size / Device selector) |
| **`F11`** | Toggle Borderless Fullscreen Workstation |
| **`Ctrl + E`** | Export Pattern Mixdown as WAV |
| **`Ctrl + S`** | Save Project State (`.qlproj.json`) |
| **`Ctrl + Z` / `Ctrl + Y`** | Undo / Redo |

---

## 🚀 Building & Running Locally

### Prerequisites
- Node.js >= 20
- Rust stable (`rustup default stable`)
- Linux only: `sudo apt install libwebkit2gtk-4.1-dev libasound2-dev libpipewire-0.3-dev librsvg2-dev`

### Development
```bash
# Clone the repository
git clone https://github.com/SovereignForm/Ql-Studio.git
cd Ql-Studio

# Install dependencies
npm install

# Run the Desktop DAW
npm run tauri:dev
```

### Unit Tests
```bash
# Run real-time DSP, DAG mixer, and WAV sampler tests
npm run test:rust
```

---

## 📦 Multi-Platform Downloads

Pre-built binaries are generated automatically via GitHub Actions:

- 🐧 **Linux:** `.deb` (Debian, Ubuntu, Mint)
- 🪟 **Windows:** `.exe` (NSIS Installer) & `.msi`
- 🍏 **macOS:** `.dmg` (Universal: Apple Silicon M1/M2/M3/M4 & Intel x86_64)

👉 Visit the [Releases Page](https://github.com/SovereignForm/Ql-Studio/releases) to download the latest build.

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

This project is dual-licensed under either:

- **MIT License** ([LICENSE-MIT](LICENSE-MIT))
- **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE))

at your option. This dual-licensing model provides maximum freedom for open-source users alongside strong corporate and patent protection.
