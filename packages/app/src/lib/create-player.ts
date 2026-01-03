import type { Demuxer } from '@eddy/codecs'
import { createAudioPipeline, type AudioPipeline } from '@eddy/mixer'
import { createPlayback, type Playback } from '@eddy/playback'
import { debug, getGlobalPerfMonitor } from '@eddy/utils'
import { createCompositorWorkerWrapper, createDemuxerWorker } from '~/workers'

const log = debug('player', true)
const perf = getGlobalPerfMonitor()

export interface TrackSlot {
  playback: Playback | null
  demuxer: Demuxer | null
  audioPipeline: AudioPipeline
}

export interface Player {
  /** The canvas element for rendering */
  readonly canvas: HTMLCanvasElement

  /** Get track slot info */
  getSlot(trackIndex: number): TrackSlot

  /** Check if a track has a clip loaded */
  hasClip(trackIndex: number): boolean

  /** Load a clip from blob into a track */
  loadClip(trackIndex: number, blob: Blob): Promise<void>

  /** Clear a clip from a track */
  clearClip(trackIndex: number): void

  /** Set a preview stream for a track (for camera preview) */
  setPreviewSource(trackIndex: number, stream: MediaStream | null): void

  /** Start playback from time (affects all tracks with clips) */
  play(time?: number): Promise<void>

  /** Pause playback */
  pause(): void

  /** Stop and seek to beginning (shows first frames) */
  stop(): Promise<void>

  /** Seek all tracks to time */
  seek(time: number): Promise<void>

  /** Set volume for a track (0-1) */
  setVolume(trackIndex: number, value: number): void

  /** Set pan for a track (-1 to 1) */
  setPan(trackIndex: number, value: number): void

  /** Whether currently playing */
  readonly isPlaying: boolean

  /** Current playback time */
  readonly currentTime: number

  /** Whether loop is enabled */
  loop: boolean

  /** Get max duration across all loaded clips */
  readonly maxDuration: number

  /** Log performance summary to console */
  logPerf(): void

  /** Reset performance counters */
  resetPerf(): void

  /** Clean up all resources */
  destroy(): void
}

const NUM_TRACKS = 4

// Expose perf monitor globally for console debugging
if (typeof window !== 'undefined') {
  ;(window as any).eddy = { perf }
}

/**
 * Create a player that manages compositor, playbacks, and audio pipelines
 * Owns the single render loop and master clock
 */
