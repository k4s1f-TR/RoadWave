# 🎵 SoundWave

<p align="center">
  <img src=".github/assets/preview.png" alt="SoundWave Interface" width="100%">
</p>

**Your media, anywhere.** A fast, local-first audio converter and YouTube downloader.

![Node.js](https://img.shields.io/badge/Node.js-≥22-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-Apache%202.0-blue)

---

## What is SoundWave?

SoundWave is a local-first web application that runs entirely on your machine. It features a local file **Converter** and a **YouTube Downloader**.

**No cloud uploads. No daily quotas. No accounts.**

### 🎧 Converter (Local Audio)
- Converts **MP3, M4A, AAC, WAV, FLAC, OGG, Opus, WMA, AIFF, ALAC, M4B, MP4, WebM, MOV, MKV, and MKA**
- Outputs **MP3, M4A (AAC), FLAC, WAV, Opus, or OGG Vorbis**
- Preserves ID3 tags and album art for MP3 output
- Format-specific quality controls: codec-appropriate bitrate, Vorbis quality, FLAC compression, or WAV bit depth
- Parallel processing (1, 2, or 4 simultaneous jobs)
- Drag & drop or file picker interface

### 🌐 YouTube Downloader
- Download videos, Shorts, and playlists in MP3 (audio) or MP4 (H.264/AAC with `faststart`)
- Queue management with live progress, speed, and ETA display
- Auto-resume interrupted downloads (`.part` continuation)

### 🔒 Privacy & Security
- Runs on `127.0.0.1` only — no network exposure
- CSRF protection with per-session tokens
- CSP, X-Content-Type-Options, Referrer-Policy headers
- Source files never leave your machine (local conversion)
- No cookies, no browser credentials, no DRM

## Installation

### Prerequisites
- **Windows 10/11**
- **Node.js 22** or later ([download](https://nodejs.org/))

### Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/4ilteris7/SoundWave.git
   cd soundwave
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Install the FFmpeg engine:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-engine.ps1
   ```

4. *(Optional)* Install the YouTube engine:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-youtube.ps1
   ```

5. Start the application:
   ```bash
   npm start
   ```

6. Open `http://127.0.0.1:47831` in your browser.

**Or simply double-click `Start.cmd`** — it handles engine installation and launches everything automatically.

## Usage

### Converting Local Files
1. Drag audio files onto the interface or click to browse.
2. Adjust quality and output folder as needed.
3. Choose an output format and click **Convert**. Files are saved automatically.
4. Preview, download individually, or open the output folder.

### Downloading from YouTube
1. Switch to the **Downloader** section in the sidebar.
2. Paste a video, Short, or playlist URL.
3. Click **Inspect Link** and select videos.
4. Choose format (MP3/MP4) and quality.
5. Click **Download Selected**.

## Project Structure

```
soundwave/
├── .github/
│   └── assets/preview.png       # Application preview screenshot
├── server.mjs                 # HTTP server & API routes
├── lib/
│   ├── audio.mjs               # Audio conversion logic & FFmpeg args
│   ├── process.mjs             # Child process runner with abort support
│   └── youtube.mjs             # YouTube inspection, download & queue manager
├── public/
│   ├── index.html              # Single-page application shell
│   ├── app.js                  # Converter UI logic
│   ├── youtube.js               # Downloader UI logic
│   ├── styles.css              # Main stylesheet
│   ├── youtube.css              # Downloader section styles
│   └── favicon.svg              # App icon
├── scripts/
│   ├── install-engine.ps1       # FFmpeg downloader with SHA256 verification
│   ├── install-youtube.ps1      # yt-dlp downloader with SHA256 verification
│   ├── select-folder.ps1        # Windows folder picker dialog
│   └── live-youtube-smoke.mjs   # Manual integration test
├── tests/
│   ├── converter.test.mjs       # Audio conversion tests
│   ├── interface.test.mjs       # UI/DOM tests (jsdom)
│   ├── process.test.mjs         # Process runner tests
│   └── youtube.test.mjs         # YouTube queue & URL tests
├── Start.cmd                   # One-click launcher
├── Update-YouTube-Engine.cmd   # YouTube engine updater
└── package.json
```

## Testing

```bash
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-engine.ps1
npm test
```

Tests use real FFmpeg to verify MP3, M4A/AAC, FLAC, 24-bit WAV, Opus and OGG output; metadata, cover dimensions, naming collisions, stop/retry, WebM→H.264/AAC MP4 conversion, range requests, and local API access. YouTube queue tests replace the network layer with controlled responses. Interface tests use jsdom.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FFMPEG_PATH` | Path to FFmpeg binary | `tools/ffmpeg/ffmpeg.exe` |
| `FFPROBE_PATH` | Path to FFprobe binary | `tools/ffmpeg/ffprobe.exe` |
| `YTDLP_PATH` | Path to yt-dlp binary | `tools/yt-dlp/yt-dlp.exe` |
| `PORT` | Server port | `47831` |
| `SOUNDWAVE_DATA` | Data directory | `data/` |
| `SOUNDWAVE_OUTPUT` | Default output directory | `outputs/` |
| `SOUNDWAVE_MAX_UPLOAD_BYTES` | Maximum size of one local upload | `4294967296` (4 GiB) |
| `SOUNDWAVE_REQUEST_TIMEOUT_MS` | Maximum HTTP request duration | `1800000` (30 min) |

## Engine Licenses

- **FFmpeg / FFprobe**: [FFmpeg project](https://ffmpeg.org/), [Gyan Windows builds](https://www.gyan.dev/ffmpeg/builds/) — GPLv3. Downloaded via `scripts/install-engine.ps1` with SHA256 verification. Not included in this repository.
- **yt-dlp**: [yt-dlp project](https://github.com/yt-dlp/yt-dlp) — Unlicense. Downloaded via `scripts/install-youtube.ps1` with SHA256 verification. Not included in this repository.

If you redistribute this application **with** the engine binaries, you must comply with their respective license terms.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
