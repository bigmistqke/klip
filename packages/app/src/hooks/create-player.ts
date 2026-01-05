import { debug, getGlobalPerfMonitor } from '@eddy/utils'
import { createMemo, onCleanup, type Accessor } from 'solid-js'
import { createCompositorWorkerWrapper } from '~/workers'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'
import { createClock, type Clock } from './create-clock'
import { createPreRenderer, type PreRenderer } from './create-pre-renderer'
import { createSlot, type Slot } from './create-slot'

const log = debug('player', true)
const perf = getGlobalPerfMonitor()

export interface PlayerState {
  /** Whether currently playing */
  isPlaying: Accessor<boolean>
  /** Current playback time */
  time: Accessor<number>
  /** Whether loop is enabled */
  loop: Accessor<boolean>
  /** Max duration across all clips */
  maxDuration: Accessor<number>
}

export interface PlayerActions {
  /** Start playback from time */
  play: (time?: number) => Promise<void>
  /** Pause playback */
  pause: () => void
  /** Stop and seek to beginning */
  stop: () => Promise<void>
  /** Seek to time */
  seek: (time: number) => Promise<void>
  /** Toggle loop */
  setLoop: (enabled: boolean) => void
  /** Load a clip into a track */
  loadClip: (trackIndex: number, blob: Blob) => Promise<void>
  /** Clear a clip from a track */
  clearClip: (trackIndex: number) => void
  /** Check if track has a clip */
  hasClip: (trackIndex: number) => boolean
  /** Check if track is currently loading a clip */
  isLoading: (trackIndex: number) => boolean
  /** Set preview stream for recording */
  setPreviewSource: (trackIndex: number, stream: MediaStream | null) => void
  /** Set track volume */
  setVolume: (trackIndex: number, value: number) => void
  /** Set track pan */
  setPan: (trackIndex: number, value: number) => void
  /** Clean up all resources */
  destroy: () => void
}

export interface Player extends PlayerState, PlayerActions {
  /** The canvas element */
  canvas: HTMLCanvasElement
  /** The compositor (for pre-renderer access) */
  compositor: WorkerCompositor
  /** Clock for time management */
  clock: Clock
  /** Pre-renderer state and actions */
  preRenderer: PreRenderer
  /** Get track slot */
  getSlot: (trackIndex: number) => Slot
  /** Performance logging */
  logPerf: () => void
  resetPerf: () => void
}

const NUM_TRACKS = 4

// Expose perf monitor globally for console debugging
if (typeof window !== 'undefined') {
  ; (window as any).eddy = { perf }
}

/**
 * Create a player that manages compositor, playbacks, and audio pipelines
 */
