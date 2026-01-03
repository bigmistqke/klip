import type { DemuxedSample, Demuxer, VideoTrackInfo } from '@eddy/codecs'
import { createVideoDecoder } from '@eddy/codecs'
import { debug, getGlobalPerfMonitor } from '@eddy/utils'
import { type FrameCache, getSharedFrameCache } from './frame-cache'

const perf = getGlobalPerfMonitor()

/** A decoded frame with timing information */
export interface BufferedFrame {
  /** The decoded VideoFrame (this is a CLONE - caller should close when done) */
  frame: VideoFrame
  /** Presentation timestamp in seconds */
  pts: number
  /** Duration in seconds */
  duration: number
}

/** Frame buffer state */
export type FrameBufferState = 'idle' | 'buffering' | 'ready' | 'ended'

export interface FrameBufferOptions {
  /** How many seconds to buffer ahead of current position (default: 2) */
  bufferAhead?: number
  /** Maximum frames to keep in local tracking (default: 60) */
  maxFrames?: number
  /** Shared frame cache (uses global singleton if not provided) */
  cache?: FrameCache
}

export interface FrameBuffer {
  /** Current buffer state */
  readonly state: FrameBufferState

  /** Start time of buffered content in seconds */
  readonly bufferStart: number

  /** End time of buffered content in seconds */
  readonly bufferEnd: number

  /** Number of frames currently buffered */
  readonly frameCount: number

  /** Track info for this buffer */
  readonly trackInfo: VideoTrackInfo

  /**
   * Get the frame at or just before the given time
   * @param time - Time in seconds
   * @returns The frame at the given time, or null if not buffered
   */
  getFrame(time: number): BufferedFrame | null

  /**
   * Start buffering from a given time
   * This will clear the current buffer and start fresh from the nearest keyframe
   * @param time - Time in seconds to start buffering from
   */
  seekTo(time: number): Promise<void>

  /**
   * Buffer more frames ahead
   * Call this periodically during playback to keep the buffer filled
   */
  bufferMore(): Promise<void>

  /**
   * Check if the buffer has content at the given time
   * @param time - Time in seconds
   */
  isBufferedAt(time: number): boolean

  /**
   * Clear all buffered frames
   */
  clear(): void

  /**
   * Clean up resources
   */
  destroy(): void
}

let frameBufferIdCounter = 0

/**
 * Create a frame buffer for a video track
 */
