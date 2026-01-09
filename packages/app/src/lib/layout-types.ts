/**
 * Layout Timeline Types
 *
 * Intermediate representation compiled from Project data.
 * Uses a segment/placement model for O(log n) time queries.
 *
 * Key concepts:
 * - Placement: a clip's position in space (viewport) and source timing
 * - Segment: a time range with stable layout (no clips starting/ending)
 * - Timeline: sorted segments for binary search by time
 */

/** Viewport defines where to render on the canvas */
export interface Viewport {
  x: number // Left edge in pixels
  y: number // Top edge in pixels
  width: number
  height: number
}

/**
 * A placement describes where and how to render a clip.
 * This is a flat structure - no nesting.
 */
export interface Placement {
  /** Clip ID for frame lookup */
  clipId: string
  /** Track ID for audio routing */
  trackId: string
  /** Where to render on canvas */
  viewport: Viewport
  /** Source timing */
  in: number // Start time in source (seconds)
  out: number // End time in source (seconds)
  speed: number // Playback rate (1 = normal)
}

/**
 * A segment represents a time range where layout is stable.
 * No clips start or end within a segment - that would create a new segment.
 */
export interface LayoutSegment {
  /** When this segment starts on the timeline (seconds) */
  startTime: number
  /** When this segment ends on the timeline (seconds) */
  endTime: number
  /** All placements active during this segment */
  placements: Placement[]
}

/**
 * The compiled layout timeline.
 * Segments are sorted by startTime for O(log n) binary search.
 */
export interface LayoutTimeline {
  /** Total duration in seconds */
  duration: number
  /** Sorted segments (by startTime) */
  segments: LayoutSegment[]
}

/** Clip ID used for preview placements */
export const PREVIEW_CLIP_ID = 'preview'

/**
 * An active placement with computed local time.
 * Returned by getActivePlacements().
 */
export interface ActivePlacement {
  placement: Placement
  /** Time within the source (accounting for in/speed) */
  localTime: number
}

/** Info about the next transition point */
export interface TransitionInfo {
  /** When the transition occurs */
  time: number
  /** Placements starting at this time */
  starting: Placement[]
  /** Placements ending at this time */
  ending: Placement[]
}
