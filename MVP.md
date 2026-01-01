# Klip MVP

Minimal viable product: a 4-track recorder for the AT Protocol era.

## Philosophy

Think Tascam Portastudio, not Pro Tools. The constraint is the feature. Four tracks forces decisions, encourages simplicity, makes collaboration lightweight. You can always bounce and free up tracks—just like tape.

## What It Is

- 4 audio/video tracks
- Record, import, arrange
- Simple mixing (volume, pan)
- Publish to AT Protocol
- Fork and remix others

## What It Isn't

- No transitions
- No effects (EQ, reverb, etc.)
- No MIDI
- No automation
- No fancy timeline scrubbing
- No real-time collaboration

These come later. MVP ships without them.

## Core User Flows

### Flow 1: Create

```
┌─────────────────────────────────────────┐
│              New Project                │
│                                         │
│  Track 1: [Record] [Import] [________]  │
│  Track 2: [Record] [Import] [________]  │
│  Track 3: [Record] [Import] [________]  │
│  Track 4: [Record] [Import] [________]  │
│                                         │
│  ▶ Play    ⏹ Stop    [Publish]         │
└─────────────────────────────────────────┘
```

1. Tap "New Project"
2. For each track: record via mic/camera OR import from camera roll
3. Drag to adjust timing (simple waveform/thumbnail view)
4. Set levels with sliders
5. Tap "Publish" → goes to your PDS

### Flow 2: Remix

```
┌─────────────────────────────────────────┐
│  @someone's project                     │
│  "late night jam"                       │
│                                         │
│  ▶ [Play]     [Remix]     [♡ Like]     │
│                                         │
│  Remixed from: @original               │
│  Remixed by: @person1, @person2        │
└─────────────────────────────────────────┘
```

1. Browse feed / search
2. Play someone's project
3. Tap "Remix"
4. All 4 stems clone to your account
5. Replace/add/mute tracks
6. Publish (auto-links to original)

### Flow 3: Discover

- Feed of projects from people you follow
- Simple search by username
- View remix chains (who remixed who)

### Flow 4: Post to Bluesky

Critical for testing and buzz-building. Every Klip project can be rendered and posted as a native Bluesky video.

```
┌─────────────────────────────────────────┐
│           Share to Bluesky              │
│                                         │
│  Preview: [▶ 0:32 video thumbnail]     │
│                                         │
│  Caption:                               │
│  ┌─────────────────────────────────┐   │
│  │ late night jam                  │   │
│  │                                  │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ☑ Include "Made with Klip" link       │
│  ☑ Link to remixable project           │
│                                         │
│  [Cancel]              [Post to 🦋]    │
└─────────────────────────────────────────┘
```

**The flow:**

1. Tap "Share" on any project
2. Klip renders composite video (all tracks mixed down)
3. Preview before posting
4. Add caption (pre-filled with project title)
5. Post uploads video to Bluesky's CDN
6. Post text includes link back to Klip project

**Post format:**

```
late night jam

🔗 Remix this: https://klip.app/p/did:plc:xxx/rkey

Made with Klip
```

**Technical:**

- Render to MP4 (H.264 + AAC for max Bluesky compatibility)
- Max 3 minutes, 720p (fits Bluesky limits)
- Use `app.bsky.feed.post` with `app.bsky.embed.video`
- Include facet link to Klip project URL
- Klip project URL resolves to web player + "Open in Klip" button

## Technical Scope

### Data Model

Full lexicon definitions in `lexicons/` directory:

- `app.klip.project.json` - Project with groups, tracks, and effect pipelines
- `app.klip.stem.json` - Reusable media stems

**Schema vs MVP UI:**

The lexicons define a rich, future-proof data model. MVP uses a subset:

| Feature | Schema Capacity | MVP Implementation |
|---------|-----------------|-------------------|
| Tracks | Up to 32 | 4 slots |
| Clips per track | Up to 256 | 1 clip (start from t=0) |
| Layout | Grid, stack, absolute effects | Grid 2x2 preset |
| Audio effects | Full chain (EQ, reverb, etc.) | Gain + pan only |
| Video effects | Transform, blur, color, etc. | None |
| Groups | Nested hierarchy | Single root group |

