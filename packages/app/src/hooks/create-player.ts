import { $MESSENGER, rpc, transfer, type RPC } from '@bigmistqke/rpc/messenger'
import type { Project } from '@eddy/lexicons'
import { createAudioPipeline, type AudioPipeline } from '@eddy/mixer'
import { debug, getGlobalPerfMonitor } from '@eddy/utils'
import { createEffect, createMemo, createSignal, on, type Accessor } from 'solid-js'
import type { LayoutTimeline } from '~/lib/layout-types'
import { compileLayoutTimeline } from '~/lib/layout-resolver'
import type { CompositorWorkerMethods } from '~/workers/compositor.worker'
import CompositorWorker from '~/workers/compositor.worker?worker'
import type { PlaybackWorkerMethods } from '~/workers/playback.worker'
import PlaybackWorker from '~/workers/playback.worker?worker'
import { createClock, type Clock } from './create-clock'

type CompositorRPC = RPC<CompositorWorkerMethods>
type PlaybackRPC = RPC<PlaybackWorkerMethods>

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
  loadClip: (trackId: string, blob: Blob) => Promise<void>
  /** Clear a clip from a track */
  clearClip: (trackId: string) => void
  /** Check if track has a clip */
  hasClip: (trackId: string) => boolean
  /** Check if track is currently loading a clip */
  isLoading: (trackId: string) => boolean
  /** Set preview stream for recording */
  setPreviewSource: (trackId: string, stream: MediaStream | null) => void
  /** Set track volume */
  setVolume: (trackId: string, value: number) => void
  /** Set track pan */
  setPan: (trackId: string, value: number) => void
  /** Clean up all resources */
  destroy: () => void
}

export type Compositor = Omit<CompositorRPC, 'init' | 'setPreviewStream'> & {
  canvas: HTMLCanvasElement
  /** Takes MediaStream (converted to ReadableStream internally) */
  setPreviewStream(trackId: string, stream: MediaStream | null): void
}

export interface Player extends PlayerState, PlayerActions {
  /** The canvas element */
  canvas: HTMLCanvasElement
  /** The compositor */
  compositor: Compositor
  /** Clock for time management */
  clock: Clock
  /** Current layout timeline (reactive) */
  timeline: Accessor<LayoutTimeline>
  /** Get audio pipeline by trackId */
  getAudioPipeline: (trackId: string) => AudioPipeline | undefined
  /** Performance logging */
  logPerf: () => void
  resetPerf: () => void
}

// Expose perf monitor globally for console debugging
if (typeof window !== 'undefined') {
  ;(window as any).eddy = { perf }
}

export interface CreatePlayerOptions {
  canvas: HTMLCanvasElement
  width: number
  height: number
  project: Accessor<Project>
}

/** Track entry for managing playback workers */
interface TrackEntry {
  trackId: string
  worker: Worker
  rpc: PlaybackRPC
  audioPipeline: AudioPipeline
  duration: number
  state: 'idle' | 'loading' | 'ready' | 'playing' | 'paused'
}

/**
 * Create a player that manages compositor, playback workers, and audio pipelines.
 * Uses direct worker-to-worker frame transfer for video.
 */
