# Transmute

A native Windows app for converting video, audio, and image files using ffmpeg — fully local, no internet, no API keys.

## Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org) (v18+)
- ffmpeg (optional - ffmpeg-static is bundled):
  - Install via [ffmpeg-builds](https://www.gyan.dev/ffmpeg/builds/) or chocolatey: `choco install ffmpeg`

### 2. Install & Run
```powershell
cd "C:\Users\Toby\Downloads\file converter"
npm install
npm start
```

### 3. Build Windows Installer & Portable
```powershell
npm run dist
```
This creates:
- A `.exe` installer in the `dist/` folder (installs to C:\Program Files\Transmute by default)
- A portable `.exe` in the `dist/` folder (no installation required)

To build only the portable version:
```powershell
npm run dist:portable
```

## Supported Formats

| Category | Input → Output |
|----------|----------------|
| Video | MP4, MOV, AVI, MKV, WebM, GIF, 3GP, TS, M2TS |
| Audio | MP3, AAC, WAV, FLAC, OGG, M4A, WMA, OPUS, AIFF |
| Images | PNG, JPG, WebP, BMP, TIFF, HEIC, AVIF, ICO, SVG |
| Documents | PDF → TXT, DOCX → TXT, TXT/MD/RTF/HTML/CSV/JSON/XML ↔ TXT/MD/RTF/HTML/CSV/JSON/XML |

## How it works

- Drag files onto the app (or click Browse)
- Pick a target format from the dropdown
- Hit **Convert all** — progress updates in real time
- Converted files save to the same folder as the original with `_converted` appended
- Click the download button to reveal in File Explorer

## Notes

- ffmpeg-static is bundled, so no external ffmpeg installation required
- All conversion happens locally — nothing leaves your machine
- Conversion quality presets: video uses H.264 CRF 23, audio uses high-quality VBR
- Windows installer allows you to choose installation directory 