**Type-Safe Values:**

All runtime parameters use typed value unions that can be static or animated:

| Type | Use Case | Static | Animated |
|------|----------|--------|----------|
| `#value` | Numeric (gain, opacity, position) | `{ "value": 0.8 }` | `{ "curve": "fade", "min": 0, "max": 1 }` |
| `#booleanValue` | Toggles (enabled, muted, solo) | `{ "value": true }` | `{ "curve": "toggle", "threshold": 0.5 }` |
| `#integerValue` | Discrete (zIndex) | `{ "value": 2 }` | `{ "curve": "layers", "min": 0, "max": 5 }` |

**Effect-Based Architecture:**

Everything is an effect. The schema stores layout algorithms, not just computed positions:

```json
{
  "groups": [{
    "id": "main",
    "members": [
      { "id": "t1" },
      { "id": "t2" },
      { "id": "t3" },
      { "id": "t4" }
    ],
    "pipeline": [
      { "type": "group.layout.grid", "columns": 2, "rows": 2 }
    ]
  }],
  "tracks": [{
    "id": "t1",
    "stem": { "uri": "at://...", "cid": "..." },
    "clips": [{ "id": "c1", "offset": 0, "duration": 60000 }],
    "audioPipeline": [
      { "type": "audio.gain", "value": { "value": 1.0 } },
      { "type": "audio.pan", "value": { "value": 0.5 } }
    ],
    "videoPipeline": []
  }]
}
```

**Why this matters:**

- Projects are portable—any client can interpret the layout intent
- Future clients can add new layout types without breaking old projects
- Remixers can change layout without re-uploading stems

**Stem reuse:**

- Stems are separate records, referenced by `strongRef`
- Same stem can appear in multiple projects
- Remixing = clone project record, keep stem references
- Only re-upload if you modify the actual media

### File Formats

**Audio stems:**

- Codec: Opus
- Container: WebM or OGG
- Bitrate: 128kbps (good quality, reasonable size)
- Sample rate: 48kHz

**Video stems:**

- Codec: H.264 (widest compatibility) or VP9 (better compression)
- Container: MP4 or WebM
- Resolution: 720p max for MVP
- Audio: Opus track embedded

**Size budget per project:**

- 4 stems × ~10MB each = ~40MB max
- Fits within 50MB PDS blob limit
- 60-90 seconds of content at good quality

### Rendering Pipeline

