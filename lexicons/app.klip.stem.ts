import type { LexiconDoc } from "@atproto/lexicon";

export default {
  "lexicon": 1,
  "id": "app.klip.stem",
  "defs": {
    "main": {
      "type": "record",
      "description": "A media stem (audio or video) that can be used in projects",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["blob", "type", "mimeType", "duration", "createdAt"],
        "properties": {
          "schemaVersion": {
            "type": "integer",
            "description": "Schema version for migration support",
            "default": 1
          },
          "blob": {
            "type": "blob",
            "description": "The media file",
            "accept": [
              "audio/webm",
              "audio/ogg",
              "audio/mp4",
              "audio/mpeg",
              "video/webm",
              "video/mp4",
              "video/quicktime"
            ],
            "maxSize": 52428800
          },
          "type": {
            "type": "string",
            "enum": ["audio", "video"],
            "description": "Media type"
          },
          "mimeType": {
            "type": "string",
            "description": "MIME type of the blob",
            "maxLength": 128
          },
          "duration": {
            "type": "integer",
            "description": "Duration in milliseconds",
            "minimum": 0
          },
          "audio": {
            "type": "ref",
            "ref": "#audioMeta",
            "description": "Audio-specific metadata"
          },
          "video": {
            "type": "ref",
            "ref": "#videoMeta",
            "description": "Video-specific metadata"
          },
          "thumbnail": {
            "type": "blob",
            "description": "Preview thumbnail for video stems",
            "accept": ["image/jpeg", "image/png", "image/webp"],
            "maxSize": 1000000
          },
          "sourceProject": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "If this stem was extracted from another project"
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },

    "audioMeta": {
      "type": "object",
      "description": "Audio-specific metadata",
      "properties": {
        "sampleRate": {
          "type": "integer",
          "description": "Sample rate in Hz",
          "minimum": 8000,
          "maximum": 192000
        },
        "channels": {
          "type": "integer",
          "description": "Number of audio channels",
          "minimum": 1,
          "maximum": 8
        },
        "bitrate": {
          "type": "integer",
          "description": "Bitrate in bits per second"
        },
        "codec": {
          "type": "string",
          "description": "Audio codec (e.g., 'opus', 'aac', 'mp3')",
          "maxLength": 32
        }
      }
    },

    "videoMeta": {
      "type": "object",
      "description": "Video-specific metadata",
      "properties": {
        "width": {
          "type": "integer",
          "description": "Video width in pixels",
          "minimum": 1,
          "maximum": 8192
        },
        "height": {
          "type": "integer",
          "description": "Video height in pixels",
          "minimum": 1,
          "maximum": 8192
        },
        "fps": {
          "type": "integer",
          "description": "Frames per second (scaled by 100, e.g., 2997 = 29.97 fps)",
          "minimum": 100,
          "maximum": 24000
        },
        "codec": {
          "type": "string",
          "description": "Video codec (e.g., 'h264', 'vp9', 'av1')",
          "maxLength": 32
        },
        "hasAudio": {
          "type": "boolean",
          "description": "Whether the video contains an audio track",
          "default": true
        }
      }
    }
  }
} as const satisfies LexiconDoc
