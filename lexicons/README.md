# Klip Lexicons

AT Protocol lexicon definitions for Klip.

## Records

### `app.klip.project`

The main project record containing groups, tracks, curves, and effect pipelines.

- **Key**: `tid` (timestamp-based ID)
- **Stored on**: User's PDS

### `app.klip.stem`

A media stem (audio or video file) that can be used across multiple projects.

- **Key**: `tid`
- **Stored on**: User's PDS
- **Contains**: Blob reference to actual media file

## Architecture

```
project
├── canvas                    # Output dimensions
├── curves[]                  # Reusable animation curves (unique IDs)
├── groups[]                  # Layout containers
│   ├── layout                # How members are positioned (grid, absolute, custom)
│   ├── members[]             # Track/group references + position hints
│   └── pipeline[]            # Visual effects only
├── tracks[]                  # Media tracks
│   ├── clips[]               # Timeline regions
│   │   ├── audioPipeline[]   # Clip-level audio effects
│   │   └── videoPipeline[]   # Clip-level video effects
│   ├── audioPipeline[]       # Track-level audio effects
│   └── videoPipeline[]       # Track-level video effects
├── masterAudioPipeline[]     # Master audio bus
└── masterVideoPipeline[]     # Master video output
```

## Curves (Animation System)

Curves are first-class objects that define how values change over time. Each curve has a unique `id` within the project.

### Curve Types

| Type | Description |
|------|-------------|
| `keyframe` | Explicit points with bezier handles for full control |
| `envelope` | ADSR generator with bezier curves per phase |
| `lfo` | Low-frequency oscillator (sine, triangle, square, sawtooth) |

### Keyframe Curves

```json
{
  "curves": [
    {
      "type": "keyframe",
      "id": "fade-in",
      "points": [
        { "t": 0, "v": 0, "out": [0.4, 0] },
        { "t": 500, "v": 1, "in": [0.2, 1] }
      ]
    }
  ]
}
```

Each point has:
- `t`: time in milliseconds
- `v`: value (0-1 normalized)
- `in`/`out`: bezier handles [x, y] relative to point

### Envelope Curves

```json
{
  "type": "envelope",
  "id": "punch",
  "attack": { "duration": 50, "curve": [0.2, 0, 1, 1] },
  "decay": { "duration": 100, "curve": [0.4, 0, 1, 1] },
  "sustain": 0.7,
  "release": { "duration": 200, "curve": [0.4, 0, 1, 1] },
  "peak": 1
}
```

Each phase has its own bezier curve describing the transition shape.

### LFO Curves

LFOs can use either a fixed frequency (Hz) or sync to the project BPM:

```json
// Fixed frequency
{
  "type": "lfo",
  "id": "wobble",
  "waveform": "sine",
  "frequency": 2,
  "amplitude": 1,
  "center": 0.5,
  "phase": 0
}

// BPM-synced
{
  "type": "lfo",
  "id": "pulse",
  "waveform": "square",
  "sync": "1/4",
  "amplitude": 1,
  "center": 0.5
}
```

Sync options: `"4/1"`, `"2/1"`, `"1/1"`, `"1/2"`, `"1/4"`, `"1/8"`, `"1/16"`, `"1/32"`

## Value Types

All values are normalized 0-1. Three typed value systems for different parameter types:

### `#value` (Numeric)

For continuous parameters like gain, opacity, position:

```json
// Static
{ "type": "audio.gain", "value": { "value": 0.8, "min": 0, "max": 1 } }

// Animated
{ "type": "audio.gain", "value": { "curve": "fade-in", "min": 0, "max": 1 } }
```

**Static properties:**
- `value`: the numeric value
- `min`/`max`: constraints (default 0-1)
- `default`: fallback value

**Curve reference properties:**
- `curve`: ID of curve to use (must match an id in project.curves)
- `min`/`max`: output scaling (curve 0->min, curve 1->max)
- `offset`: time offset in ms
- `timeScale`: speed multiplier
- `timeRef`: `"clip"` (default) or `"project"` for time reference

### `#booleanValue`

For toggles like enabled, muted, solo, reverse:

```json
// Static
{ "type": "audio.gain", "enabled": { "value": true } }

// Animated (toggles at threshold)
{ "type": "audio.gain", "enabled": { "curve": "toggle", "threshold": 0.5 } }
```

### `#integerValue`

For discrete values like zIndex:

```json
// Static
{ "zIndex": { "value": 2 } }

// Animated (rounded)
{ "zIndex": { "curve": "layer-switch", "min": 0, "max": 5, "round": "floor" } }
```

### Time Reference

- **Clip effects**: curves are relative to clip start (move with clip)
- **Track/master effects**: use `timeRef: "project"` for absolute timing

## Effects

### Audio Effects

| Effect | Description |
|--------|-------------|
| `audio.gain` | Volume (0-1, where 1 = unity) |
| `audio.pan` | Stereo position (0 = left, 0.5 = center, 1 = right) |
| `audio.custom` | Third-party audio effects |

### Visual Effects