For Bluesky posting, we need to composite all tracks into a single video file.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            Render Pipeline                                 │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  MAIN THREAD                         │  WORKERS (via worker-proxy)         │
│  ───────────                         │  ──────────────────────────         │
│                                      │                                     │
│  ┌──────────┐ ┌──────────┐           │    ┌─────────────────────────┐      │
│  │ Track 1  │ │ Track 2  │  ...      │    │    Decode Worker        │      │
│  │ (video)  │ │ (video)  │           │    │  ┌───────────────────┐  │      │
│  └────┬─────┘ └────┬─────┘           │    │  │ WebCodecs         │  │      │
│       │            │                 │    │  │ VideoDecoder      │  │      │
│       │  $async()  │                 │    │  └─────────┬─────────┘  │      │
│       └────────────┼─────────────────┼───►│            │            │      │
│                    │                 │    │  $transfer(frames)      │      │
│       ◄────────────┼─────────────────┼────│            │            │      │
│       │            │                 │    └────────────┼────────────┘      │
│       ▼            ▼                 │                 │                   │
│  ┌─────────────────────────────┐     │                 │                   │
│  │      view.gl (WebGL)        │     │                 │                   │
│  │  ┌───────┐ ┌───────┐        │◄────┼─────────────────┘                   │
│  │  │ tex0  │ │ tex1  │ ...    │     │   VideoFrames as textures           │
│  │  └───┬───┘ └───┬───┘        │     │                                     │
│  │      │         │            │     │                                     │
│  │      ▼         ▼            │     │                                     │
│  │  ┌─────────────────────┐    │     │                                     │
│  │  │   Layout Shader     │    │     │                                     │
│  │  │   (grid/stack →     │    │     │                                     │
│  │  │    UV transforms)   │    │     │                                     │
│  │  └──────────┬──────────┘    │     │                                     │
│  │             ▼               │     │                                     │
│  │  ┌─────────────────────┐    │     │                                     │
│  │  │   Output Canvas     │    │     │                                     │
│  │  └──────────┬──────────┘    │     │                                     │
│  └─────────────┼───────────────┘     │                                     │
│                │                     │                                     │
│                │ captureStream()     │                                     │
│                ▼                     │                                     │
│  ┌────────────────────────────┐      │    ┌─────────────────────────┐      │
│  │      Web Audio API         │      │    │    Encode Worker        │      │
│  │  ┌─────┐ ┌─────┐ ┌─────┐   │      │    │  ┌───────────────────┐  │      │
│  │  │Gain │ │Gain │ │Gain │   │      │    │  │ WebCodecs         │  │      │
│  │  │+Pan │ │+Pan │ │+Pan │   │      │    │  │ VideoEncoder      │  │      │
│  │  └──┬──┘ └──┬──┘ └──┬──┘   │      │    │  │ AudioEncoder      │  │      │
│  │     └───────┼───────┘      │      │    │  └─────────┬─────────┘  │      │
│  │             ▼              │      │    │            │            │      │
│  │        ┌─────────┐         │      │    │  ┌─────────▼─────────┐  │      │
│  │        │ Master  │         │      │    │  │    mp4box.js      │  │      │
│  │        └────┬────┘         │      │    │  │    (muxer)        │  │      │
│  └─────────────┼──────────────┘      │    │  └─────────┬─────────┘  │      │
│                │                     │    └────────────┼────────────┘      │
│                │                     │                 │                   │
│   video frames + audio chunks ───────┼────────────────►│                   │
│   via $transfer()                    │                 │                   │
│                                      │                 ▼                   │
│                                      │    ┌─────────────────────────┐      │
│                                      │    │      Final MP4          │      │
│                                      │    │   (H.264 + AAC)         │      │
│                                      │    └─────────────────────────┘      │
│                                      │                                     │
└──────────────────────────────────────┴─────────────────────────────────────┘
```

**Main thread (real-time preview):**

1. **Decode** → Request frames via `worker-proxy.$async()`, get back VideoFrames
2. **Composite** → `view.gl` renders frames to textures, layout shader positions them based on group pipeline effects
3. **Mix** → Web Audio handles gain/pan per track → master bus

**Workers (via worker-proxy):**

- **Decode Worker**: WebCodecs VideoDecoder, `$transfer()` frames back to main
- **Encode Worker**: WebCodecs encoders + mp4box.js muxing, receives frames via `$transfer()`
- **Waveform Worker**: Generate peaks for visualization (not shown)

**Export flow:**

1. Main thread renders frame via view.gl
2. Read pixels or use `canvas.captureStream()`
3. `$transfer()` frame to Encode Worker
4. Worker encodes H.264 + AAC, muxes with mp4box.js
5. Final MP4 ready for Bluesky upload

**Why this architecture:**

- Main thread stays responsive (decode/encode in workers)
- `$transfer()` avoids copying large ArrayBuffers
- view.gl handles multi-texture compositing efficiently
- Type-safe RPC means no manual postMessage juggling

**For MVP:**

- 4 video slots rendered via `group.layout.grid` effect (2x2)
- Each track can be video (with audio) or audio-only (show waveform/color in slot)
- Recording happens in-app: record yourself while hearing/seeing other tracks
- MVP constraint: each recording starts from t=0 (one continuous take per slot)
- Future: stop/start recording = multiple clips per track

**Layout system:**

Layout is stored as effects in the group pipeline. MVP uses a single preset that generates the appropriate effect:

```
MVP: Simple layout presets (UI)
┌─────────────────────────────────────────┐
│  [Grid 2x2]  [Stack]  [Single]  [Free]  │
└─────────────────────────────────────────┘
        │
        ▼
Stored in schema as effect:
{ "type": "group.layout.grid", "columns": 2, "rows": 2 }

