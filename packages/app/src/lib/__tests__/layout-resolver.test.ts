import { describe, expect, it } from 'vitest'
import type { Project } from '@eddy/lexicons'
import {
  compileLayoutTimeline,
  getActiveSegments,
  getNextTransition,
  getSegmentsInRange,
} from '../layout-resolver'

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
    expect(timeline.slots).toHaveLength(3) // 3 tracks with clips
  })

  it('calculates correct viewports for 2x2 grid', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    // Track 0 should be top-left
    const track0 = timeline.slots.find(s => s.trackId === 'track-0')
    expect(track0?.segments[0].viewport).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    })

    // Track 1 should be top-right
    const track1 = timeline.slots.find(s => s.trackId === 'track-1')
    expect(track1?.segments[0].viewport).toEqual({
      x: 320,
      y: 0,
      width: 320,
      height: 180,
    })

    // Track 2 should be bottom-left
    const track2 = timeline.slots.find(s => s.trackId === 'track-2')
    expect(track2?.segments[0].viewport).toEqual({
      x: 0,
      y: 180,
      width: 320,
      height: 180,
    })
  })

  it('handles segment timing correctly', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const track2 = timeline.slots.find(s => s.trackId === 'track-2')
    expect(track2?.segments[0].startTime).toBe(5) // starts at 5 seconds
    expect(track2?.segments[0].endTime).toBe(15) // ends at 15 seconds
  })

  it('handles empty project', () => {
    const project = createTestProject({ groups: [], tracks: [] })
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    expect(timeline.duration).toBe(0)
    expect(timeline.slots).toHaveLength(0)
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

    // Track 1 should be at bottom-left (skipped top-right due to void)
    const track1 = timeline.slots.find(s => s.trackId === 'track-1')
    expect(track1?.segments[0].viewport).toEqual({
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

    // Should only have track-1 (from rootGroup group-1)
    expect(timeline.slots).toHaveLength(1)
    expect(timeline.slots[0].trackId).toBe('track-1')
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

    // Both tracks should have full canvas viewport
    for (const slot of timeline.slots) {
      expect(slot.segments[0].viewport).toEqual({
        x: 0,
        y: 0,
        width: 640,
        height: 360,
      })
    }
  })
})

describe('getActiveSegments', () => {
  it('returns segments active at time 0', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActiveSegments(timeline, 0)

    // track-0 and track-1 are active at time 0, track-2 starts at 5
    expect(active).toHaveLength(2)
    expect(active.map(a => a.segment.trackId).sort()).toEqual(['track-0', 'track-1'])
  })

  it('returns segments active at time 7', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActiveSegments(timeline, 7)

    // All 3 tracks with clips should be active
    expect(active).toHaveLength(3)
  })

  it('calculates correct localTime', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActiveSegments(timeline, 7)

    // track-2 starts at 5, so localTime at 7 should be 2
    const track2Active = active.find(a => a.segment.trackId === 'track-2')
    expect(track2Active?.localTime).toBe(2)
  })

  it('returns empty after all clips end', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const active = getActiveSegments(timeline, 20)

    expect(active).toHaveLength(0)
  })
})

describe('getSegmentsInRange', () => {
  it('returns segments overlapping with range', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const segments = getSegmentsInRange(timeline, 0, 3)

    // track-0 and track-1 overlap with 0-3
    expect(segments).toHaveLength(2)
  })

  it('includes segments that start in range', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const segments = getSegmentsInRange(timeline, 4, 6)

    // track-2 starts at 5, should be included
    expect(segments.some(s => s.trackId === 'track-2')).toBe(true)
  })

  it('includes all segments for full duration', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const segments = getSegmentsInRange(timeline, 0, 20)

    expect(segments).toHaveLength(3)
  })
})

describe('getNextTransition', () => {
  it('returns next segment start', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const transition = getNextTransition(timeline, 0)

    // track-2 starts at 5
    expect(transition?.time).toBe(5)
    expect(transition?.starting).toHaveLength(1)
    expect(transition?.starting[0].trackId).toBe('track-2')
  })

  it('returns next segment end', () => {
    const project = createTestProject()
    const timeline = compileLayoutTimeline(project, { width: 640, height: 360 })

    const transition = getNextTransition(timeline, 6)

    // track-0 ends at 10
    expect(transition?.time).toBe(10)
    expect(transition?.ending.some(s => s.trackId === 'track-0')).toBe(true)
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

    expect(timeline.slots).toHaveLength(1)
    expect(timeline.slots[0].segments).toHaveLength(2)
    expect(timeline.slots[0].segments[0].endTime).toBe(5)
    expect(timeline.slots[0].segments[1].startTime).toBe(5)
  })

  it('getActiveSegments returns correct segment for time', () => {
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
    const activeAt2 = getActiveSegments(timeline, 2)
    expect(activeAt2).toHaveLength(1)
    expect((activeAt2[0].segment.source as any).clipId).toBe('clip-0a')

    // At time 7, should be clip-0b
    const activeAt7 = getActiveSegments(timeline, 7)
    expect(activeAt7).toHaveLength(1)
    expect((activeAt7[0].segment.source as any).clipId).toBe('clip-0b')
  })
})