| Effect | Description |
|--------|-------------|
| `visual.transform` | Position, scale, rotation (all 0-1 normalized) |
| `visual.opacity` | Transparency (0-1) with blend modes |
| `visual.custom` | Third-party visual effects |

## Layout

Layout is a dedicated slot on groups (not part of the effect pipeline):

| Layout | Description |
|--------|-------------|
| `grid` | CSS Grid-like arrangement with rows/columns |
| `absolute` | Manual x/y/w/h positioning via member hints |
| `custom` | Third-party layouts |

```json
{
  "groups": [{
    "id": "main",
    "layout": { "type": "grid", "columns": 2, "rows": 2 },
    "members": [{ "id": "t1" }, { "id": "t2" }],
    "pipeline": []
  }]
}
```

## Processing Order

```
Clip Processing:
  clip audio -> clip.audioPipeline -> track.audioPipeline -> master
  clip video -> clip.videoPipeline -> track.videoPipeline -> group.pipeline -> master

Group Processing:
  layout positions members -> group.pipeline (visual effects)

Master Processing:
  all groups composited -> masterVideoPipeline -> output
  all audio mixed -> masterAudioPipeline -> output
```

## Examples

### MVP: Simple 4-Track Project

```json
{
  "title": "late night jam",
  "canvas": { "width": 1280, "height": 720 },
  "curves": [],
  "groups": [
    {
      "id": "main",
      "layout": { "type": "grid", "columns": 2, "rows": 2 },
      "members": [
        { "id": "t1" },
        { "id": "t2" },
        { "id": "t3" },
        { "id": "t4" }
      ],
      "pipeline": []
    }
  ],
  "tracks": [
    {
      "id": "t1",
      "stem": { "uri": "at://did:plc:.../app.klip.stem/...", "cid": "..." },
      "clips": [{ "id": "c1", "offset": 0, "duration": 60000 }],
      "audioPipeline": [
        { "type": "audio.gain", "value": { "value": 1.0 } },
        { "type": "audio.pan", "value": { "value": 0.5 } }
      ],
      "videoPipeline": []
    }
  ],
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### Fade Transition on Clip

```json
{
  "curves": [
    {
      "type": "keyframe",
      "id": "fade-in",
      "points": [
        { "t": 0, "v": 0, "out": [0.4, 0] },
        { "t": 500, "v": 1, "in": [0.2, 1] }
      ]
    }
  ],
  "tracks": [{
    "id": "t1",
    "clips": [{
      "id": "c1",
      "offset": 0,
      "duration": 5000,
      "videoPipeline": [
        {
          "type": "visual.opacity",
          "value": { "curve": "fade-in" }
        }
      ]
    }]
  }]
}
```

### Picture-in-Picture

```json
{
  "groups": [
    {
      "id": "main",
      "layout": { "type": "absolute" },
      "members": [
        {
          "id": "background",
          "x": { "value": 0 },
          "y": { "value": 0 },
          "width": { "value": 1 },
          "height": { "value": 1 }
        },
        {
          "id": "pip",
          "x": { "value": 0.7 },
          "y": { "value": 0.7 },
          "width": { "value": 0.25 },
          "height": { "value": 0.25 },
          "zIndex": { "value": 1 }
        }
      ],
      "pipeline": []
    }
  ]
}
```

### BPM-Synced LFO

```json
{
  "bpm": 120,
  "curves": [
    {
      "type": "lfo",
      "id": "quarter-pulse",
      "waveform": "sine",
      "sync": "1/4",
      "amplitude": 0.3,
      "center": 0.7
    }
  ],
  "tracks": [{
    "audioPipeline": [
      { "type": "audio.gain", "value": { "curve": "quarter-pulse", "min": 0.4, "max": 1.0 } }
    ]
  }]
}
```

## Validation

### Schema Validation

```typescript
import { Lexicons } from '@atproto/lexicon'
import projectLexicon from './app.klip.project.json'
import stemLexicon from './app.klip.stem.json'

const lexicons = new Lexicons()
lexicons.add(projectLexicon)
lexicons.add(stemLexicon)

lexicons.assertValidRecord('app.klip.project', projectData)
```

### Runtime Validation

Beyond schema validation, implementations must verify:

1. **Curve IDs are unique** - No duplicate `id` values in `project.curves`
2. **Curve references exist** - Every `curve` field in value refs must match an existing curve id
3. **Member references exist** - Every `groupMember.id` must match an existing track or group id
4. **LFO has frequency or sync** - Each LFO must have either `frequency` (Hz) or `sync` (beat division)

## Schema Versioning

Both records include a `schemaVersion` field (default: 1) for future migration support.

## Future Considerations

### Stem Chunking

For stems exceeding the 50MB PDS blob limit, a chunking mechanism could allow:
- Multiple blob references per stem
- Client-side reassembly during playback
- Streaming decode for large files

### Transitions

Clip transitions (crossfades, wipes) are not yet specified. Potential approaches:
- Clip-level `fadeIn`/`fadeOut` with duration + curve
- Separate transition objects between clips
- Overlap-based blending

### Waveform Caching

Waveform visualization data is computed client-side rather than stored in the schema. Implementations may cache computed waveforms locally (e.g., IndexedDB) for performance.
