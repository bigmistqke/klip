import type { Demuxer } from '@eddy/codecs'
import { createAudioPipeline, type AudioPipeline } from '@eddy/mixer'
import { createPlayback, type Playback } from '@eddy/playback'
import { debug, getGlobalPerfMonitor } from '@eddy/utils'
import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { createCompositorWorkerWrapper, createDemuxerWorker } from '~/workers'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'
import { createClock, type Clock } from './create-clock'
import { createPreRenderer, type PreRenderer } from './create-pre-renderer'

const log = debug('player', true)
const perf = getGlobalPerfMonitor()

export interface TrackSlot {
  playback: Playback | null
  demuxer: Demuxer | null
  audioPipeline: AudioPipeline
}

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
  getSlot: (trackIndex: number) => TrackSlot
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

  // Create clock for time management
  const clock = createClock()

  // Create pre-renderer hook
  const preRenderer = createPreRenderer()

  // Create reactive slots store
  const [slots, setSlots] = createStore<TrackSlot[]>(
    Array.from({ length: NUM_TRACKS }, () => ({
      playback: null,
      demuxer: null,
      audioPipeline: createAudioPipeline(),
    })),
  )

  // Reactive state
  const [maxDuration, setMaxDuration] = createSignal(0)

  // Render loop state
  let animationFrameId: number | null = null

  // Track preview state
  const previewActive: boolean[] = [false, false, false, false]

  // Frame tracking for optimization
  const lastSentTimestamp: (number | null)[] = [null, null, null, null]
  let lastPreRenderTimestamp: number | null = null

  // Compute max duration from slots
  function updateMaxDuration() {
    let max = 0
    for (const slot of slots) {
      if (slot.playback) {
        max = Math.max(max, slot.playback.duration)
      }
    }
    setMaxDuration(max)
    clock.setDuration(max)
  }

  /**
   * Single render loop - drives everything
   */
  function renderLoop() {
    perf.start('renderLoop')

    const time = clock.tick()
    const playing = clock.isPlaying()
    const preRenderedPlayback = preRenderer.playback()

    // Handle loop reset
    if (playing && clock.loop() && maxDuration() > 0 && time >= maxDuration()) {
      // Reset frame tracking
      for (let i = 0; i < NUM_TRACKS; i++) {
        lastSentTimestamp[i] = null
      }
      lastPreRenderTimestamp = null

      // Reset all playbacks for loop
      for (const slot of slots) {
        if (slot.playback) {
          slot.playback.resetForLoop(0)
        }
      }
      if (preRenderedPlayback) {
        preRenderedPlayback.resetForLoop(0)
      }
    }

    // Tick individual playbacks for audio when using pre-render for video
    if (preRenderedPlayback && playing) {
      for (let i = 0; i < NUM_TRACKS; i++) {
        slots[i].playback?.tick(time, false) // audio only
      }
    }

    // Use pre-rendered video if available
    if (preRenderedPlayback) {
      perf.start('getPreRenderFrame')

      if (playing) {
        preRenderedPlayback.tick(time)
      }

      const frameTimestamp = preRenderedPlayback.getFrameTimestamp(time)

      if (frameTimestamp !== null && frameTimestamp !== lastPreRenderTimestamp) {
        const frame = preRenderedPlayback.getFrameAt(time)
        if (frame) {
          compositor.setGrid(1, 1)
          compositor.setFrame(0, frame)
          lastPreRenderTimestamp = frameTimestamp
          perf.increment('prerender-frame-sent')
        }
      }

      perf.end('getPreRenderFrame')
    } else {
      // No pre-render: use 2x2 grid mode
      compositor.setGrid(2, 2)

      perf.start('getFrames')
      for (let i = 0; i < NUM_TRACKS; i++) {
        const { playback } = slots[i]
        if (playback) {
          if (playing) {
            playback.tick(time)
          }

          const frameTimestamp = playback.getFrameTimestamp(time)

          if (frameTimestamp === null) {
            if (lastSentTimestamp[i] !== null) {
              lastSentTimestamp[i] = null
              compositor.setFrame(i, null)
            }
            continue
          }

          if (frameTimestamp === lastSentTimestamp[i]) {
            continue
          }

          const frame = playback.getFrameAt(time)
          if (frame) {
            lastSentTimestamp[i] = frameTimestamp
            compositor.setFrame(i, frame)
          }
        }
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

  // Start render loop
  startRenderLoop()

  // Cleanup
  onCleanup(() => {
    destroy()
  })

  async function play(time?: number): Promise<void> {
    const startTime = time ?? clock.time()
    log('play', { startTime })

    // Prepare all playbacks
    const preparePromises: Promise<void>[] = []
    for (const slot of slots) {
      if (slot.playback) {
        preparePromises.push(slot.playback.prepareToPlay(startTime))
      }
    }
    const preRenderedPlayback = preRenderer.playback()
    if (preRenderedPlayback) {
      preparePromises.push(preRenderedPlayback.prepareToPlay(startTime))
    }
    await Promise.all(preparePromises)

    // Start audio
    for (const slot of slots) {
      if (slot.playback) {
        slot.playback.startAudio(startTime)
      }
    }

    clock.play(startTime)
  }

  function pause() {
    if (!clock.isPlaying()) return

    for (const slot of slots) {
      slot.playback?.pause()
    }

    clock.pause()
  }

  async function stop(): Promise<void> {
    clock.stop()

    for (const slot of slots) {
      slot.playback?.stop()
    }

    // Seek to 0
    const seekPromises: Promise<void>[] = []
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      if (slot.playback) {
        seekPromises.push(slot.playback.seek(0))
      }
      lastSentTimestamp[i] = null
    }
    await Promise.all(seekPromises)
  }

  async function seek(time: number): Promise<void> {
    const wasPlaying = clock.isPlaying()

    if (wasPlaying) {
      clock.pause()
    }

    const seekPromises: Promise<void>[] = []
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      if (slot.playback) {
        seekPromises.push(slot.playback.seek(time))
      }
      lastSentTimestamp[i] = null
    }
    await Promise.all(seekPromises)

    clock.seek(time)

    if (wasPlaying) {
      clock.play(time)
    }
  }

  async function loadClip(trackIndex: number, blob: Blob): Promise<void> {
    log('loadClip', { trackIndex, blobSize: blob.size })
    const slot = slots[trackIndex]

    // Clean up existing
    if (slot.playback) {
      slot.playback.destroy()
    }
    if (slot.demuxer) {
      slot.demuxer.destroy()
    }

    // Create new playback
    const demuxer = await createDemuxerWorker(blob)
    const playback = await createPlayback(demuxer, {
      audioDestination: slot.audioPipeline.gain,
    })

    await playback.seek(0)

    // Update store reactively
    setSlots(trackIndex, { demuxer, playback })
    updateMaxDuration()

    log('loadClip complete', { trackIndex })
  }

  function clearClip(trackIndex: number): void {
    const slot = slots[trackIndex]

    if (slot.playback) {
      slot.playback.destroy()
    }
    if (slot.demuxer) {
      slot.demuxer.destroy()
    }

    lastSentTimestamp[trackIndex] = null
    compositor.setFrame(trackIndex, null)

    // Update store reactively
    setSlots(trackIndex, { demuxer: null, playback: null })
    updateMaxDuration()
  }

  function hasClip(trackIndex: number): boolean {
    return slots[trackIndex].playback !== null
  }

  function setPreviewSource(trackIndex: number, stream: MediaStream | null): void {
    previewActive[trackIndex] = stream !== null
    compositor.setPreviewStream(trackIndex, stream)
  }

  function destroy(): void {
    stopRenderLoop()

    preRenderer.cancel()

    for (const slot of slots) {
      if (slot.playback) {
        slot.playback.destroy()
      }
      if (slot.demuxer) {
        slot.demuxer.destroy()
      }
      slot.audioPipeline.disconnect()
    }

    compositor.destroy()
  }

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
    setPreviewSource,
    setVolume: (trackIndex, value) => slots[trackIndex].audioPipeline.setVolume(value),
    setPan: (trackIndex, value) => slots[trackIndex].audioPipeline.setPan(value),
    destroy,

    // Utilities
    getSlot: trackIndex => slots[trackIndex],
    logPerf: () => perf.logSummary(),
    resetPerf: () => perf.reset(),
  }
}