export async function createFrameBuffer(
  demuxer: Demuxer,
  trackInfo: VideoTrackInfo,
  options: FrameBufferOptions = {},
): Promise<FrameBuffer> {
  const bufferId = frameBufferIdCounter++
  const log = debug(`frame-buffer-${bufferId}`, true)
  log('createFrameBuffer', { trackId: trackInfo.id, duration: trackInfo.duration })

  const bufferAhead = options.bufferAhead ?? 2
  const maxLocalEntries = options.maxFrames ?? 60

  // Use provided cache or global singleton
  const cache = options.cache ?? getSharedFrameCache()

  // Create the decoder (may need to recreate if it closes unexpectedly)
  let decoder = await createVideoDecoder(demuxer, trackInfo)

  /** Recreate decoder if it was closed unexpectedly */
  const ensureDecoderOpen = async (): Promise<boolean> => {
    if ((decoder.decoder.state as string) !== 'closed') {
      return true
    }
    log('ensureDecoderOpen: decoder closed, recreating')
    try {
      decoder = await createVideoDecoder(demuxer, trackInfo)
      decoderReady = false
      return true
    } catch (err) {
      log('ensureDecoderOpen: failed to recreate decoder', { error: err })
      return false
    }
  }

  // Track which PTS values we have buffered (sorted by PTS)
  // We store { pts, duration } - the actual frames are in the shared cache
  let bufferedPts: Array<{ pts: number; duration: number }> = []

  // Track last getFrame call for logging
  let getFrameCallCount = 0
  let lastLoggedPts = -1

  // Current buffer position (where we last decoded up to)
  let bufferPosition = 0

  // Whether decoder is in a valid state (has received a keyframe)
  let decoderReady = false

  // Whether the buffer has been destroyed
  let destroyed = false

  // State
  let state: FrameBufferState = 'idle'

  // Lock to prevent concurrent buffering operations
  let isBuffering = false

  // Track duration for end detection (use 1 hour fallback for unknown duration from MediaRecorder)
  const trackDuration = trackInfo.duration > 0 ? trackInfo.duration : 3600

  /** Find the keyframe at or before the given time */
  const findKeyframeBefore = async (time: number): Promise<DemuxedSample | null> => {
    return demuxer.getKeyframeBefore(trackInfo.id, time)
  }

  /** Add a frame to the cache and track it locally */
  const addFrame = (frame: VideoFrame, pts: number, duration: number) => {
    // Store in shared cache (cache takes ownership)
    // Use bufferId (unique per frame buffer) not trackInfo.id (demuxer's internal ID)
    cache.put(bufferId, pts, frame)

    // Track locally in sorted order by PTS
    const insertIndex = bufferedPts.findIndex(f => f.pts > pts)
    if (insertIndex === -1) {
      bufferedPts.push({ pts, duration })
    } else {
      bufferedPts.splice(insertIndex, 0, { pts, duration })
    }

    log('addFrame', { pts, duration, bufferedCount: bufferedPts.length, cacheSize: cache.size })

    // Trim local tracking if too large (cache handles actual eviction)
    while (bufferedPts.length > maxLocalEntries) {
      bufferedPts.shift()
    }
  }

  /** Clear local tracking (cache frames remain for other tracks) */
  const clearLocalTracking = () => {
    log('clearLocalTracking', { bufferedCount: bufferedPts.length })
    bufferedPts = []
  }

  /** Decode samples and add to cache */
  const decodeAndBuffer = async (samples: DemuxedSample[]) => {
    log('decodeAndBuffer', {
      sampleCount: samples.length,
      destroyed,
      decoderState: decoder.decoder.state,
    })

    if (samples.length === 0 || destroyed) return

    // Ensure decoder is open (recreate if closed)
    if (!(await ensureDecoderOpen())) {
      log('decodeAndBuffer: could not ensure decoder is open')
      return
    }

    let decodedCount = 0
    let skippedCount = 0
    let cacheHitCount = 0
    let errorCount = 0

    for (const sample of samples) {
      // Check if destroyed during loop
      if (destroyed) return

      // Try to recover if decoder got closed during loop
      if ((decoder.decoder.state as string) === 'closed') {
        log('decodeAndBuffer: decoder closed mid-loop, attempting recovery')
        if (!(await ensureDecoderOpen())) {
          log('decodeAndBuffer: recovery failed, aborting')
          return
        }
      }

      // Skip delta frames if decoder hasn't received a keyframe yet
      if (!decoderReady && !sample.isKeyframe) {
        bufferPosition = sample.pts + sample.duration
        skippedCount++
        continue
      }

      // Check if already in cache (LRU benefit!)
      if (cache.has(bufferId, sample.pts)) {
        // Already cached, just update local tracking
        const existingIdx = bufferedPts.findIndex(f => f.pts === sample.pts)
        if (existingIdx === -1) {
          const insertIndex = bufferedPts.findIndex(f => f.pts > sample.pts)
          if (insertIndex === -1) {
            bufferedPts.push({ pts: sample.pts, duration: sample.duration })
          } else {
            bufferedPts.splice(insertIndex, 0, { pts: sample.pts, duration: sample.duration })
          }
        }
        bufferPosition = sample.pts + sample.duration
        cacheHitCount++
        decoderReady = true // Assume cache has valid frames
        continue
      }

      try {
        perf.start('decode')
        const frame = await decoder.decode(sample)
        perf.end('decode')
        if (destroyed) {
          frame.close()
          return
        }
        decoderReady = true
        addFrame(frame, sample.pts, sample.duration)
        bufferPosition = sample.pts + sample.duration
        decodedCount++
        perf.increment('frames-decoded')
      } catch (err) {
        errorCount++
        log('decodeAndBuffer error', { pts: sample.pts, isKeyframe: sample.isKeyframe, error: err })

        // If decoder closed after error, try to recover
        if ((decoder.decoder.state as string) === 'closed') {
          log('decodeAndBuffer: decoder closed after error, attempting recovery')
          if (!(await ensureDecoderOpen())) {
            log('decodeAndBuffer: recovery failed after error, aborting')
            return
          }
          // After recreating decoder, we need a keyframe to continue
          decoderReady = false
        } else if (sample.isKeyframe) {
          decoderReady = false
        }

        // Move past this sample
        bufferPosition = sample.pts + sample.duration
      }
    }

    log('decodeAndBuffer complete', {
      decodedCount,
      skippedCount,
      cacheHitCount,
      errorCount,
      bufferedCount: bufferedPts.length,
      cacheSize: cache.size,
    })

    // Only flush if not destroyed and decoder is still open
    if (!destroyed && decoder.decoder.state !== 'closed') {
      await decoder.flush()
      decoderReady = false
    }
  }

  return {
    get state() {
      return state
    },

    get bufferStart() {
      if (bufferedPts.length === 0) return 0
      return bufferedPts[0].pts
    },

    get bufferEnd() {
      if (bufferedPts.length === 0) return 0
      const last = bufferedPts[bufferedPts.length - 1]
      return last.pts + last.duration
    },

    get frameCount() {
      return bufferedPts.length
    },

    get trackInfo() {
      return trackInfo
    },

    getFrame(time: number): BufferedFrame | null {
      getFrameCallCount++

      if (bufferedPts.length === 0) {
        log('getFrame: no frames', { time, callCount: getFrameCallCount, state, destroyed })
        return null
      }

      // Find the frame info at or just before the given time
      let best: { pts: number; duration: number } | null = null
      for (const f of bufferedPts) {
        if (f.pts <= time) {
          best = f
        } else {
          break // Frames are sorted, so we can stop
        }
      }

      // If no frame found at or before time, use the first one
      const target = best ?? bufferedPts[0]

      // Get CLONE from cache (cache keeps original)
      const frame = cache.get(bufferId, target.pts)

      if (!frame) {
        // Cache miss - frame was evicted by LRU
        log('getFrame: cache miss', { time, targetPts: target.pts, cacheSize: cache.size })
        return null
      }

      // Log every call, but with rate limiting for repeated same-frame fetches
      if (target.pts !== lastLoggedPts || getFrameCallCount % 30 === 0) {
        log('getFrame', {
          time: time.toFixed(3),
          resultPts: target.pts.toFixed(3),
          bufferedCount: bufferedPts.length,
          cacheSize: cache.size,
          callCount: getFrameCallCount,
          state,
          destroyed,
        })
        lastLoggedPts = target.pts
      }

      return { frame, pts: target.pts, duration: target.duration }
    },

    async seekTo(time: number): Promise<void> {
      log('seekTo', { time, destroyed, isBuffering, state, bufferedCount: bufferedPts.length })
      if (destroyed) return

      // Wait for any pending buffering to complete
      while (isBuffering) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      isBuffering = true

      try {
        state = 'buffering'

        // Clear local tracking (cache frames may still be used by other tracks)
        clearLocalTracking()

        // Reset decoder for clean state (or recreate if closed)
        if ((decoder.decoder.state as string) === 'closed') {
          await ensureDecoderOpen()
        } else {
          await decoder.reset()
        }
        decoderReady = false

        // Find keyframe at or before the target time
        const keyframe = await findKeyframeBefore(time)
        if (!keyframe) {
          // No keyframe found, start from beginning
          bufferPosition = 0
        } else {
          bufferPosition = keyframe.pts
        }

        // Get samples from keyframe position up to buffer ahead target
        const targetEnd = Math.min(time + bufferAhead, trackDuration)
        const samples = await demuxer.getSamples(trackInfo.id, bufferPosition, targetEnd)

        // Decode all samples (will use cache hits where available)
        await decodeAndBuffer(samples)

        // Update state
        if (bufferPosition >= trackDuration) {
          state = 'ended'
        } else {
          state = bufferedPts.length > 0 ? 'ready' : 'idle'
        }

        log('seekTo complete', {
          time,
          state,
          bufferedCount: bufferedPts.length,
          cacheSize: cache.size,
          bufferPosition,
          firstPts: bufferedPts[0]?.pts,
          lastPts: bufferedPts[bufferedPts.length - 1]?.pts,
        })
      } finally {
        isBuffering = false
      }
    },

    async bufferMore(): Promise<void> {
      if (destroyed || state === 'ended') {
        log('bufferMore: skipped', { destroyed, state })
        return
      }

      // Skip if already buffering (non-blocking check)
      if (isBuffering) return

      log('bufferMore: starting', { bufferPosition, bufferedCount: bufferedPts.length })
      isBuffering = true

      try {
        state = 'buffering'

        // Get more samples from current position
        const targetEnd = Math.min(bufferPosition + bufferAhead, trackDuration)
        if (bufferPosition >= targetEnd) {
          state = bufferPosition >= trackDuration ? 'ended' : 'ready'
          return
        }

        const samples = await demuxer.getSamples(trackInfo.id, bufferPosition, targetEnd)

        if (samples.length === 0) {
          state = bufferPosition >= trackDuration ? 'ended' : 'ready'
          return
        }

        await decodeAndBuffer(samples)

        state = bufferPosition >= trackDuration ? 'ended' : 'ready'
        log('bufferMore: complete', { state, bufferedCount: bufferedPts.length, cacheSize: cache.size })
      } finally {
        isBuffering = false
      }
    },

    isBufferedAt(time: number): boolean {
      if (bufferedPts.length === 0) return false
      const start = bufferedPts[0].pts
      const last = bufferedPts[bufferedPts.length - 1]
      const end = last.pts + last.duration
      // Also check cache to handle LRU eviction
      return time >= start && time < end && cache.has(bufferId, start)
    },

    clear(): void {
      log('clear', { bufferedCount: bufferedPts.length, state, getFrameCallCount })
      clearLocalTracking()
      bufferPosition = 0
      decoderReady = false
      isBuffering = false
      state = 'idle'
      getFrameCallCount = 0
      lastLoggedPts = -1
    },

    destroy(): void {
      log('destroy', { bufferedCount: bufferedPts.length, state, getFrameCallCount })
      destroyed = true
      isBuffering = false
      // Remove this buffer's frames from cache
      cache.removeTrack(bufferId)
      clearLocalTracking()
      decoder.close()
      state = 'idle'
    },
  }
}

/**
 * Evict frames that are too old from a buffer
 * Useful for keeping memory usage low during long playback
 * @param buffer - The frame buffer
 * @param currentTime - Current playback time
 * @param keepBehind - How many seconds of frames to keep behind current time
 */
export function evictOldFrames(
  buffer: FrameBuffer & { frames?: BufferedFrame[] },
  currentTime: number,
  keepBehind: number = 0.5,
): void {
  // This would need internal access to frames array
  // For now this is a placeholder for future optimization
}
