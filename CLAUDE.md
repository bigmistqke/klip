# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Eddy is a mobile-first video editor with musical DAW capabilities, built on AT Protocol for decentralized creative collaboration. The core concept treats every project as a **remixable stem collection** that others can fork and build upon.

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
│   ├── stem                  # Reference to app.eddy.stem record
│   ├── clips[]               # Timeline regions with audio/video pipelines
│   ├── audioPipeline[]       # Track-level audio effects
│   └── videoPipeline[]       # Track-level video effects
├── masterAudioPipeline[]     # Master audio bus
└── masterVideoPipeline[]     # Master video output
```

### AT Protocol Lexicons

Located in `lexicons/`:

- `app.eddy.project` - Project with groups, tracks, effect pipelines, and remix attribution
- `app.eddy.stem` - Reusable media files (audio/video) stored as blobs on user's PDS

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

## CSS Guidelines

- **Use CSS Grid for all layouts** - Prefer `display: grid` over flexbox for layout purposes

## SolidJS Conventions

- **Signal access** - When reading signal values, always assign to a local const with underscore prefix:
  ```ts
  // Good
  const _player = player()
  if (!_player) return
  _player.play()

  // Bad - calling signal multiple times
  if (!player()) return
  player().play()
  ```

- **No single-character variables** - Always use descriptive names:
  ```ts
  // Good
  for (const playback of playbacks) { ... }
  const _player = player()
  const link = document.createElement('a')

  // Bad
  for (const p of playbacks) { ... }
  const p = player()
  const a = document.createElement('a')
  ```

- **solid-whenever** - Use `@bigmistqke/solid-whenever` for reactive guards:
  ```ts
  import { whenEffect, whenMemo } from '@bigmistqke/solid-whenever'

  // Good - effect only runs when player is truthy
  whenEffect(player, player => {
    player.play()
  })

  // Good - memo with fallback when player is null
  const hasClip = whenMemo(
    player,
    player => player.hasClip(0),
    () => false
  )

  // Bad - manual null check in effect
  createEffect(() => {
    const player = player()
    if (!player) return
    player.play()
  })
  ```

## Workflow

- **Tickets** - A ticket is a single task. After completing a ticket, ask the user to confirm before proceeding
- **Before committing** - Write a list of things for the user to test and wait for confirmation before creating the commit
- **Ask before committing** - Always ask the user for permission before running `git commit`
- **Commit messages** - No Claude signature in commit messages