Future: Full positioning control
- Drag to reposition → updates member x/y as { "value": 0.5 }
- Pinch to resize → updates member width/height
- Layer order → updates member zIndex as { "value": 2 }
- Switch layouts → swaps layout effect type
- Animate position → { "curve": "slide", "min": 0, "max": 1 }
```

This keeps MVP simple (pick a preset) while the schema preserves the layout intent for portability and future features. See `lexicons/README.md` for full effect documentation.

### Client Tech Stack

```
┌──────────────────────────────────────────┐
│             Klip MVP                     │
├──────────────────────────────────────────┤
│  SolidJS                                 │
│  - Reactive, fast, small bundle          │
│  - Good mobile perf                      │
├──────────────────────────────────────────┤
│  @atproto/api                            │
│  - OAuth login                           │
│  - Blob upload                           │
│  - Record CRUD                           │
├──────────────────────────────────────────┤
│  @bigmistqke/view.gl                     │
│  - Type-safe WebGL resource management   │
│  - GLSL template literals → TS types     │
│  - Video compositing on GPU              │
│  - Shader-based effects (future)         │
├──────────────────────────────────────────┤
│  @bigmistqke/worker-proxy (rpc branch)   │
│  - Type-safe RPC for Web Workers         │
│  - $async for awaitable calls            │
│  - $transfer for ArrayBuffer ownership   │
│  - Offload encode/decode to workers      │
├──────────────────────────────────────────┤
│  Web Audio API                           │
│  - Playback                              │
│  - Recording (MediaRecorder)             │
│  - Simple mixing (gain nodes)            │
├──────────────────────────────────────────┤
│  mp4box.js (your TS version)             │
│  - Parse imported video                  │
│  - Extract audio for waveforms           │
│  - Mux final export                      │
├──────────────────────────────────────────┤
│  WebCodecs (with fallback)               │
│  - Encode/decode video frames            │
│  - Falls back to ffmpeg.wasm if needed   │
└──────────────────────────────────────────┘
```

**Why these choices:**

| Library | Role in Klip |
|---------|--------------|
| view.gl | Render video grid to canvas via WebGL, interpret layout effects, GPU-accelerated |
| worker-proxy | Heavy lifting (decode, encode, waveform gen) in workers without losing type safety |
| mp4box.js | Your TS rewrite - parse/mux MP4, extract tracks, no native dependencies |
| Web Audio | Real-time mixing, effects chain, recording |
| WebCodecs | Frame-level video encode/decode, faster than MediaRecorder for export |

### What We Skip for MVP

| Feature | Why Skip |
|---------|----------|
| Effects | Complexity, CPU usage, can add later |
| MIDI | Niche, requires synth engine |
| Automation | Overkill for 4-track |
| Offline sync | Just require internet for now |
| Comments | Nice-to-have, not core |
| Video transitions | Scope creep |
| Waveform editing | Just drag whole clips |

## UI Concept

Mobile-first. One hand operation where possible.

```
┌─────────────────────────────────┐
│    Klip            [@handle  ]  |
├─────────────────────────────────┤
│                                 │
│  ┌─────────────────────────┐    │
│  │    Track 1    [≡][-][M] │    │  <- Video track
│  │ ████████░░░░░░░░░░░░░░░ │    │     Thumbnail strip
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │    Track 2    [≡][-][M] │    │  <- Audio track
│  │ ▃▅▇▅▃▁▃▅▇█▇▅▃▁▃▅▇▅▃▁▃▅  │    │     Waveform
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │    Track 3    [≡][-][M] │    │
│  │ ▁▃▅▃▁▃▅▇▅▃▁▃▅▇█▇▅▃▁▃▅▃  │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ + Track 4               │    │  <- Empty slot
│  │   [Record] [Import]     │    │
│  └─────────────────────────┘    │
│                                 │
├─────────────────────────────────┤
│ ◀◀  ▶ PLAY   ▶▶    0:24/1:30    │
├─────────────────────────────────┤
│ [Save Draft]      [Publish →]   │
└─────────────────────────────────┘

[≡] = Volume slider (tap to expand)
[-] = Pan (tap to expand)
[M] = Mute toggle
```

## Remix Attribution

When you remix, the chain is visible:

```
your-remix
  └── remixed from: @someone/original-track
        └── remixed from: @creator/first-version
