/**
 * Timeline Compiler
 *
 * Compiles hierarchical Project data into a flat LayoutTimeline.
 * The timeline uses segments with placements for O(log n) time queries.
 */

import type { Clip, Group, Project, Track, Value } from '@eddy/lexicons'
import type {
  ActivePlacement,
  LayoutSegment,
  LayoutTimeline,
  Placement,
  TransitionInfo,
  Viewport,
} from './layout-types'

/** Canvas dimensions for viewport calculation */
export interface CanvasSize {
  width: number
  height: number
}

/** Intermediate clip info before segmentation */
interface ClipInfo {
  clipId: string
  trackId: string
  viewport: Viewport
  timelineStart: number // When clip starts on timeline
  timelineEnd: number // When clip ends on timeline
  sourceIn: number // Source start time
  sourceOut: number // Source end time
  speed: number
}

/** Resolve a Value (static or curve ref) to a number at a given time */
function resolveValue(value: Value | undefined, defaultValue: number, _time = 0): number {
  if (!value) return defaultValue
  if ('value' in value) {
    // Static value - scaled by 100 in lexicon
    return value.value / 100
  }
  // Curve ref - for now return min as default (TODO: implement curve evaluation)
  return (value.min ?? 0) / 100
}

/** Check if a member is a void placeholder */
function isVoidMember(member: { id?: string; type?: string }): boolean {
  return 'type' in member && member.type === 'void'
}

/** Get the root group from project */
function getRootGroup(project: Project): Group | undefined {
  if (project.rootGroup) {
    return project.groups.find(g => g.id === project.rootGroup)
  }
  return project.groups[0]
}

/** Calculate viewport for a grid cell */
function calculateGridViewport(
  cellIndex: number,
  columns: number,
  rows: number,
  canvasSize: CanvasSize,
  gap = 0,
  padding = 0,
): Viewport {
  const col = cellIndex % columns
  const row = Math.floor(cellIndex / columns)

  // Calculate cell size accounting for gap and padding
  const totalGapX = gap * (columns - 1)
  const totalGapY = gap * (rows - 1)
  const availableWidth = canvasSize.width * (1 - 2 * padding) - totalGapX
  const availableHeight = canvasSize.height * (1 - 2 * padding) - totalGapY

  const cellWidth = availableWidth / columns
  const cellHeight = availableHeight / rows

  // Calculate position
  const paddingX = canvasSize.width * padding
  const paddingY = canvasSize.height * padding
  const x = paddingX + col * (cellWidth + gap)
  const y = paddingY + row * (cellHeight + gap)

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(cellWidth),
    height: Math.round(cellHeight),
  }
}

/** Calculate viewport for stacked layout (all members full size) */
function calculateStackViewport(canvasSize: CanvasSize): Viewport {
  return {
    x: 0,
    y: 0,
    width: canvasSize.width,
    height: canvasSize.height,
  }
}

/** Collect all clips with their timing and viewport info */
function collectClipInfos(project: Project, canvasSize: CanvasSize): ClipInfo[] {
  const rootGroup = getRootGroup(project)
  if (!rootGroup) return []

  // Build track lookup map
  const trackMap = new Map<string, Track>()
  for (const track of project.tracks) {
    trackMap.set(track.id, track)
  }

  const clipInfos: ClipInfo[] = []

  // Get layout info
  const layout = rootGroup.layout
  const columns = layout?.columns ?? 1
  const rows = layout?.rows ?? 1
  const gap = layout ? resolveValue(layout.gap, 0) : 0
  const padding = layout ? resolveValue(layout.padding, 0) : 0

  // Process members
  let cellIndex = 0
  for (const member of rootGroup.members) {
    if (isVoidMember(member)) {
      cellIndex++
      continue
    }

    const memberId = (member as { id: string }).id
    const track = trackMap.get(memberId)

    if (!track) {
      cellIndex++
      continue
    }

    // Calculate viewport based on layout
    const viewport = layout
      ? calculateGridViewport(cellIndex, columns, rows, canvasSize, gap, padding)
      : calculateStackViewport(canvasSize)

    // Collect clip info
    for (const clip of track.clips) {
      // Skip group sources for now
      if (clip.source?.type === 'group') continue

      const speed = resolveValue(clip.speed, 1)
      const timelineStart = clip.offset / 1000 // ms to seconds
      const timelineEnd = (clip.offset + clip.duration) / 1000
      const sourceIn = (clip.sourceOffset ?? 0) / 1000
      const sourceOut = sourceIn + clip.duration / 1000

      clipInfos.push({
        clipId: clip.id,
        trackId: track.id,
        viewport,
        timelineStart,
        timelineEnd,
        sourceIn,
        sourceOut,
        speed,
      })
    }

    cellIndex++
  }

  return clipInfos
}

