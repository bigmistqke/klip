import { describe, expect, it } from 'vitest'
import type { Project } from '@eddy/lexicons'
import {
  compileLayoutTimeline,
  getActivePlacements,
  getNextTransition,
  getPlacementsInRange,
  findSegmentAtTime,
} from '../timeline-compiler'

/** Create a minimal valid project for testing */
function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    title: 'Test Project',
    canvas: { width: 640, height: 360 },
    groups: [
      {
        id: 'group-0',
        members: [{ id: 'track-0' }, { id: 'track-1' }, { id: 'track-2' }, { id: 'track-3' }],
        layout: { type: 'grid', columns: 2, rows: 2 },
      },
    ],
    tracks: [
      {
        id: 'track-0',
        clips: [
          {
            id: 'clip-0',
            source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/0', cid: 'cid0' } },
            offset: 0,
            duration: 10000, // 10 seconds
          },
        ],
      },
      {
        id: 'track-1',
        clips: [
          {
            id: 'clip-1',
            source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/1', cid: 'cid1' } },
            offset: 0,
            duration: 15000, // 15 seconds
          },
        ],
      },
      {
        id: 'track-2',
        clips: [
          {
            id: 'clip-2',
            source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/2', cid: 'cid2' } },
            offset: 5000, // starts at 5 seconds
            duration: 10000, // 10 seconds
          },
        ],
      },
      {
        id: 'track-3',
        clips: [],
      },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('compileLayoutTimeline', () => {
  it('compiles a simple 2x2 grid project', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    expect(timeline.duration).toBe(15) // max of all clips
    // Segments are created at transition points (0, 5, 10, 15)
    expect(timeline.segments.length).toBeGreaterThan(0)
  })

  it('calculates correct viewports for 2x2 grid', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // Find segment at time 0
    const segment = findSegmentAtTime(timeline, 0)
    expect(segment).not.toBeNull()

    // Track 0 should be top-left
    const clip0 = segment!.placements.find(p => p.clipId === 'clip-0')
    expect(clip0?.viewport).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    })

    // Track 1 should be top-right
    const clip1 = segment!.placements.find(p => p.clipId === 'clip-1')
    expect(clip1?.viewport).toEqual({
      x: 320,
      y: 0,
      width: 320,
      height: 180,
    })
  })

  it('creates segments at transition points', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // Should have segments: [0-5] [5-10] [10-15]
    // At 0: clip-0, clip-1 active
    // At 5: clip-0, clip-1, clip-2 active
    // At 10: clip-1, clip-2 active
    expect(timeline.segments[0].startTime).toBe(0)
    expect(timeline.segments[0].endTime).toBe(5)
    expect(timeline.segments[0].placements).toHaveLength(2) // clip-0, clip-1

    expect(timeline.segments[1].startTime).toBe(5)
    expect(timeline.segments[1].endTime).toBe(10)
    expect(timeline.segments[1].placements).toHaveLength(3) // clip-0, clip-1, clip-2

    expect(timeline.segments[2].startTime).toBe(10)
    expect(timeline.segments[2].endTime).toBe(15)
    expect(timeline.segments[2].placements).toHaveLength(2) // clip-1, clip-2
  })

  it('handles empty project', () => {
    const project = createTestProject({ groups: [], tracks: [] })
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    expect(timeline.duration).toBe(0)
    expect(timeline.segments).toHaveLength(0)
  })

  it('handles void members in grid', () => {
    const project = createTestProject({
      groups: [
        {
          id: 'group-0',
          members: [
            { id: 'track-0' },
            { type: 'void' }, // skip cell
            { id: 'track-1' },
            { id: 'track-2' },
          ],
          layout: { type: 'grid', columns: 2, rows: 2 },
        },
      ],
    })
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const segment = findSegmentAtTime(timeline, 7)
    expect(segment).not.toBeNull()

    // Track 1 should be at bottom-left (skipped top-right due to void)
    const clip1 = segment!.placements.find(p => p.clipId === 'clip-1')
    expect(clip1?.viewport).toEqual({
      x: 0,
      y: 180,
      width: 320,
      height: 180,
    })
  })

  it('uses rootGroup when specified', () => {
    const project = createTestProject({
      rootGroup: 'group-1',
      groups: [
        {
          id: 'group-0',
          members: [{ id: 'track-0' }],
          layout: { type: 'grid', columns: 1, rows: 1 },
        },
        {
          id: 'group-1',
          members: [{ id: 'track-1' }],
          layout: { type: 'grid', columns: 1, rows: 1 },
        },
      ],
    })
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // Should only have clip-1 (from rootGroup group-1)
    const segment = findSegmentAtTime(timeline, 0)
    expect(segment?.placements).toHaveLength(1)
    expect(segment?.placements[0].clipId).toBe('clip-1')
  })

  it('handles stacked layout (no grid)', () => {
    const project = createTestProject({
      groups: [
        {
          id: 'group-0',
          members: [{ id: 'track-0' }, { id: 'track-1' }],
          // No layout = stacked
        },
      ],
    })
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const segment = findSegmentAtTime(timeline, 0)
    expect(segment).not.toBeNull()

    // Both clips should have full canvas viewport
    for (const placement of segment!.placements) {
      expect(placement.viewport).toEqual({
        x: 0,
        y: 0,
        width: 640,
        height: 360,
      })
    }
  })
})