export async function createPlayer(width: number, height: number): Promise<Player> {
  log('createPlayer', { width, height })

  // Create compositor in worker
  const compositor = await createCompositorWorkerWrapper(width, height)

  // Create slots
  const slots = Array.from({ length: NUM_TRACKS }, (_, index) =>
    createSlot({ index, compositor })
  )

  // Derived max duration from slots
  const maxDuration = createMemo(() => {
    let max = 0
    for (const slot of slots) {
      const playback = slot.playback()
      if (playback) {
        max = Math.max(max, playback.duration)
      }
    }
    return max
  })

  // Create clock for time management (reads maxDuration reactively)
  const clock = createClock({ duration: maxDuration })

  // Create pre-renderer hook (reads maxDuration reactively)
  const preRenderer = createPreRenderer({ duration: maxDuration })

  // Render loop state
  let animationFrameId: number | null = null

  /**
   * Single render loop - drives everything
   */
  function renderLoop() {
    perf.start('renderLoop')

    const time = clock.tick()
    const playing = clock.isPlaying()
    const hasPreRender = preRenderer.hasPreRender()

    // Handle loop reset
    if (playing && clock.loop() && maxDuration() > 0 && time >= maxDuration()) {
      for (const slot of slots) {
        slot.resetForLoop(0)
      }
      preRenderer.resetForLoop(0)
    }

    // Tick individual playbacks for audio when using pre-render for video
    if (hasPreRender && playing) {
      for (const slot of slots) {
        slot.tick(time, false) // audio only
      }
    }

    // Use pre-rendered video if available
    if (hasPreRender) {
      perf.start('getPreRenderFrame')

      const frame = preRenderer.tick(time, playing)
      if (frame) {
        compositor.setGrid(1, 1)
        compositor.setFrame(0, frame)
        perf.increment('prerender-frame-sent')
      }

      perf.end('getPreRenderFrame')
    } else {
      // No pre-render: use 2x2 grid mode
      compositor.setGrid(2, 2)

      perf.start('getFrames')
      for (const slot of slots) {
        slot.renderFrame(time, playing)
      }
      perf.end('getFrames')
    }

    // Render
    compositor.render()

    perf.end('renderLoop')

    animationFrameId = requestAnimationFrame(renderLoop)
  }

  function startRenderLoop() {
    if (animationFrameId !== null) return
    animationFrameId = requestAnimationFrame(renderLoop)
  }

  function stopRenderLoop() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }

  function destroy(): void {
    stopRenderLoop()
    preRenderer.cancel()
    for (const slot of slots) {
      slot.destroy()
    }
    compositor.destroy()
  }

  async function play(time?: number): Promise<void> {
    const startTime = time ?? clock.time()
    log('play', { startTime })

    // Prepare all playbacks
    await Promise.all([
      ...slots.map(slot => slot.prepareToPlay(startTime)),
      preRenderer.playback()?.prepareToPlay(startTime)
    ])

    // Start audio
    for (const slot of slots) {
      slot.startAudio(startTime)
    }

    clock.play(startTime)
  }

  function pause() {
    if (!clock.isPlaying()) return

    for (const slot of slots) {
      slot.pause()
    }

    clock.pause()
  }

  async function stop(): Promise<void> {
    clock.stop()

    for (const slot of slots) {
      slot.stop()
    }

    // Seek to 0
    await Promise.all(slots.map(slot => slot.seek(0)))
  }

  async function seek(time: number): Promise<void> {
    const wasPlaying = clock.isPlaying()

    if (wasPlaying) {
      clock.pause()
    }

    await Promise.all(slots.map(slot => slot.seek(time)))

    clock.seek(time)

    if (wasPlaying) {
      clock.play(time)
    }
  }

  async function loadClip(trackIndex: number, blob: Blob): Promise<void> {
    log('loadClip', { trackIndex, blobSize: blob.size })
    await slots[trackIndex].load(blob)
    log('loadClip complete', { trackIndex })
  }

  function clearClip(trackIndex: number): void {
    slots[trackIndex].clear()
  }

  function hasClip(trackIndex: number): boolean {
    return slots[trackIndex].hasClip()
  }

  function isLoading(trackIndex: number): boolean {
    return slots[trackIndex].isLoading()
  }

  function setPreviewSource(trackIndex: number, stream: MediaStream | null): void {
    slots[trackIndex].setPreviewSource(stream)
  }

  // Start render loop
  startRenderLoop()

  // Cleanup
  onCleanup(destroy)

  return {
    // Canvas
    canvas: compositor.canvas,
    compositor,
    clock,
    preRenderer,

    // State (reactive)
    isPlaying: clock.isPlaying,
    time: clock.time,
    loop: clock.loop,
    maxDuration,

    // Actions
    play,
    pause,
    stop,
    seek,
    setLoop: clock.setLoop,
    loadClip,
    clearClip,
    hasClip,
    isLoading,
    setPreviewSource,
    setVolume: (trackIndex, value) => slots[trackIndex].setVolume(value),
    setPan: (trackIndex, value) => slots[trackIndex].setPan(value),
    destroy,

    // Utilities
    getSlot: trackIndex => slots[trackIndex],
    logPerf: () => perf.logSummary(),
    resetPerf: () => perf.reset(),
  }
}
