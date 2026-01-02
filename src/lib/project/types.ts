// Types matching app.klip.project and app.klip.stem lexicons
// Values are stored as integers scaled by 100 (AT Protocol doesn't support floats)
// e.g., gain 1.0 = 100, pan center 0.5 = 50
// UI interprets values at render time (value / 100)

export interface Canvas {
  width: number
  height: number
  background?: string
}

export interface StaticValue {
  value: number
  min?: number
  max?: number
  default?: number
}

export interface StaticBooleanValue {
  value: boolean
}

export type Value = StaticValue
export type BooleanValue = StaticBooleanValue

export interface AudioEffectGain {
  type: 'audio.gain'
  enabled?: BooleanValue
  value: Value
}

export interface AudioEffectPan {
  type: 'audio.pan'
  enabled?: BooleanValue
  value: Value
}

export type AudioEffect = AudioEffectGain | AudioEffectPan

export interface StemRef {
  uri: string
  cid: string
}

export interface Clip {
  id: string
  stem?: StemRef
  offset: number
  sourceOffset?: number
  duration: number
  speed?: Value
  reverse?: BooleanValue
  audioPipeline?: AudioEffect[]
}

export interface Track {
  id: string
  name?: string
  clips: Clip[]
  audioPipeline?: AudioEffect[]
  muted?: BooleanValue
  solo?: BooleanValue
}

export interface GridMember {
  id: string
  column?: number
  row?: number
  columnSpan?: number
  rowSpan?: number
  fit?: 'contain' | 'cover' | 'fill'
}

export interface GridGroup {
  type: 'grid'
  id: string
  name?: string
  columns: number
  rows: number
  gap?: Value
  padding?: Value
  autoPlace?: boolean
  members: GridMember[]
}

export type Group = GridGroup

export interface Project {
  schemaVersion: number
  title: string
  description?: string
  bpm?: number
  duration?: number
  canvas: Canvas
  curves?: unknown[]
  groups: Group[]
  tracks: Track[]
  masterAudioPipeline?: AudioEffect[]
  createdAt: string
  updatedAt?: string
}

// Stem record (separate from project)
export interface StemAudioMeta {
  sampleRate?: number
  channels?: number
  bitrate?: number
  codec?: string
}

export interface StemVideoMeta {
  width?: number
  height?: number
  fps?: number
  codec?: string
  hasAudio?: boolean
}

export interface Stem {
  schemaVersion: number
  blob: {
    ref: { $link: string }
    mimeType: string
    size: number
  }
  type: 'audio' | 'video'
  mimeType: string
  duration: number
  audio?: StemAudioMeta
  video?: StemVideoMeta
  createdAt: string
}

// Local state extensions (not persisted to PDS)
export interface LocalClipState {
  // The actual blob for playback (not serialized)
  blob?: Blob
  // Duration in ms
  duration?: number
}