/** Build segments from clip transition points */
function buildSegments(clipInfos: ClipInfo[]): LayoutSegment[] {
  if (clipInfos.length === 0) return []

  // Collect all transition points (clip starts and ends)
  const transitionSet = new Set<number>()
  transitionSet.add(0) // Always start at 0

  for (const clip of clipInfos) {
    transitionSet.add(clip.timelineStart)
    transitionSet.add(clip.timelineEnd)
  }

  // Sort transition points
  const transitions = Array.from(transitionSet).sort((a, b) => a - b)

  // Build segments between consecutive transitions
  const segments: LayoutSegment[] = []

  for (let i = 0; i < transitions.length - 1; i++) {
    const startTime = transitions[i]
    const endTime = transitions[i + 1]

    // Find all clips active during this segment
    const placements: Placement[] = []

    for (const clip of clipInfos) {
      // Clip is active if it overlaps with this segment
      if (clip.timelineStart < endTime && clip.timelineEnd > startTime) {
        placements.push({
          clipId: clip.clipId,
          trackId: clip.trackId,
          viewport: clip.viewport,
          in: clip.sourceIn,
          out: clip.sourceOut,
          speed: clip.speed,
        })
      }
    }

    // Only add segment if it has placements
    if (placements.length > 0) {
      segments.push({ startTime, endTime, placements })
    }
  }

  return segments
}

/**
 * Compile a Project into a LayoutTimeline
 */
export function compileLayoutTimeline(project: Project, canvasSize: CanvasSize): LayoutTimeline {
  // Collect all clip info
  const clipInfos = collectClipInfos(project, canvasSize)

  // Build segments from transitions
  const segments = buildSegments(clipInfos)

  // Calculate duration
  let duration = 0
  for (const clip of clipInfos) {
    if (clip.timelineEnd > duration) {
      duration = clip.timelineEnd
    }
  }

  return { duration, segments }
}

/**
 * Binary search to find segment containing time.
 * Returns the segment or null if time is outside all segments.
 */
export function findSegmentAtTime(timeline: LayoutTimeline, time: number): LayoutSegment | null {
  const { segments } = timeline
  if (segments.length === 0) return null

  let low = 0
  let high = segments.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const segment = segments[mid]

    if (time < segment.startTime) {
      high = mid - 1
    } else if (time >= segment.endTime) {
      low = mid + 1
    } else {
      // time is within this segment
      return segment
    }
  }

  return null
}

/**
 * Get all placements active at a given time with computed local times.
 * Uses binary search for O(log n) segment lookup.
 */
export function getActivePlacements(timeline: LayoutTimeline, time: number): ActivePlacement[] {
  const segment = findSegmentAtTime(timeline, time)
  if (!segment) return []

  const timeInSegment = time - segment.startTime

  return segment.placements.map(placement => ({
    placement,
    localTime: placement.in + timeInSegment * placement.speed,
  }))
}

/**
 * Get all placements that overlap with a time range (for pre-buffering).
 */
export function getPlacementsInRange(
  timeline: LayoutTimeline,
  start: number,
  end: number,
): Placement[] {
  const placements: Placement[] = []
  const seen = new Set<string>() // Dedupe by clipId

  for (const segment of timeline.segments) {
    // Check if segment overlaps with range
    if (segment.endTime > start && segment.startTime < end) {
      for (const placement of segment.placements) {
        if (!seen.has(placement.clipId)) {
          seen.add(placement.clipId)
          placements.push(placement)
        }
      }
    }
  }

  return placements
}

/**
 * Get the next transition point after a given time.
 */
export function getNextTransition(
  timeline: LayoutTimeline,
  time: number,
): TransitionInfo | null {
  const { segments } = timeline

  // Find all segment boundaries after current time
  const transitions = new Map<number, { starting: Placement[]; ending: Placement[] }>()

  for (const segment of segments) {
    // Segment starts after current time
    if (segment.startTime > time) {
      const t = transitions.get(segment.startTime) ?? { starting: [], ending: [] }
      t.starting.push(...segment.placements)
      transitions.set(segment.startTime, t)
    }

    // Segment ends after current time
    if (segment.endTime > time) {
      const t = transitions.get(segment.endTime) ?? { starting: [], ending: [] }
      t.ending.push(...segment.placements)
      transitions.set(segment.endTime, t)
    }
  }

  if (transitions.size === 0) return null

  // Find the earliest transition
  const times = Array.from(transitions.keys()).sort((a, b) => a - b)
  const nextTime = times[0]
  const info = transitions.get(nextTime)!

  return {
    time: nextTime,
    starting: info.starting,
    ending: info.ending,
  }
}
