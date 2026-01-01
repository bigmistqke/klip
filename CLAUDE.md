# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Klip is a mobile-first video editor with musical DAW capabilities, built on AT Protocol for decentralized creative collaboration. The core concept treats every project as a **remixable stem collection** that others can fork and build upon.

## Architecture

### Effect-Based Data Model

Everything is an effect. Audio processing, video transforms, and layout are all modeled as composable effects in pipelines:

```
project
├── curves[]                  # Reusable animation curves (keyframe, envelope, lfo)
├── groups[]                  # Layout containers (absolute, grid, or custom)
│   ├── members[]             # Track/group references with layout hints
│   └── pipeline[]            # Visual effects on composited group
├── tracks[]                  # Media tracks
│   ├── stem                  # Reference to app.klip.stem record
│   ├── clips[]               # Timeline regions with audio/video pipelines
│   ├── audioPipeline[]       # Track-level audio effects
│   └── videoPipeline[]       # Track-level video effects
├── masterAudioPipeline[]     # Master audio bus
└── masterVideoPipeline[]     # Master video output
```

### AT Protocol Lexicons

Located in `lexicons/`:
- `app.klip.project` - Project with groups, tracks, effect pipelines, and remix attribution
- `app.klip.stem` - Reusable media files (audio/video) stored as blobs on user's PDS

Stems are separate records referenced by `strongRef`. Same stem can appear in multiple projects. Remixing clones the project record but keeps stem references.

### Value System

All animatable parameters use typed value unions:
- `#value` - Numeric (gain, opacity, position). Static: `{ "value": 0.8 }`, animated: `{ "curve": "fade", "min": 0, "max": 1 }`
- `#booleanValue` - Toggles (enabled, muted, solo)
- `#integerValue` - Discrete (zIndex)

Curve references point to entries in `project.curves` by `id`. Runtime validators must check curve IDs are unique and all references resolve.

### Group Types

Groups are typed unions based on layout strategy:
- `group.absolute` - Free positioning with x/y/width/height
- `group.grid` - CSS Grid-like cells with column/row placement
- `group.custom` - Third-party layouts with custom hints

Each group type has a matching member type (`member.absolute`, `member.grid`, `member.custom`).

## Planned Tech Stack (MVP)

- **SolidJS** - UI framework
- **@atproto/api** - OAuth login, blob upload, record CRUD
- **@bigmistqke/view.gl** - WebGL video compositing, GPU-accelerated layout rendering
- **@bigmistqke/worker-proxy** - Type-safe RPC for decode/encode workers
- **Web Audio API** - Playback, recording, mixing
- **mp4box.js** - Parse/mux MP4, extract tracks
- **WebCodecs** - Frame-level video encode/decode (ffmpeg.wasm fallback)

## MVP Constraints

4-track recorder (think Tascam Portastudio, not Pro Tools):
- 4 tracks max, 1 clip per track starting at t=0
- Layout: grid preset only
- Audio effects: gain + pan only
- No video effects, transitions, MIDI, or automation
