import type { LexiconDoc } from "@atproto/lexicon";

export default {
  "lexicon": 1,
  "id": "app.klip.project",
  "defs": {
    "main": {
      "type": "record",
      "description": "A Klip project containing groups, tracks, curves, and effect pipelines",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["title", "canvas", "groups", "tracks", "createdAt"],
        "properties": {
          "schemaVersion": {
            "type": "integer",
            "description": "Schema version for migration support",
            "default": 1
          },
          "title": {
            "type": "string",
            "maxLength": 256
          },
          "description": {
            "type": "string",
            "maxLength": 2048
          },
          "bpm": {
            "type": "integer",
            "description": "Beats per minute for grid/sync features (scaled by 100, e.g., 12000 = 120 BPM)",
            "minimum": 2000,
            "maximum": 40000
          },
          "duration": {
            "type": "integer",
            "description": "Total project duration in milliseconds",
            "minimum": 0
          },
          "canvas": {
            "type": "ref",
            "ref": "#canvas"
          },
          "curves": {
            "type": "array",
            "items": { "type": "union", "refs": ["#curve.keyframe", "#curve.envelope", "#curve.lfo"] },
            "maxLength": 256,
            "description": "Reusable animation curves. Each curve has a unique id field; validators must reject duplicates. Runtime may convert to map for O(1) lookup."
          },
          "groups": {
            "type": "array",
            "items": { "type": "union", "refs": ["#group.grid", "#group.absolute"] },
            "maxLength": 64,
            "description": "Groups containing tracks with layout effects"
          },
          "tracks": {
            "type": "array",
            "items": { "type": "ref", "ref": "#track" },
            "maxLength": 32
          },
          "masterAudioPipeline": {
            "type": "array",
            "items": { "type": "union", "refs": ["#audioEffect.pan", "#audioEffect.gain", "#audioEffect.custom"] },
            "maxLength": 16,
            "description": "Master audio bus effects"
          },
          "masterVideoPipeline": {
            "type": "array",
            "items": { "type": "union", "refs": ["#visualEffect.transform", "#visualEffect.opacity", "#visualEffect.custom"] },
            "maxLength": 16,
            "description": "Master video output effects"
          },
          "parent": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Source project if this is a remix"
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          },
          "updatedAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },

    "canvas": {
      "type": "object",
      "description": "Output canvas dimensions",
      "required": ["width", "height"],
      "properties": {
        "width": {
          "type": "integer",
          "minimum": 1,
          "maximum": 4096
        },
        "height": {
          "type": "integer",
          "minimum": 1,
          "maximum": 4096
        },
        "background": {
          "type": "string",
          "description": "Background color (hex) or 'transparent'",
          "maxLength": 32
        }
      }
    },

    "curve.keyframe": {
      "type": "object",
      "description": "Explicit keyframe curve with bezier interpolation",
      "required": ["type", "id", "points"],
      "properties": {
        "type": { "type": "string", "const": "keyframe" },
        "id": {
          "type": "string",
          "description": "Unique identifier for this curve",
          "maxLength": 64
        },
        "points": {
          "type": "array",
          "items": { "type": "ref", "ref": "#keyframePoint" },
          "minLength": 1,
          "maxLength": 256
        }
      }
    },

    "keyframePoint": {
      "type": "object",
      "description": "A point in a keyframe curve",
      "required": ["t", "v"],
      "properties": {
        "t": {
          "type": "integer",
          "description": "Time in milliseconds"
        },
        "v": {
          "type": "integer",
          "description": "Value at this point"
        },
        "in": {
          "type": "array",
          "description": "Incoming bezier handle [x, y] relative to point",
          "items": { "type": "integer" },
          "minLength": 2,
          "maxLength": 2
        },
        "out": {
          "type": "array",
          "description": "Outgoing bezier handle [x, y] relative to point",
          "items": { "type": "integer" },
          "minLength": 2,
          "maxLength": 2
        }
      }
    },

    "curve.envelope": {
      "type": "object",
      "description": "ADSR envelope generator",
      "required": ["type", "id"],
      "properties": {
        "type": { "type": "string", "const": "envelope" },
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "attack": {
          "type": "ref",
          "ref": "#envelopePhase",
          "description": "Attack phase: 0 to peak"
        },
        "decay": {
          "type": "ref",
          "ref": "#envelopePhase",
          "description": "Decay phase: peak to sustain"
        },
        "sustain": {
          "type": "integer",
          "description": "Sustain level (0-1)",
          "minimum": 0,
          "maximum": 1,
          "default": 1
        },
        "release": {
          "type": "ref",
          "ref": "#envelopePhase",
          "description": "Release phase: sustain to 0"
        },
        "peak": {
          "type": "integer",
          "description": "Peak value at end of attack",
          "default": 1
        }
      }
    },

    "envelopePhase": {
      "type": "object",
      "description": "A phase of an envelope with duration and curve",
      "required": ["duration"],
      "properties": {
        "duration": {
          "type": "integer",
          "description": "Phase duration in milliseconds",
          "minimum": 0
        },
        "curve": {
          "type": "array",
          "description": "Bezier control points [x1, y1, x2, y2]",
          "items": { "type": "integer" },
          "minLength": 4,
          "maxLength": 4
        }
      }
    },

    "curve.lfo": {
      "type": "object",
      "description": "Low-frequency oscillator. Must have either frequency (Hz) or sync (beat division).",
      "required": ["type", "id"],
      "properties": {
        "type": { "type": "string", "const": "lfo" },
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "waveform": {
          "type": "string",
          "enum": ["sine", "triangle", "square", "sawtooth"],
          "default": "sine"
        },
        "frequency": {
          "type": "integer",
          "description": "Oscillation frequency in Hz. Ignored if sync is set.",
          "minimum": 0.01,
          "maximum": 100
        },
        "sync": {
          "type": "string",
          "description": "Beat division synced to project BPM. Overrides frequency when set.",
          "enum": ["4/1", "2/1", "1/1", "1/2", "1/4", "1/8", "1/16", "1/32"]
        },
        "amplitude": {
          "type": "integer",
          "description": "Oscillation amplitude (0-1)",
          "minimum": 0,
          "maximum": 1,
          "default": 1
        },
        "center": {
          "type": "integer",
          "description": "Center value to oscillate around (0-1)",
          "minimum": 0,
          "maximum": 1,
          "default": 0.5
        },
        "phase": {
          "type": "integer",
          "description": "Phase offset in degrees",
          "minimum": 0,
          "maximum": 360,
          "default": 0
        }
      }
    },

    "staticValue": {
      "type": "object",
      "description": "A static numeric value. Values are integers scaled by 100 (e.g., 50 = 0.5, 100 = 1.0). This avoids floats which AT Protocol doesn't support.",
      "required": ["value"],
      "properties": {
        "value": {
          "type": "integer",
          "description": "Value scaled by 100 (50 = 0.5)"
        },
        "min": {
          "type": "integer",
          "description": "Minimum allowed value (scaled by 100)",
          "default": 0
        },
        "max": {
          "type": "integer",
          "description": "Maximum allowed value (scaled by 100)",
          "default": 100
        },
        "default": {
          "type": "integer",
          "description": "Default value if not specified (scaled by 100)"
        }
      }
    },

    "curveRef": {
      "type": "object",
      "description": "Reference to a curve with output scaling. Values scaled by 100.",
      "required": ["curve"],
      "properties": {
        "curve": {
          "type": "string",
          "description": "ID of the curve to reference. Must match an id in project.curves array.",
          "maxLength": 64
        },
        "min": {
          "type": "integer",
          "description": "Minimum output value scaled by 100 (curve 0 maps to this)",
          "default": 0
        },
        "max": {
          "type": "integer",
          "description": "Maximum output value scaled by 100 (curve 1 maps to this)",
          "default": 100
        },
        "offset": {
          "type": "integer",
          "description": "Time offset in milliseconds",
          "default": 0
        },
        "timeScale": {
          "type": "integer",
          "description": "Time multiplier scaled by 100 (200 = 2x speed)",
          "default": 100
        },
        "timeRef": {
          "type": "string",
          "enum": ["clip", "project"],
          "description": "Time reference: clip-relative or project-relative",
          "default": "clip"
        }
      }
    },

    "group.absolute": {
      "type": "object",
      "description": "Group with absolute positioning. Members specify x/y/width/height.",
      "required": ["type", "id", "members"],
      "properties": {
        "type": { "type": "string", "const": "absolute" },
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "maxLength": 128
        },
        "members": {
          "type": "array",
          "items": { "type": "ref", "ref": "#member.absolute" },
          "maxLength": 32
        },
        "pipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#visualEffect.transform", "#visualEffect.opacity", "#visualEffect.custom"] },
          "maxLength": 16,
          "description": "Visual effects applied to the composited group"
        }
      }
    },

    "group.grid": {
      "type": "object",
      "description": "Group with CSS Grid-like layout. Members placed in cells.",
      "required": ["type", "id", "columns", "rows", "members"],
      "properties": {
        "type": { "type": "string", "const": "grid" },
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "maxLength": 128
        },
        "columns": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16
        },
        "rows": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16
        },
        "gap": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Gap between cells (0-1 relative to group size)"
        },
        "padding": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Padding around grid (0-1 relative to group size)"
        },
        "autoPlace": {
          "type": "boolean",
          "description": "Auto-place members without explicit column/row",
          "default": true
        },
        "members": {
          "type": "array",
          "items": { "type": "ref", "ref": "#member.grid" },
          "maxLength": 32
        },
        "pipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#visualEffect.transform", "#visualEffect.opacity", "#visualEffect.custom"] },
          "maxLength": 16,
          "description": "Visual effects applied to the composited group"
        }
      }
    },

    "group.custom": {
      "type": "object",
      "description": "Group with custom/third-party layout",
      "required": ["type", "id", "members"],
      "properties": {
        "type": {
          "type": "string",
          "description": "Custom layout identifier (e.g., 'vendor.layoutName')"
        },
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "maxLength": 128
        },
        "params": {
          "type": "unknown",
          "description": "Layout-specific parameters"
        },
        "members": {
          "type": "array",
          "items": { "type": "ref", "ref": "#member.custom" },
          "maxLength": 32
        },
        "pipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#visualEffect.transform", "#visualEffect.opacity", "#visualEffect.custom"] },
          "maxLength": 16,
          "description": "Visual effects applied to the composited group"
        }
      }
    },

    "member.absolute": {
      "type": "object",
      "description": "Member in an absolute group. Position and size in normalized coordinates.",
      "required": ["id"],
      "properties": {
        "id": {
          "type": "string",
          "description": "Track ID or group ID. Must be unique across project.tracks and project.groups.",
          "maxLength": 64
        },
        "x": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "X position (0-1 relative to group)"
        },
        "y": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Y position (0-1 relative to group)"
        },
        "width": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Width (0-1 relative to group)"
        },
        "height": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Height (0-1 relative to group)"
        },
        "zIndex": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Layer order within group"
        },
        "fit": {
          "type": "string",
          "enum": ["contain", "cover", "fill"],
          "default": "cover"
        }
      }
    },

    "member.grid": {
      "type": "object",
      "description": "Member in a grid group. Placed in cell with optional offset.",
      "required": ["id"],
      "properties": {
        "id": {
          "type": "string",
          "description": "Track ID or group ID. Must be unique across project.tracks and project.groups.",
          "maxLength": 64
        },
        "column": {
          "type": "integer",
          "description": "Grid column (1-based). Omit for auto-placement.",
          "minimum": 1
        },
        "row": {
          "type": "integer",
          "description": "Grid row (1-based). Omit for auto-placement.",
          "minimum": 1
        },
        "columnSpan": {
          "type": "integer",
          "minimum": 1,
          "default": 1
        },
        "rowSpan": {
          "type": "integer",
          "minimum": 1,
          "default": 1
        },
        "x": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "X offset within cell (0-1 relative to cell)"
        },
        "y": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Y offset within cell (0-1 relative to cell)"
        },
        "zIndex": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Layer order within group"
        },
        "fit": {
          "type": "string",
          "enum": ["contain", "cover", "fill"],
          "default": "cover"
        }
      }
    },

    "member.custom": {
      "type": "object",
      "description": "Member in a custom group. Hints depend on layout implementation.",
      "required": ["id"],
      "properties": {
        "id": {
          "type": "string",
          "description": "Track ID or group ID. Must be unique across project.tracks and project.groups.",
          "maxLength": 64
        },
        "hints": {
          "type": "unknown",
          "description": "Layout-specific member hints"
        },
        "zIndex": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Layer order within group"
        },
        "fit": {
          "type": "string",
          "enum": ["contain", "cover", "fill"],
          "default": "cover"
        }
      }
    },

    "track": {
      "type": "object",
      "description": "A track containing media clips and effect pipelines",
      "required": ["id", "clips"],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "maxLength": 128
        },
        "clips": {
          "type": "array",
          "items": { "type": "ref", "ref": "#clip" },
          "maxLength": 256
        },
        "audioPipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#audioEffect.pan", "#audioEffect.gain", "#audioEffect.custom"] },
          "maxLength": 16,
          "description": "Track-level audio effect chain"
        },
        "videoPipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#visualEffect.transform", "#visualEffect.opacity", "#visualEffect.custom"] },
          "maxLength": 16,
          "description": "Track-level video effect chain"
        },
        "muted": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Mute track"
        },
        "solo": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Solo track"
        }
      }
    },

    "clip": {
      "type": "object",
      "description": "A region on the timeline referencing part of a stem",
      "required": ["id", "offset", "duration"],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "stem": {
          "type": "ref",
          "ref": "com.atproto.repo.strongRef",
          "description": "Reference to app.klip.stem record"
        },
        "offset": {
          "type": "integer",
          "description": "Position on timeline in milliseconds",
          "minimum": 0
        },
        "sourceOffset": {
          "type": "integer",
          "description": "Start position within source stem (for trimming)",
          "minimum": 0,
          "default": 0
        },
        "duration": {
          "type": "integer",
          "description": "Duration in milliseconds",
          "minimum": 0
        },
        "speed": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Playback speed multiplier (0.1-10)"
        },
        "reverse": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Play clip in reverse"
        },
        "audioPipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#audioEffect.pan", "#audioEffect.gain", "#audioEffect.custom"] },
          "maxLength": 16,
          "description": "Clip-level audio effects (curves are clip-relative)"
        },
        "videoPipeline": {
          "type": "array",
          "items": { "type": "union", "refs": ["#visualEffect.transform", "#visualEffect.opacity", "#visualEffect.custom"] },
          "maxLength": 16,
          "description": "Clip-level video effects (curves are clip-relative)"
        }
      }
    },

    "audioEffect.gain": {
      "type": "object",
      "required": ["type", "value"],
      "properties": {
        "type": { "type": "string", "const": "audio.gain" },
        "enabled": { "type": "union", "refs": ["#staticValue", "#curveRef"] },
        "value": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Volume (0-1, where 1 = unity gain)"
        }
      }
    },

    "audioEffect.pan": {
      "type": "object",
      "required": ["type", "value"],
      "properties": {
        "type": { "type": "string", "const": "audio.pan" },
        "enabled": { "type": "union", "refs": ["#staticValue", "#curveRef"] },
        "value": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Stereo position (0 = left, 0.5 = center, 1 = right)"
        }
      }
    },

    "audioEffect.custom": {
      "type": "object",
      "description": "Custom or third-party audio effect",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "description": "Custom effect identifier (e.g., 'audio.vendor.effectName')"
        },
        "enabled": { "type": "union", "refs": ["#staticValue", "#curveRef"] },
        "params": {
          "type": "unknown",
          "description": "Effect-specific parameters"
        }
      }
    },

    "visualEffect.transform": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string", "const": "visual.transform" },
        "enabled": { "type": "union", "refs": ["#staticValue", "#curveRef"] },
        "x": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "X offset (0-1 relative to canvas)"
        },
        "y": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Y offset (0-1 relative to canvas)"
        },
        "scale": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Uniform scale (0-1, where 1 = 100%)"
        },
        "rotation": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Rotation (0-1, where 1 = 360 degrees)"
        },
        "anchorX": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Transform anchor X (0-1)"
        },
        "anchorY": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Transform anchor Y (0-1)"
        }
      }
    },

    "visualEffect.opacity": {
      "type": "object",
      "required": ["type", "value"],
      "properties": {
        "type": { "type": "string", "const": "visual.opacity" },
        "enabled": { "type": "union", "refs": ["#staticValue", "#curveRef"] },
        "value": {
          "type": "union",
          "refs": ["#staticValue", "#curveRef"],
          "description": "Opacity (0-1)"
        },
        "blendMode": {
          "type": "string",
          "enum": ["normal", "multiply", "screen", "overlay", "add"],
          "default": "normal"
        }
      }
    },

    "visualEffect.custom": {
      "type": "object",
      "description": "Custom or third-party visual effect",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "description": "Custom effect identifier (e.g., 'visual.vendor.effectName')"
        },
        "enabled": { "type": "union", "refs": ["#staticValue", "#curveRef"] },
        "params": {
          "type": "unknown",
          "description": "Effect-specific parameters"
        }
      }
    }
  }
} as const satisfies LexiconDoc
