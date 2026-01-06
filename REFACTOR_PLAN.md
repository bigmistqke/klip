# Refactor Plan: Data-Driven Timeline Architecture

## Overview

Refactor from hardcoded 4-track/2x2 grid to a data-driven architecture where the project data structure drives rendering, layout, and playback.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Project Data (hierarchical, user-editable)                 │
│  - Groups, Tracks, Clips, Stems                             │
│  - Layout definitions (grid, stack)                         │
│  - Effect pipelines                                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │  compile (when project changes)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Layout Timeline (intermediate representation)              │
│  - Sequence of layouts over time                            │
│  - Pre-computed viewports                                   │
│  - Flattened for efficient queries                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │  query (at time T, look-ahead)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Compositor (rendering + buffering)                         │
│  - Walks layout timeline                                    │
│  - Pre-buffers upcoming segments                            │
│  - Renders active segments to canvas                        │
└─────────────────────────────────────────────────────────────┘
```

## Data Model

### Project Data (Source of Truth)

```ts
Stem                          # Raw media blob

Clip<T> {
  source: T                   # Stem | Group
  in: number                  # Start in source (seconds)
  out: number                 # End in source (seconds)
  position: number            # Position on track (seconds)
  speed: number               # Playback rate (1 = normal)
  effects: Effect[]
}

Track {
  id: string
  clips: Clip<Stem | Group>[]
  effects: Effect[]
}

Group {
  id: string
  layout: { type: 'grid', columns, rows } | { type: 'stack' }
  members: (Track | Group)[]
  effects: Effect[]
}

Project {
  rootGroup: Group            # Timeline IS the root group
  stems: Stem[]
}
```

### Layout Timeline (Compiled Representation)

```ts
interface LayoutTimeline {
  duration: number            # Total duration
  slots: LayoutSlot[]         # One per visible track
}

interface LayoutSlot {
  trackId: string
  segments: LayoutSegment[]   # Sorted by startTime
}

interface LayoutSegment {
  startTime: number           # When this segment starts
  endTime: number             # When this segment ends
  viewport: Viewport          # Where to render
  source: StemRef | LayoutTimeline  # What to render (nested = sub-timeline)
  effects: CompiledEffect[]   # Pre-resolved effects
}

interface Viewport {
  x: number                   # Left edge (0-1 normalized or pixels)
  y: number                   # Top edge
  width: number
  height: number
}

interface StemRef {
  stemId: string
  in: number                  # Trim start in stem
  out: number                 # Trim end in stem
  speed: number               # Playback rate
}
```

### Compositor Queries

```ts
interface CompositorTimeline {
  # Get segments active at time T
  getActiveSegments(time: number): ActiveSegment[]

  # Get all segments in time range (for pre-buffering)
  getSegmentsInRange(start: number, end: number): LayoutSegment[]

  # Get next segment transition (for scheduling)
  getNextTransition(time: number): { time: number, segments: LayoutSegment[] } | null
}

interface ActiveSegment {
  segment: LayoutSegment
  localTime: number           # Time within the segment (accounting for in/speed)
  viewport: Viewport
}
```

---

## Ticket 1: Update Lexicon Types

**Goal:** Align `@eddy/lexicons` with the new data model.

**Changes:**
- [ ] Update `app.eddy.project` lexicon:
  - Add `rootGroup` field (or rename existing `groups[0]`)
  - Ensure `Clip` type supports `source: Stem | Group` reference
  - Add `in`, `out`, `position`, `speed` to clip type
- [ ] Update TypeScript types in `packages/lexicons/src/index.ts`
- [ ] Ensure backwards compatibility or migration path

**Files:**
- `packages/lexicons/src/app.eddy.project.ts`
- `packages/lexicons/src/index.ts`

**Acceptance:**
- Types compile
- Can represent: single clip per track, multiple clips per track, nested groups

---

## Ticket 2: Layout Resolver (Compile Project → Layout Timeline)

**Goal:** Create a resolver that compiles hierarchical project data into a flat, time-indexed layout timeline.

**Changes:**
- [ ] Create `packages/app/src/lib/layout-resolver.ts`
- [ ] Implement `compileLayoutTimeline(project: Project): LayoutTimeline`
- [ ] Walk group tree recursively
- [ ] Compute viewport for each track based on parent layout (grid/stack)
- [ ] For nested groups: create sub-LayoutTimeline as segment source
- [ ] Handle clip timing: position, in/out, speed → startTime/endTime

**Interface:**
```ts
function compileLayoutTimeline(project: Project, canvasSize: { width: number, height: number }): LayoutTimeline