```

This is just following `parent` references in the project record. No special indexing needed for MVP.

## Authentication

Use AT Protocol OAuth flow:

1. User taps "Sign in with Bluesky"
2. Redirects to Bluesky OAuth
3. Returns with credentials
4. Store session, make authenticated requests

No custom auth, no passwords to manage.

## Hosting / Deployment

**MVP deployment:**

- Static site (Vercel, Netlify, Cloudflare Pages)
- No backend needed—everything goes to user's PDS
- Just HTML/JS/CSS

**Domain:**

- klip.audio? klip.fm? getklip.app?

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| PDS storage limits tighten | Compress aggressively, consider self-host PDS docs |
| Bluesky OAuth changes | Follow their developer channels closely |
| WebCodecs not supported | ffmpeg.wasm fallback (slower but works) |
| Mobile browser audio quirks | Test heavily on iOS Safari, Chrome Android |
| Copyright abuse | Clear remix attribution, respond to DMCA |

## Success Metrics

MVP is successful if:

- [ ] Can create a 4-track project in under 2 minutes
- [ ] Can remix someone else's project
- [ ] Remix chain is visible
- [ ] Works on iPhone Safari and Android Chrome
- [ ] Project loads in under 3 seconds on 4G

## Development Phases

### Phase 1: Proof of Concept

- [ ] AT Protocol OAuth login working
- [ ] Upload a single audio blob to PDS
- [ ] Retrieve and play it back
- [ ] Basic project record creation

### Phase 2: Core Editor

- [ ] 4-track timeline UI
- [ ] Record audio via MediaRecorder
- [ ] Import from file picker
- [ ] Waveform visualization
- [ ] Playback with Web Audio mixing

### Phase 3: Video Support

- [ ] Import video clips
- [ ] Thumbnail strip visualization
- [ ] Video playback synced with audio
- [ ] mp4box.js integration for parsing

### Phase 4: Publishing to PDS

- [ ] Encode stems to Opus/H.264
- [ ] Upload stems as separate blobs
- [ ] Create project record with lexicon
- [ ] Retrieve and display published projects

### Phase 5: Bluesky Posting (Critical for Testing)

- [ ] Render composite video (mix all tracks)
- [ ] Offline render with WebCodecs + mp4box.js
- [ ] Upload to Bluesky video CDN
- [ ] Create post with video embed + project link
- [ ] Audio-only fallback (waveform video)

### Phase 6: Social Features

- [ ] Feed of followed users' projects
- [ ] Project playback view
- [ ] Remix flow (clone stems, create child project)
- [ ] Attribution chain display

### Phase 7: Web Player

- [ ] Public URL for each project (klip.app/p/...)
- [ ] Embeddable player
- [ ] "Remix in Klip" CTA
- [ ] Open Graph tags for rich link previews

### Phase 8: Polish

- [ ] Mobile touch optimization
- [ ] Loading states and error handling
- [ ] PWA support (add to home screen)
- [ ] Deep links from Bluesky posts

## Decisions Made

1. **Separate blob per stem** - More flexible, enables stem reuse, future-proofs for collaboration
2. **Effect-based architecture** - Layout, audio, and video processing all modeled as composable effects in pipelines
3. **Schema stores intent** - Layout type (grid/stack/absolute) stored in schema, not computed client-side
4. **Bluesky posting built-in** - Critical for testing loop and organic growth

## Open Questions for MVP

1. **Video: required or optional?**
   - Could start audio-only, add video in v1.1
   - But "video editor" is in the pitch...
   - Compromise: support both, but optimize for audio-first workflow

2. **Feed: build custom or use Bluesky's?**
   - Could create custom feed generator for klip projects
   - Or just query follows' projects directly
   - Start with direct queries, add feed generator later

3. **Project visibility: public only?**
   - AT Protocol doesn't have great private data support
   - MVP: everything is public
   - "Drafts" are just local (IndexedDB) until published

4. **Web player for shared links?**
   - Need a web view for when people click Klip links from Bluesky
   - Simple player + "Remix in Klip" CTA
   - Could be same app or separate lightweight page