export async function createPlayer(options: CreatePlayerOptions): Promise<Player> {
  const { canvas: canvasElement, width, height, project } = options
  log('createPlayer', { width, height })

  // Set canvas size and transfer to worker
  canvasElement.width = width
  canvasElement.height = height
  const offscreen = canvasElement.transferControlToOffscreen()

  // Create compositor worker
  const compositorWorker = new CompositorWorker()
  const compositorRpc = rpc<CompositorWorkerMethods>(compositorWorker)
  await compositorRpc.init(transfer(offscreen) as unknown as OffscreenCanvas, width, height)

  // Track preview processors for cleanup
  const previewProcessors = new Map<string, MediaStreamTrackProcessor<VideoFrame>>()

  // Create compositor wrapper
  const compositor: Compositor = {
    canvas: canvasElement,

    // Delegate to worker methods
    setTimeline: compositorRpc.setTimeline,
    setFrame: compositorRpc.setFrame,
    render: compositorRpc.render,
    connectPlaybackWorker: compositorRpc.connectPlaybackWorker,
    disconnectPlaybackWorker: compositorRpc.disconnectPlaybackWorker,
    setCaptureFrame: compositorRpc.setCaptureFrame,
    renderCapture: compositorRpc.renderCapture,
    captureFrame: compositorRpc.captureFrame,

    setPreviewStream(trackId: string, stream: MediaStream | null) {
      // Clean up existing processor
      previewProcessors.delete(trackId)

      if (stream) {
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) {
          const processor = new MediaStreamTrackProcessor({ track: videoTrack })
          previewProcessors.set(trackId, processor)
          compositorRpc.setPreviewStream(
            trackId,
            transfer(processor.readable) as unknown as ReadableStream<VideoFrame>,
          )
        }
      } else {
        compositorRpc.setPreviewStream(trackId, null)
      }
    },

    async destroy() {
      previewProcessors.clear()
      await compositorRpc.destroy()
      compositorWorker.terminate()
    },
  }

  // Compile layout timeline from project (reactive)
  const timeline = createMemo(() => {
    const currentProject = project()
    return compileLayoutTimeline(currentProject, { width, height })
  })

  // Track entries - keyed by trackId
  const tracks = new Map<string, TrackEntry>()

  // Reactive signal for track count changes (triggers maxDuration recalc)
  const [trackVersion, setTrackVersion] = createSignal(0)

  /** Get or create a track entry */
  function getOrCreateTrack(trackId: string): TrackEntry {
    let track = tracks.get(trackId)
    if (!track) {
      log('creating track entry', { trackId })

      // Create playback worker
      const worker = new PlaybackWorker()
      const playbackRpc = rpc<PlaybackWorkerMethods>(worker)

      // Create audio pipeline
      const audioPipeline = createAudioPipeline()

      // Create MessageChannel for worker-to-worker communication
      const channel = new MessageChannel()

      // Send port1 to compositor (compositor listens)
      compositorRpc.connectPlaybackWorker(
        trackId,
        transfer(channel.port1) as unknown as MessagePort,
      )

      // Send port2 to playback worker (playback worker sends)
      playbackRpc.connectToCompositor(transfer(channel.port2) as unknown as MessagePort, trackId)

      track = {
        trackId,
        worker,
        rpc: playbackRpc,
        audioPipeline,
        duration: 0,
        state: 'idle',
      }
      tracks.set(trackId, track)
      setTrackVersion(v => v + 1)
    }
    return track
  }

  /** Remove a track entry */
  function removeTrack(trackId: string): void {
    const track = tracks.get(trackId)
    if (!track) return

    log('removing track entry', { trackId })

    // Disconnect from compositor
    compositorRpc.disconnectPlaybackWorker(trackId)

    // Destroy playback worker
    track.rpc.destroy()
    track.worker.terminate()

    // Disconnect audio pipeline
    track.audioPipeline.disconnect()

    tracks.delete(trackId)
    setTrackVersion(v => v + 1)
  }

  // Sync timeline with compositor when project changes
  createEffect(
    on(timeline, currentTimeline => {
      compositor.setTimeline(currentTimeline)
    }),
  )

  // Derived max duration from timeline or playback workers
  const maxDuration = createMemo(() => {
    // Track version to trigger recalc when tracks change
    trackVersion()

    // First check timeline duration
    const timelineDuration = timeline().duration
    if (timelineDuration > 0) return timelineDuration

    // Fall back to playback durations
    let max = 0
    for (const track of tracks.values()) {
      max = Math.max(max, track.duration)
    }
    return max
  })

  // Create clock for time management
  const clock = createClock({ duration: maxDuration })

  // Render loop state
  let animationFrameId: number | null = null

  /**
   * Render loop - drives compositor rendering and handles looping.
   * Video frames are streamed directly from playback workers to compositor.
   */
  function renderLoop() {
    perf.start('renderLoop')

    const time = clock.tick()
    const playing = clock.isPlaying()

    // Handle loop reset
    if (playing && clock.loop() && maxDuration() > 0 && time >= maxDuration()) {
      log('loop reset')
      // Reset all playback workers to start
      for (const track of tracks.values()) {
        if (track.state === 'playing') {
          track.rpc.seek(0).then(() => {
            track.rpc.play(0)
          })
        }
      }
    }

    // Render compositor at current time
    compositor.render(time)

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

    // Remove all tracks
    for (const trackId of tracks.keys()) {
      removeTrack(trackId)
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
    timeline,

    // State (reactive)
    isPlaying: clock.isPlaying,
    time: clock.time,
    loop: clock.loop,
    maxDuration,

    // Actions
    async play(time?: number): Promise<void> {
      const startTime = time ?? clock.time()
      log('play', { startTime })

      // Wait for any loading tracks to finish (with timeout)
      const loadingTracks = Array.from(tracks.values()).filter(track => track.state === 'loading')
      if (loadingTracks.length > 0) {
        log('waiting for loading tracks', { count: loadingTracks.length })
        // Poll for loading completion with timeout
        const maxWait = 5000
        const startWait = performance.now()
        while (loadingTracks.some(t => t.state === 'loading')) {
          if (performance.now() - startWait > maxWait) {
            log('timeout waiting for tracks to load')
            break
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }

      // Seek all tracks to start time first
      const tracksWithClips = Array.from(tracks.values()).filter(
        track => track.state === 'ready' || track.state === 'paused',
      )

      log('play: tracks ready', { count: tracksWithClips.length })

      await Promise.all(tracksWithClips.map(track => track.rpc.seek(startTime)))

      // Start all playback workers
      for (const track of tracksWithClips) {
        track.rpc.play(startTime)
        track.state = 'playing'
      }

      clock.play(startTime)
    },

    pause() {
      if (!clock.isPlaying()) return
      log('pause')

      // Pause all playback workers
      for (const track of tracks.values()) {
        if (track.state === 'playing') {
          track.rpc.pause()
          track.state = 'paused'
        }
      }

      clock.pause()
    },

    async stop(): Promise<void> {
      log('stop')
      clock.stop()

      // Pause and seek all playback workers to 0
      for (const track of tracks.values()) {
        if (track.state === 'playing') {
          track.rpc.pause()
        }
        if (track.state !== 'idle' && track.state !== 'loading') {
          await track.rpc.seek(0)
          track.state = 'ready'
        }
      }
    },

    async seek(time: number): Promise<void> {
      log('seek', { time })
      const wasPlaying = clock.isPlaying()

      if (wasPlaying) {
        clock.pause()
        // Pause all playback workers
        for (const track of tracks.values()) {
          if (track.state === 'playing') {
            track.rpc.pause()
            track.state = 'paused'
          }
        }
      }

      // Seek all tracks in parallel
      await Promise.all(
        Array.from(tracks.values())
          .filter(track => track.state !== 'idle' && track.state !== 'loading')
          .map(track => track.rpc.seek(time)),
      )

      clock.seek(time)

      if (wasPlaying) {
        // Resume playback
        for (const track of tracks.values()) {
          if (track.state === 'paused') {
            track.rpc.play(time)
            track.state = 'playing'
          }
        }
        clock.play(time)
      }
    },

    setLoop: clock.setLoop,

    async loadClip(trackId: string, blob: Blob): Promise<void> {
      log('loadClip', { trackId, blobSize: blob.size })

      const track = getOrCreateTrack(trackId)
      track.state = 'loading'

      // Convert blob to ArrayBuffer and send to worker
      const buffer = await blob.arrayBuffer()
      const { duration } = await track.rpc.load(buffer)

      track.duration = duration
      track.state = 'ready'

      // Seek to current time (or 0) to show initial frame
      const currentTime = clock.time()
      await track.rpc.seek(currentTime)

      // Trigger duration recalc
      setTrackVersion(v => v + 1)

      log('loadClip complete', { trackId, duration })
    },

    clearClip(trackId: string): void {
      log('clearClip', { trackId })
      removeTrack(trackId)
    },

    hasClip(trackId: string): boolean {
      // Subscribe to trackVersion for reactivity
      trackVersion()
      const track = tracks.get(trackId)
      return track?.state === 'ready' || track?.state === 'playing' || track?.state === 'paused'
    },

    isLoading(trackId: string): boolean {
      // Subscribe to trackVersion for reactivity
      trackVersion()
      return tracks.get(trackId)?.state === 'loading'
    },

    setPreviewSource(trackId: string, stream: MediaStream | null): void {
      compositor.setPreviewStream(trackId, stream)
    },

    setVolume(trackId: string, value: number): void {
      tracks.get(trackId)?.audioPipeline.setVolume(value)
    },

    setPan(trackId: string, value: number): void {
      tracks.get(trackId)?.audioPipeline.setPan(value)
    },

    destroy,

    // Utilities
    getAudioPipeline: (trackId: string) => tracks.get(trackId)?.audioPipeline,
    logPerf: () => perf.logSummary(),
    resetPerf: () => perf.reset(),
  }
}