// Query helpers
function getActiveSegments(timeline: LayoutTimeline, time: number): ActiveSegment[]
function getSegmentsInRange(timeline: LayoutTimeline, start: number, end: number): LayoutSegment[]
function getNextTransition(timeline: LayoutTimeline, time: number): TransitionInfo | null
```

**Example:**
```ts
// Input: Project with 2x2 grid, 4 tracks, 1 clip each
// Output:
{
  duration: 30,
  slots: [
    { trackId: 'track-0', segments: [{ startTime: 0, endTime: 30, viewport: { x: 0, y: 0, w: 320, h: 180 }, source: { stemId: '...', in: 0, out: 30 } }] },
    { trackId: 'track-1', segments: [{ startTime: 0, endTime: 30, viewport: { x: 320, y: 0, w: 320, h: 180 }, source: { ... } }] },
    // ...
  ]
}
```

**Files:**
- `packages/app/src/lib/layout-resolver.ts` (new)
- `packages/app/src/lib/layout-types.ts` (new - shared types)

**Acceptance:**
- Compiles simple 4-track grid correctly
- Handles clips with different positions/durations
- Query functions return correct segments for time T
- (Future) Handles nested groups

---

## Ticket 3: Refactor Compositor to Use Layout Timeline

**Goal:** Compositor receives and walks a LayoutTimeline instead of hardcoded slots.

**Changes:**
- [ ] New method: `setTimeline(timeline: LayoutTimeline)`
- [ ] Remove hardcoded slot count, derive from timeline
- [ ] `render(time: number)` queries timeline for active segments
- [ ] Dynamic texture pool (grow as needed)
- [ ] Remove `setGrid()` - layout comes from timeline

**Interface after:**
```ts
interface CompositorWorkerMethods {
  init(canvas: OffscreenCanvas, width: number, height: number): Promise<void>

  // Set the compiled layout timeline
  setTimeline(timeline: LayoutTimeline): void

  // Set frame for a specific segment (identified by trackId + time)
  setFrame(trackId: string, time: number, frame: VideoFrame | null): void

  // Render at time T (queries timeline internally)
  render(time: number): void

  // Pre-buffering queries
  getSegmentsInRange(start: number, end: number): LayoutSegment[]

  destroy(): void
}
```

**Files:**
- `packages/app/src/workers/compositor.worker.ts`

**Acceptance:**
- Works with any number of tracks
- Layout derived from timeline, not hardcoded
- Renders segments at correct viewports
- No hardcoded "4" or "2x2" anywhere

---

## Ticket 4: Refactor Player to Use Layout Timeline

**Goal:** Player compiles project to timeline and passes to compositor.

**Changes:**
- [ ] Remove `NUM_TRACKS = 4` constant
- [ ] Accept `project` as parameter
- [ ] On project change: recompile layout timeline
- [ ] Pass timeline to compositor via `setTimeline()`
- [ ] Create slot/playback instances based on timeline slots
- [ ] On tick: pass current time to compositor `render(time)`

**Files:**
- `packages/app/src/hooks/create-player.ts`
- `packages/app/src/hooks/create-slot.ts`

**Interface after:**
```ts
interface CreatePlayerOptions {
  canvas: HTMLCanvasElement
  project: Accessor<Project>  // Reactive - recompiles on change
}

async function createPlayer(options: CreatePlayerOptions): Promise<Player>
```

**Acceptance:**
- Player works with any project structure
- Layout changes when project changes
- Compositor receives updated timeline on project edit

---

## Ticket 5: Refactor Editor UI to Render from Project

**Goal:** Editor renders tracks dynamically from project data.

**Changes:**
- [ ] Remove `TRACK_IDS = [0, 1, 2, 3]`
- [ ] Iterate `project.rootGroup.members`
- [ ] CSS grid columns/rows from `group.layout`
- [ ] Track component receives track data, not just index
- [ ] Handle empty members (void/placeholder)

**Files:**
- `packages/app/src/components/editor/Editor.tsx`
- `packages/app/src/components/editor/Editor.module.css`
- `packages/app/src/components/editor/Track.tsx`

**UI after:**
```tsx
<div
  class={styles.grid}
  style={{
    'grid-template-columns': `repeat(${layout.columns}, 1fr)`,
    'grid-template-rows': `repeat(${layout.rows}, 1fr)`,
  }}
>
  <For each={project.rootGroup.members}>
    {(member) => <Track track={getTrack(member.id)} ... />}
  </For>