export async function createPlayer(width: number, height: number): Promise<Player> {
  log('createPlayer', { width, height })

  // Create compositor in worker
  const compositor = await createCompositorWorkerWrapper(width, height)

  // Create slots with audio pipelines (pipelines are created once, playbacks are per-clip)
  const slots: TrackSlot[] = Array.from({ length: NUM_TRACKS }, () => ({
    playback: null,
    demuxer: null,
    audioPipeline: createAudioPipeline(),
  }))

  // Render loop state
  let animationFrameId: number | null = null

  // Master clock state
  let isPlaying = false
  let clockTime = 0
  let clockStartTime = 0 // performance.now() when playback started
  let clockStartPosition = 0 // clockTime when playback started
  let loop = false

  // Track last sent frame timestamp per track to avoid redundant transfers
  // With LRU cache, getFrame() returns clones - we compare by timestamp
  const lastSentTimestamp: (number | null)[] = [null, null, null, null]

  /**
   * Calculate current clock time
   */
  function getCurrentClockTime(): number {
    if (isPlaying) {
      const elapsed = (performance.now() - clockStartTime) / 1000
      return clockStartPosition + elapsed
    }
    return clockTime
  }

  /**
   * Get max duration across all loaded clips
   */
  function getMaxDuration(): number {
    let max = 0
    for (const slot of slots) {
      if (slot.playback) {
        max = Math.max(max, slot.playback.duration)
      }
    }
    return max
  }

  /**
   * Single render loop - drives everything
   */
  function renderLoop() {
    perf.start('renderLoop')

    let time = getCurrentClockTime()

    // Check for loop
    if (isPlaying && loop) {
      const maxDuration = getMaxDuration()
      if (maxDuration > 0 && time >= maxDuration) {
        // Loop back to start
        log('loop: restarting from 0')
        clockStartPosition = 0
        clockStartTime = performance.now()
        time = 0

        // Reset frame tracking
        for (let i = 0; i < NUM_TRACKS; i++) {
          lastSentTimestamp[i] = null
        }

        // Reset all playbacks for loop
        for (const slot of slots) {
          if (slot.playback) {
            slot.playback.resetForLoop(0)
          }
        }
      }
    }

    // Update compositor with frames from all playbacks
    perf.start('getFrames')
    for (let i = 0; i < NUM_TRACKS; i++) {
      const { playback } = slots[i]
      if (playback) {
        // Use tick() when playing, getFrameAt() when static
        // Note: With LRU cache, each call returns a NEW clone
        perf.start(`tick-${i}`)
        const frame = isPlaying ? playback.tick(time) : playback.getFrameAt(time)
        perf.end(`tick-${i}`)

        // Handle null frames (cache miss or no playback)
        if (!frame) {
          if (lastSentTimestamp[i] !== null) {
            lastSentTimestamp[i] = null
            compositor.setFrame(i, null)
            perf.increment(`frame-miss-${i}`)
          }
          continue
        }

        // Compare by timestamp to detect same frame
        const frameTimestamp = frame.timestamp

        if (frameTimestamp === lastSentTimestamp[i]) {
          // Same frame as before - close the clone, don't send
          frame.close()
          perf.increment('frame-reused')
          continue
        }

        // New frame - transfer to compositor and update tracking
        lastSentTimestamp[i] = frameTimestamp
        perf.start(`setFrame-${i}`)
        compositor.setFrame(i, frame)
        perf.end(`setFrame-${i}`)
        perf.increment('frame-sent')
      }
    }
    perf.end('getFrames')

    // Render the compositor
    perf.start('compositor.render')
    compositor.render()
    perf.end('compositor.render')

    // Update stored clock time
    clockTime = time

    perf.end('renderLoop')

    // Schedule next frame
    animationFrameId = requestAnimationFrame(renderLoop)
  }

  function startRenderLoop() {
    if (animationFrameId !== null) return
    log('startRenderLoop')
    animationFrameId = requestAnimationFrame(renderLoop)
  }

  function stopRenderLoop() {
    log('stopRenderLoop')
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }

  // Start render loop immediately
  startRenderLoop()

  return {
    get canvas() {
      return compositor.canvas
    },

    get isPlaying() {
      return isPlaying
    },

    get currentTime() {
      return getCurrentClockTime()
    },

    get loop() {
      return loop
    },

    set loop(value: boolean) {
      loop = value
    },

    get maxDuration() {
      return getMaxDuration()
    },

    getSlot(trackIndex: number): TrackSlot {
      return slots[trackIndex]
    },

    hasClip(trackIndex: number): boolean {
      return slots[trackIndex].playback !== null
    },

    async loadClip(trackIndex: number, blob: Blob): Promise<void> {
      log('loadClip start', { trackIndex, blobSize: blob.size })
      const slot = slots[trackIndex]

      // Clean up existing playback
      if (slot.playback) {
        log('loadClip: destroying existing playback', { trackIndex })
        slot.playback.destroy()
        slot.playback = null
      }
      if (slot.demuxer) {
        slot.demuxer.destroy()
        slot.demuxer = null
      }

      // Create new demuxer and playback (demuxing runs in worker)
      const demuxer = await createDemuxerWorker(blob)
      const playback = await createPlayback(demuxer, {
        audioDestination: slot.audioPipeline.gain,
      })

      slot.demuxer = demuxer
      slot.playback = playback

      // Buffer first frame for display
      log('loadClip: seeking to 0 to buffer first frame', { trackIndex })
      await playback.seek(0)
      log('loadClip complete', { trackIndex })
    },

    clearClip(trackIndex: number): void {
      const slot = slots[trackIndex]

      if (slot.playback) {
        slot.playback.destroy()
        slot.playback = null
      }
      if (slot.demuxer) {
        slot.demuxer.destroy()
        slot.demuxer = null
      }

      // Reset frame tracking and clear compositor
      lastSentTimestamp[trackIndex] = null
      compositor.setFrame(trackIndex, null)
    },

    setPreviewSource(trackIndex: number, stream: MediaStream | null): void {
      compositor.setPreviewStream(trackIndex, stream)
    },

    async play(time?: number): Promise<void> {
      const startTime = time ?? clockTime
      log('play', { startTime, numPlaybacks: slots.filter(s => s.playback).length })

      // Prepare all playbacks
      const preparePromises: Promise<void>[] = []
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.playback) {
          log('play: preparing playback', { trackIndex: i })
          preparePromises.push(slot.playback.prepareToPlay(startTime))
        }
      }
      await Promise.all(preparePromises)

      // Start audio on all playbacks
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.playback) {
          slot.playback.startAudio(startTime)
        }
      }

      // Start the clock
      clockStartPosition = startTime
      clockStartTime = performance.now()
      isPlaying = true

      log('play complete')
    },

    pause(): void {
      log('pause', { isPlaying })
      if (!isPlaying) return

      // Save current clock time
      clockTime = getCurrentClockTime()

      // Pause all playbacks
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.playback) {
          slot.playback.pause()
        }
      }

      isPlaying = false
      log('pause complete', { clockTime })
    },

    async stop(): Promise<void> {
      log('stop')
      isPlaying = false
      clockTime = 0
      clockStartPosition = 0

      // Stop all playbacks
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.playback) {
          slot.playback.stop()
        }
      }

      // Seek all to 0 to buffer first frames
      const seekPromises: Promise<void>[] = []
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.playback) {
          seekPromises.push(slot.playback.seek(0))
        }
        // Reset frame tracking - new frames after seek
        lastSentTimestamp[i] = null
      }
      await Promise.all(seekPromises)

      log('stop complete')
    },

    async seek(time: number): Promise<void> {
      log('seek', { time, isPlaying })
      const wasPlaying = isPlaying

      // Pause during seek
      if (isPlaying) {
        isPlaying = false
      }

      clockTime = time
      clockStartPosition = time

      // Seek all playbacks
      const seekPromises: Promise<void>[] = []
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.playback) {
          seekPromises.push(slot.playback.seek(time))
        }
        // Reset frame tracking - new frames after seek
        lastSentTimestamp[i] = null
      }
      await Promise.all(seekPromises)

      // Resume if was playing
      if (wasPlaying) {
        clockStartTime = performance.now()
        isPlaying = true
      }

      log('seek complete', { isPlaying })
    },

    setVolume(trackIndex: number, value: number): void {
      slots[trackIndex].audioPipeline.setVolume(value)
    },

    setPan(trackIndex: number, value: number): void {
      slots[trackIndex].audioPipeline.setPan(value)
    },

    logPerf(): void {
      perf.logSummary()
    },

    resetPerf(): void {
      perf.reset()
    },

    destroy(): void {
      stopRenderLoop()

      for (let i = 0; i < NUM_TRACKS; i++) {
        const slot = slots[i]
        if (slot.playback) {
          slot.playback.destroy()
        }
        if (slot.demuxer) {
          slot.demuxer.destroy()
        }
        slot.audioPipeline.disconnect()
      }

      compositor.destroy()
    },
  }
}