describe('findSegmentAtTime (binary search)', () => {
  it('finds correct segment at various times', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // At time 2: should be first segment [0-5]
    const seg0 = findSegmentAtTime(timeline, 2)
    expect(seg0?.startTime).toBe(0)
    expect(seg0?.endTime).toBe(5)

    // At time 7: should be second segment [5-10]
    const seg1 = findSegmentAtTime(timeline, 7)
    expect(seg1?.startTime).toBe(5)
    expect(seg1?.endTime).toBe(10)

    // At time 12: should be third segment [10-15]
    const seg2 = findSegmentAtTime(timeline, 12)
    expect(seg2?.startTime).toBe(10)
    expect(seg2?.endTime).toBe(15)
  })

  it('returns null for time outside segments', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    expect(findSegmentAtTime(timeline, 20)).toBeNull()
    expect(findSegmentAtTime(timeline, -1)).toBeNull()
  })
})

describe('getActivePlacements', () => {
  it('returns placements active at time 0', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActivePlacements(timeline, 0)

    // clip-0 and clip-1 are active at time 0, clip-2 starts at 5
    expect(active).toHaveLength(2)
    expect(active.map(a => a.placement.clipId).sort()).toEqual(['clip-0', 'clip-1'])
  })

  it('returns placements active at time 7', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActivePlacements(timeline, 7)

    // All 3 clips should be active
    expect(active).toHaveLength(3)
  })

  it('calculates correct localTime', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActivePlacements(timeline, 7)

    // clip-2 starts at 5, so at timeline time 7 we're 2 seconds into segment [5-10]
    // localTime should be placement.in + timeInSegment * speed = 0 + 2 * 1 = 2
    const clip2Active = active.find(a => a.placement.clipId === 'clip-2')
    expect(clip2Active?.localTime).toBe(2)
  })

  it('returns empty after all clips end', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActivePlacements(timeline, 20)

    expect(active).toHaveLength(0)
  })
})

describe('getPlacementsInRange', () => {
  it('returns placements overlapping with range', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const placements = getPlacementsInRange(timeline, 0, 3)

    // clip-0 and clip-1 overlap with 0-3
    expect(placements).toHaveLength(2)
  })

  it('includes placements that start in range', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const placements = getPlacementsInRange(timeline, 4, 6)

    // clip-2 starts at 5, should be included
    expect(placements.some(p => p.clipId === 'clip-2')).toBe(true)
  })

  it('includes all placements for full duration', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const placements = getPlacementsInRange(timeline, 0, 20)

    expect(placements).toHaveLength(3)
  })

  it('deduplicates placements across segments', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // clip-1 appears in all 3 segments, should only appear once
    const placements = getPlacementsInRange(timeline, 0, 15)
    const clip1Count = placements.filter(p => p.clipId === 'clip-1').length
    expect(clip1Count).toBe(1)
  })
})

describe('getNextTransition', () => {
  it('returns next segment boundary', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const transition = getNextTransition(timeline, 0)

    // Next boundary after 0 is at 5 (when clip-2 starts)
    expect(transition?.time).toBe(5)
  })

  it('returns null when no more transitions', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const transition = getNextTransition(timeline, 20)

    expect(transition).toBeNull()
  })
})

describe('multiple clips per track', () => {
  it('handles multiple sequential clips', () => {
    const project = createTestProject({
      tracks: [
        {
          id: 'track-0',
          clips: [
            {
              id: 'clip-0a',
              source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/0a', cid: 'cid0a' } },
              offset: 0,
              duration: 5000,
            },
            {
              id: 'clip-0b',
              source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/0b', cid: 'cid0b' } },
              offset: 5000,
              duration: 5000,
            },
          ],
        },
      ],
      groups: [
        {
          id: 'group-0',
          members: [{ id: 'track-0' }],
          layout: { type: 'grid', columns: 1, rows: 1 },
        },
      ],
    })

    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // Should have 2 segments: [0-5] with clip-0a, [5-10] with clip-0b
    expect(timeline.segments).toHaveLength(2)
    expect(timeline.segments[0].placements[0].clipId).toBe('clip-0a')
    expect(timeline.segments[1].placements[0].clipId).toBe('clip-0b')
  })

  it('getActivePlacements returns correct placement for time', () => {
    const project = createTestProject({
      tracks: [
        {
          id: 'track-0',
          clips: [
            {
              id: 'clip-0a',
              source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/0a', cid: 'cid0a' } },
              offset: 0,
              duration: 5000,
            },
            {
              id: 'clip-0b',
              source: { type: 'stem', ref: { uri: 'at://did/app.eddy.stem/0b', cid: 'cid0b' } },
              offset: 5000,
              duration: 5000,
            },
          ],
        },
      ],
      groups: [
        {
          id: 'group-0',
          members: [{ id: 'track-0' }],
          layout: { type: 'grid', columns: 1, rows: 1 },
        },
      ],
    })

    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // At time 2, should be clip-0a
    const activeAt2 = getActivePlacements(timeline, 2)
    expect(activeAt2).toHaveLength(1)
    expect(activeAt2[0].placement.clipId).toBe('clip-0a')

    // At time 7, should be clip-0b
    const activeAt7 = getActivePlacements(timeline, 7)
    expect(activeAt7).toHaveLength(1)
    expect(activeAt7[0].placement.clipId).toBe('clip-0b')
  })
})
