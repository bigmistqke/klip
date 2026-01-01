# Klip

A mobile-first video editor with musical DAW capabilities, built on AT Protocol for decentralized creative collaboration.

## Vision

We are in the age of slop—algorithmically optimized, soulless content flooding every platform. Klip is a counterweight: a tool for spontaneous, genuine musical collaboration. By building on AT Protocol, we inherit a social graph and decentralized infrastructure that makes sharing, remixing, and attribution native to the platform rather than an afterthought.

## Core Concept

Klip treats every project as a **remixable stem collection**. When you create a video with audio, you're not just exporting a flattened file—you're publishing a recoverable multitrack session that others can fork, remix, and build upon. The AT Protocol social graph becomes a creative collaboration graph.

## Key Principles

1. **Stems are first-class citizens** - Every audio layer, video layer, and effect chain is stored as recoverable data
2. **Remix as social interaction** - Forking someone's project is a form of engagement, visible on the social graph
3. **Browser-native compositing** - All rendering happens client-side (leveraging your mp4box.js expertise)
4. **Mobile-first, desktop-capable** - Touch-optimized interface that scales up
5. **Everything is an effect** - Audio processing, video transforms, and layout are all modeled as composable effects

## Feature Set

### Video Editing
- Timeline-based multitrack video editing
- Clip trimming, splitting, layering
- Basic transitions and effects
- Text overlays and annotations
- Export to common formats (MP4, WebM)

### DAW Capabilities
- Multitrack audio timeline (synced with video)
- Audio recording (voice, instruments via input)
- Basic effects (EQ, compression, reverb, delay)
- MIDI input support (for external controllers)
- Stem import/export
- BPM/grid snapping
- Simple synthesis/sampling

### Collaboration via AT Protocol
- **Publish projects** as AT Protocol records (custom lexicon)
- **Fork/remix** - Clone someone's project with full stem access
- **Attribution chain** - Automatic credit linking back through remix history
- **Social discovery** - Find collaborators through the Bluesky social graph
- **Comments as timestamps** - Feedback tied to specific moments in the timeline

## AT Protocol Integration

### Custom Lexicons

Full schemas in `lexicons/` directory. Core records:

| Lexicon | Purpose |
|---------|---------|
| `app.klip.project` | Project with groups, tracks, effect pipelines, and remix attribution |
| `app.klip.stem` | Reusable media files (audio/video) with metadata and waveforms |

