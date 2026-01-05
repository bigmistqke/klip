import { $MESSENGER, rpc, transfer, type RPC } from '@bigmistqke/rpc/messenger'
import { debug, getGlobalPerfMonitor } from '@eddy/utils'
import { createMemo, type Accessor } from 'solid-js'
import type { CompositorWorkerMethods } from '~/workers/compositor.worker'
import CompositorWorker from '~/workers/compositor.worker?worker'
import { createClock, type Clock } from './create-clock'
import { createSlot, type Slot } from './create-slot'

type CompositorRPC = RPC<CompositorWorkerMethods>

const log = debug('player', false)
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

export type Compositor = Omit<CompositorRPC, 'init' | 'setPreviewStream'> & {
  canvas: HTMLCanvasElement
  /** Takes MediaStream (converted to ReadableStream internally) */
  setPreviewStream(index: number, stream: MediaStream | null): void
}

export interface Player extends PlayerState, PlayerActions {
  /** The canvas element */
  canvas: HTMLCanvasElement
  /** The compositor */
  compositor: Compositor
  /** Clock for time management */
  clock: Clock
  /** Get track slot */
  getSlot: (trackIndex: number) => Slot
  /** Performance logging */
  logPerf: () => void
  resetPerf: () => void
}

const NUM_TRACKS = 4

// Expose perf monitor globally for console debugging
if (typeof window !== 'undefined') {
  ;(window as any).eddy = { perf }
}

/**
 * Create a player that manages compositor, playbacks, and audio pipelines
 */
export async function createPlayer(
  canvasElement: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<Player> {
  log('createPlayer', { width, height })

  // Set canvas size and transfer to worker
  canvasElement.width = width
  canvasElement.height = height
  const offscreen = canvasElement.transferControlToOffscreen()

  // Create compositor worker
  const worker = rpc<CompositorWorkerMethods>(new CompositorWorker())
  await worker.init(transfer(offscreen) as unknown as OffscreenCanvas, width, height)

  // Track preview processors for cleanup
  const previewProcessors: (MediaStreamTrackProcessor<VideoFrame> | null)[] = [
    null,
    null,
    null,
    null,
  ]

  // Create compositor wrapper without mutating the RPC proxy
  const compositor: Compositor = {
    canvas: canvasElement,

    // Delegate to worker methods
    setFrame: worker.setFrame,
    setGrid: worker.setGrid,
    render: worker.render,
    setCaptureFrame: worker.setCaptureFrame,
    renderCapture: worker.renderCapture,
    captureFrame: worker.captureFrame,

    setPreviewStream(index: number, stream: MediaStream | null) {
      // Clean up existing processor
      previewProcessors[index] = null

      if (stream) {
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) {
          const processor = new MediaStreamTrackProcessor({ track: videoTrack })
          previewProcessors[index] = processor
          worker.setPreviewStream(
            index,
            transfer(processor.readable) as unknown as ReadableStream<VideoFrame>,
          )
        }
      } else {
        worker.setPreviewStream(index, null)
      }
    },

    async destroy() {
      for (let i = 0; i < 4; i++) {
        previewProcessors[i] = null
      }
      await worker.destroy()
      worker[$MESSENGER].terminate()
    },
  }

  // Create slots
  const slots = Array.from({ length: NUM_TRACKS }, (_, index) => createSlot({ index, compositor }))

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

  // Render loop state
  let animationFrameId: number | null = null

  /**
   * Single render loop - drives everything
   */
  function renderLoop() {
    perf.start('renderLoop')

    const time = clock.tick()
    const playing = clock.isPlaying()

    // Handle loop reset
    if (playing && clock.loop() && maxDuration() > 0 && time >= maxDuration()) {
      for (const slot of slots) {
        slot.resetForLoop(0)
      }
    }

    // Always use 2x2 grid mode
    compositor.setGrid(2, 2)

    perf.start('getFrames')
    for (const slot of slots) {
      slot.renderFrame(time, playing)
    }
    perf.end('getFrames')

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
    for (const slot of slots) {
      slot.destroy()
    }
    compositor.destroy()
  }

  // Start render loop
  startRenderLoop()

  return {
    // Canvas
    canvas: compositor.canvas,
    compositor,
    clock,

    // State (reactive)
    isPlaying: clock.isPlaying,
    time: clock.time,
    loop: clock.loop,
    maxDuration,

    // Actions
    async play(time?: number): Promise<void> {
      const startTime = time ?? clock.time()
      log('play', { startTime })

      // Prepare all playbacks
      await Promise.all(slots.map(slot => slot.prepareToPlay(startTime)))

      // Start audio
      for (const slot of slots) {
        slot.startAudio(startTime)
      }

      clock.play(startTime)
    },
    pause() {
      if (!clock.isPlaying()) return

      for (const slot of slots) {
        slot.pause()
      }

      clock.pause()
    },
    async stop(): Promise<void> {
      clock.stop()

      for (const slot of slots) {
        slot.stop()
      }

      // Seek to 0
      await Promise.all(slots.map(slot => slot.seek(0)))
    },
    async seek(time: number): Promise<void> {
      const wasPlaying = clock.isPlaying()

      if (wasPlaying) {
        clock.pause()
      }

      await Promise.all(slots.map(slot => slot.seek(time)))

      clock.seek(time)

      if (wasPlaying) {
        clock.play(time)
      }
    },
    setLoop: clock.setLoop,
    async loadClip(trackIndex: number, blob: Blob): Promise<void> {
      log('loadClip', { trackIndex, blobSize: blob.size })
      await slots[trackIndex].load(blob)
      log('loadClip complete', { trackIndex })
    },
    clearClip(trackIndex: number): void {
      slots[trackIndex].clear()
    },
    hasClip(trackIndex: number): boolean {
      return slots[trackIndex].hasClip()
    },
    isLoading(trackIndex: number): boolean {
      return slots[trackIndex].isLoading()
    },
    setPreviewSource(trackIndex: number, stream: MediaStream | null): void {
      slots[trackIndex].setPreviewSource(stream)
    },
    setVolume: (trackIndex, value) => slots[trackIndex].setVolume(value),
    setPan: (trackIndex, value) => slots[trackIndex].setPan(value),
    destroy,

    // Utilities
    getSlot: trackIndex => slots[trackIndex],
    logPerf: () => perf.logSummary(),
    resetPerf: () => perf.reset(),
  }
}