</div>
```

**Acceptance:**
- UI reflects project structure
- Can display 1x1, 2x2, 3x3, 1x4, etc. layouts
- Adding track to project data adds track to UI

---

## Ticket 6: Segment-Based Buffering

**Goal:** Buffering is driven by layout timeline segments, not slots.

**Changes:**
- [ ] Create `SegmentPlayback` abstraction:
  ```ts
  interface SegmentPlayback {
    segment: LayoutSegment
    state: 'cold' | 'warming' | 'hot'
    warm(): Promise<void>
    ensureHot(): Promise<void>
    isHotAt(localTime: number): boolean
    getFrame(localTime: number): VideoFrame | null
    destroy(): void
  }
  ```
- [ ] Player maintains pool of `SegmentPlayback` instances
- [ ] Create/destroy based on timeline changes
- [ ] Map segment to playback by `trackId + startTime`

**Files:**
- `packages/playback/src/segment-playback.ts` (new)
- `packages/app/src/hooks/create-player.ts`

**Acceptance:**
- Each segment buffers independently
- Segment state accurately reflects buffer status
- Multiple segments per track supported

---

## Ticket 7: Look-Ahead Scheduler

**Goal:** Background scheduler pre-buffers upcoming segments using timeline queries.

**Changes:**
- [ ] Scheduler uses `getSegmentsInRange(currentTime, currentTime + lookAhead)`
- [ ] Warm segments approaching playback
- [ ] Priority queue: closer segments first
- [ ] Runs on RAF or tick

**Implementation:**
```ts
function updateScheduler(timeline: LayoutTimeline, currentTime: number, lookAhead: number) {
  const upcoming = getSegmentsInRange(timeline, currentTime, currentTime + lookAhead)

  for (const segment of upcoming) {
    const playback = getOrCreatePlayback(segment)
    const timeUntil = segment.startTime - currentTime

    if (timeUntil < 0 && !playback.isHotAt(currentTime - segment.startTime)) {
      // Active now but not hot - urgent!
      playback.ensureHot()
    } else if (timeUntil < 2) {
      // Coming soon - start warming
      playback.warm()
    }
  }
}
```

**Files:**
- `packages/app/src/hooks/create-scheduler.ts` (new)
- `packages/app/src/hooks/create-player.ts`

**Acceptance:**
- Segments are buffered before needed
- No black frames on segment transitions
- Works with multi-clip tracks

---

## Ticket 8: Fix PrepareToPlay Black Frame

**Goal:** Pressing play doesn't cause black frame when already buffered.

**Changes:**
- [ ] `prepareToPlay(time)` checks if active segments are hot
- [ ] If all hot: skip, return immediately
- [ ] If not: wait for scheduler or force-buffer

**Files:**
- `packages/app/src/hooks/create-player.ts`

**Acceptance:**
- Play after recording: no black frame
- Play after pause: no black frame
- Play after seek: buffers only if needed

---

## Ticket 9: Nested Group Support (Future)

**Goal:** Support `Clip<Group>` for nested compositions.

**Changes:**
- [ ] Layout resolver creates nested `LayoutTimeline` as segment source
- [ ] `SegmentPlayback` handles nested timeline (recursive rendering)
- [ ] Compositor renders nested timeline to intermediate texture
- [ ] Time mapping: parent clip's timing affects nested playback

**Deferred:** Post-MVP.

---

## Execution Order

```
Ticket 1 (Types)
    │
    ├──→ Ticket 2 (Layout Resolver) ──→ Ticket 3 (Compositor) ──→ Ticket 4 (Player)
    │                                                                  │
    │                                                                  ▼
    │                                                           Ticket 5 (UI)
    │
    └──→ Ticket 6 (Segment Buffering) ──→ Ticket 7 (Scheduler) ──→ Ticket 8 (Bug Fix)
                                                                       │
                                                                       ▼
                                                               Ticket 9 (Nesting)
```

**Parallel tracks:**
- Track A: Types → Resolver → Compositor → Player → UI
- Track B: Types → Segment Buffering → Scheduler → Bug Fix

---

## MVP Scope

**MVP (Tickets 1-5, 8 simplified):**
- Single clip per track
- Grid layout only
- No nesting
- 4 tracks default (architecture supports N)
- Simplified bug fix: check `isHotAt()` before seeking

**Post-MVP (Tickets 6-7):**
- Multi-clip tracks
- Full scheduler with look-ahead
- Seamless segment transitions

**Future (Ticket 9):**
- Nested groups
- Clip<Group> support
