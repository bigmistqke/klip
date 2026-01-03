import type { Demuxer, DemuxedSample, VideoTrackInfo } from './demuxer'
import type { VideoDecoderHandle } from './video-decoder'
import { createVideoDecoder } from './video-decoder'

/** A decoded frame with timing information */
export interface BufferedFrame {
  /** The decoded VideoFrame */
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
  /** Maximum frames to keep in buffer (default: 60) */
  maxFrames?: number
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

/**
 * Create a frame buffer for a video track
 */
export async function createFrameBuffer(
  demuxer: Demuxer,
  trackInfo: VideoTrackInfo,
  options: FrameBufferOptions = {}
): Promise<FrameBuffer> {
  const bufferAhead = options.bufferAhead ?? 2
  const maxFrames = options.maxFrames ?? 60

  // Create the decoder
  const decoder = await createVideoDecoder(demuxer, trackInfo)

  // Buffered frames sorted by PTS
  let frames: BufferedFrame[] = []

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

  /** Get all samples for the track */
  const getAllSamples = async (): Promise<DemuxedSample[]> => {
    return demuxer.getAllSamples(trackInfo.id)
  }

  /** Find the keyframe at or before the given time */
  const findKeyframeBefore = async (time: number): Promise<DemuxedSample | null> => {
    return demuxer.getKeyframeBefore(trackInfo.id, time)
  }

  /** Add a frame to the buffer, maintaining sort order */
  const addFrame = (frame: VideoFrame, pts: number, duration: number) => {
    const bufferedFrame: BufferedFrame = { frame, pts, duration }

    // Insert in sorted order by PTS
    const insertIndex = frames.findIndex((f) => f.pts > pts)
    if (insertIndex === -1) {
      frames.push(bufferedFrame)
    } else {
      frames.splice(insertIndex, 0, bufferedFrame)
    }

    // Evict oldest frames if over limit
    while (frames.length > maxFrames) {
      const oldest = frames.shift()
      oldest?.frame.close()
    }
  }

  /** Clear all frames */
  const clearFrames = () => {
    for (const f of frames) {
      f.frame.close()
    }
    frames = []
  }

  /** Decode samples and add to buffer */
  const decodeAndBuffer = async (samples: DemuxedSample[]) => {
    if (samples.length === 0 || destroyed) return

    // Check decoder state before starting
    if (decoder.decoder.state === 'closed') return

    for (const sample of samples) {
      // Check if destroyed or decoder closed during loop
      if (destroyed || decoder.decoder.state === 'closed') return

      // Skip delta frames if decoder hasn't received a keyframe yet
      if (!decoderReady && !sample.isKeyframe) {
        bufferPosition = sample.pts + sample.duration
        continue
      }

      try {
        const frame = await decoder.decode(sample)
        if (destroyed) {
          frame.close()
          return
        }
        decoderReady = true
        addFrame(frame, sample.pts, sample.duration)
        bufferPosition = sample.pts + sample.duration
      } catch {
        // If decoder is closed, stop trying
        if (decoder.decoder.state === 'closed') return
        // If we fail on a keyframe, reset decoderReady
        if (sample.isKeyframe) {
          decoderReady = false
        }
        // Silently skip failed delta frames
        if (!sample.isKeyframe) {
          bufferPosition = sample.pts + sample.duration
        }
      }
    }

    // Only flush if not destroyed and decoder is still open
    if (!destroyed && decoder.decoder.state !== 'closed') {
      await decoder.flush()
      // After flush, decoder needs a new keyframe to continue
      decoderReady = false
    }
  }

  return {
    get state() {
      return state
    },

    get bufferStart() {
      if (frames.length === 0) return 0
      return frames[0].pts
    },

    get bufferEnd() {
      if (frames.length === 0) return 0
      const last = frames[frames.length - 1]
      return last.pts + last.duration
    },

    get frameCount() {
      return frames.length
    },

    get trackInfo() {
      return trackInfo
    },

    getFrame(time: number): BufferedFrame | null {
      if (frames.length === 0) return null

      // Find the frame at or just before the given time
      let best: BufferedFrame | null = null
      for (const f of frames) {
        if (f.pts <= time) {
          best = f
        } else {
          break // Frames are sorted, so we can stop
        }
      }

      return best
    },

    async seekTo(time: number): Promise<void> {
      if (destroyed) return

      // Wait for any pending buffering to complete
      while (isBuffering) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      isBuffering = true

      try {
        state = 'buffering'

        // Clear existing buffer
        clearFrames()

        // Reset decoder for clean state
        await decoder.reset()
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

        // Decode all samples
        await decodeAndBuffer(samples)

        // Update state
        if (bufferPosition >= trackDuration) {
          state = 'ended'
        } else {
          state = frames.length > 0 ? 'ready' : 'idle'
        }
      } finally {
        isBuffering = false
      }
    },

    async bufferMore(): Promise<void> {
      if (destroyed || state === 'ended') return

      // Skip if already buffering (non-blocking check)
      if (isBuffering) return

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
      } finally {
        isBuffering = false
      }
    },

    isBufferedAt(time: number): boolean {
      if (frames.length === 0) return false
      const start = frames[0].pts
      const last = frames[frames.length - 1]
      const end = last.pts + last.duration
      return time >= start && time < end
    },

    clear(): void {
      clearFrames()
      bufferPosition = 0
      decoderReady = false
      isBuffering = false
      state = 'idle'
    },

    destroy(): void {
      destroyed = true
      isBuffering = false
      clearFrames()
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
  keepBehind: number = 0.5
): void {
  // This would need internal access to frames array
  // For now this is a placeholder for future optimization
}