**Future lexicons (not yet defined):**
- `app.klip.comment` - Timestamped comments on projects
- `app.klip.like` - Engagement (or use Bluesky's native like?)
- `app.klip.collection` - Playlists/albums

### Data Architecture

The project structure follows an effect-based architecture where all processing is modeled uniformly:

```
project
├── canvas                    # Output dimensions
├── curves[]                  # Reusable animation curves (keyframe, envelope, lfo)
├── groups[]                  # Layout containers
│   ├── members[]             # Track/group references + position hints
│   └── pipeline[]            # Effects: layout, visual
├── tracks[]                  # Media tracks
│   ├── stem                  # Reference to app.klip.stem record
│   ├── clips[]               # Timeline regions
│   │   ├── audioPipeline[]   # Clip-level audio effects
│   │   └── videoPipeline[]   # Clip-level video effects
│   ├── audioPipeline[]       # Track-level audio effects
│   └── videoPipeline[]       # Track-level video effects
├── masterAudioPipeline[]     # Master audio bus
└── masterVideoPipeline[]     # Master video output
```

**Effect Categories (MVP):**
- `audio.*` - Gain, pan (+ custom for third-party)
- `visual.*` - Transform, opacity (+ custom for third-party)
- `group.layout.*` - Grid, absolute (+ custom for third-party)

**Value Types:**

All animatable parameters use typed value unions:
- `#value` - Numeric (gain, opacity, position, etc.)
- `#booleanValue` - Toggles (enabled, muted, solo, reverse)
- `#integerValue` - Discrete (zIndex)

Each can be static (`{ "value": 0.8 }`) or animated via curve reference (`{ "curve": "fade", "min": 0, "max": 1 }`).

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                        User's PDS                           │
│  (Personal Data Server - stores all project data)          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Stems     │  │  Projects   │  │   Remixes   │         │
│  │  (blobs)    │  │  (records)  │  │  (records)  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Relay / Firehose                        │
│         (Projects appear in feeds, discoverable)            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    AppView / Feed Generator                  │
│  - Trending projects                                         │
│  - Projects from people you follow                          │
│  - Genre/tag based discovery                                │
│  - Remix chains                                              │
└─────────────────────────────────────────────────────────────┘
```

## Technical Architecture

### Client-Side Stack

```
┌─────────────────────────────────────────────────────────────┐
│                      Klip Application                        │
├──────────────────┬──────────────────┬───────────────────────┤
│   UI Framework   │   Media Engine   │   AT Protocol Client  │
│   (SolidJS?)     │                  │   (@atproto/api)      │
├──────────────────┼──────────────────┼───────────────────────┤
│                  │  ┌────────────┐  │                       │
│  Touch-optimized │  │ mp4box.js  │  │  OAuth / DID auth     │
│  timeline UI     │  │ (your TS   │  │  Record CRUD          │
│                  │  │  rewrite)  │  │  Blob upload          │
│  Waveform viz    │  ├────────────┤  │  Subscription         │
│                  │  │ Web Audio  │  │                       │
│  MIDI controller │  │ API        │  │                       │
│  support         │  ├────────────┤  │                       │
│                  │  │ WebCodecs  │  │                       │
│                  │  │ API        │  │                       │
│                  │  └────────────┘  │                       │
└──────────────────┴──────────────────┴───────────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  IndexedDB    │
                    │  (offline     │
                    │   projects)   │
                    └───────────────┘
```

### Media Processing Pipeline

1. **Import** - Decode media via WebCodecs/mp4box.js
2. **Edit** - Manipulate timeline data (non-destructive)
3. **Preview** - Real-time playback via Web Audio API + canvas/WebGL
4. **Export** - Encode final output client-side
5. **Publish** - Upload stems as blobs, create project record

### Offline-First

- Projects stored locally in IndexedDB
- Sync to PDS when online
- Conflict resolution for collaborative edits

## User Experience

### Creating a Project

1. Open Klip, tap "New Project"
2. Import video from camera roll or record directly
3. Add audio tracks (record, import, or sample)
4. Arrange on timeline with touch gestures
5. Add effects, adjust levels
6. Publish to AT Protocol (or save locally)

### Remixing

1. Browse feed or search for projects
2. Find one you like, tap "Remix"
3. Project clones to your PDS with full stems
4. Edit freely—original creator gets attribution
5. Publish your remix (links back to original)

### Discovery

- Feed shows projects from people you follow
- Explore trending projects and remix chains
- Filter by genre, BPM, mood tags
- See a project's "family tree" of remixes

## Challenges & Considerations

### Storage & Bandwidth
- Stems can be large; need efficient compression (Opus for audio, H.264/VP9 for video)
- PDS blob limit: 50MB per blob (configurable, may increase to 100MB)
- Total account storage: currently unlimited, but quotas may come
- Bluesky video CDN: 25 videos/day, 10GB/day, up to 3 min each
- Consider tiered quality (preview vs. full stems) if limits tighten

### Licensing & Attribution
- Need clear license selection for published projects
- Attribution chain must be tamper-evident
- Consider Creative Commons integration

### Mobile Performance
- Audio/video processing is CPU-intensive
- WebCodecs helps but not universally supported
- May need to offload some processing (optional cloud render)

### Moderation
- Inherit AT Protocol's moderation infrastructure
- Need to handle DMCA/copyright issues
- Consider audio fingerprinting for samples

## Open Questions

1. **Stem format** - Opus for audio (128kbps, excellent quality/size), H.264/VP9 for video
2. **Blob hosting** - Start with PDS directly, piggyback Bluesky's video CDN where possible
3. **Monetization** - How do creators benefit? Tipping via AT Protocol?
4. **Sample library** - Built-in sounds? Community-contributed?
5. **MIDI data** - Not for MVP, consider for future versions

## Name

"Klip" - short, memorable, suggests both video clips and audio clipping. Works as a verb ("klip that") and noun ("make a klip").

## Next Steps

1. Define minimal viable lexicon schema ✓
2. Prototype timeline UI (touch-first)
3. Prove out stem storage/retrieval on AT Protocol
4. Build basic audio engine with Web Audio API
5. Integrate mp4box.js for video handling
6. User testing on actual mobile devices
