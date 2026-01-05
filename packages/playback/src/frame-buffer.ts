import type { DemuxedSample, Demuxer, VideoTrackInfo } from '@eddy/codecs'
import { createVideoDecoder } from '@eddy/codecs'
import { debug } from '@eddy/utils'

const log = debug('frame-buffer', false)

/** Raw frame data stored as ArrayBuffer */
export interface FrameData {
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
  displayWidth: number
  displayHeight: number
  timestamp: number // microseconds
  duration: number // microseconds
}

/** Frame buffer state */
export type FrameBufferState = 'idle' | 'buffering' | 'ready' | 'ended'

export interface FrameBufferOptions {
  /** How many seconds to buffer ahead of current position (default: 0.5) */
  bufferAhead?: number
  /** Maximum frames to keep in buffer (default: 10) */
  maxFrames?: number
}

export interface FrameBuffer {
  /** Current buffer state */
  readonly state: FrameBufferState

  /** Number of frames currently buffered */
  readonly size: number

  /** Track info for this buffer */
  readonly trackInfo: VideoTrackInfo

  /**
   * Get frame for time, creates VideoFrame from buffer.
   * Caller takes ownership and must close the frame.
   * @returns VideoFrame or null if not buffered
   */
  getFrame(time: number): VideoFrame | null

  /**
   * Get timestamp of frame at time without creating VideoFrame.
   * Use for same-frame optimization.
   * @returns timestamp in microseconds, or null if not buffered
   */
  getFrameTimestamp(time: number): number | null

  /**
   * Seek to time - clears buffer and decodes from keyframe
   */
  seekTo(time: number): Promise<void>

  /**
   * Buffer more frames ahead of current position
   */
  bufferMore(): Promise<void>

  /**
   * Check if buffer has content at time
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
 * Create a frame buffer that stores raw ArrayBuffer data.
 * VideoFrames are created on-demand at getFrame() time.
 */
export async function createFrameBuffer(
  demuxer: Demuxer,
  trackInfo: VideoTrackInfo,
  options: FrameBufferOptions = {},
): Promise<FrameBuffer> {
  const bufferId = frameBufferIdCounter++
  const bufferLog = debug(`frame-buffer-${bufferId}`, false)
  bufferLog('createFrameBuffer', { trackId: trackInfo.id, duration: trackInfo.duration })

  const bufferAhead = options.bufferAhead ?? 0.5
  const maxFrames = options.maxFrames ?? 10

  // Create decoder
  let decoder = await createVideoDecoder(demuxer, trackInfo)

  // Buffer of raw frame data (sorted by timestamp)
  let frames: FrameData[] = []

  // Current buffer position (where we last decoded up to)
  let bufferPosition = 0

  // Whether decoder has received a keyframe
  let decoderReady = false

  // Whether destroyed
  let destroyed = false

  // State
  let state: FrameBufferState = 'idle'

  // Lock for buffering
  let isBuffering = false

  // Track duration (fallback for unknown)
  const trackDuration = trackInfo.duration > 0 ? trackInfo.duration : 3600

  /** Ensure decoder is open, recreate if closed */
  const ensureDecoderOpen = async (): Promise<boolean> => {
    if (decoder.decoder.state !== 'closed') {
      return true
    }
    bufferLog('ensureDecoderOpen: decoder closed, recreating')
    try {
      decoder = await createVideoDecoder(demuxer, trackInfo)
      decoderReady = false
      return true
    } catch (err) {
      bufferLog('ensureDecoderOpen: failed', { error: err })
      return false
    }
  }

  /** Convert VideoFrame to raw FrameData */
  const frameToData = async (frame: VideoFrame): Promise<FrameData> => {
    const buffer = new ArrayBuffer(frame.allocationSize())
    await frame.copyTo(buffer)

    const data: FrameData = {
      buffer,
      format: frame.format!,
      codedWidth: frame.codedWidth,
      codedHeight: frame.codedHeight,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      timestamp: frame.timestamp,
      duration: frame.duration ?? 0,
    }

    frame.close()
    return data
  }

  /** Convert FrameData back to VideoFrame */
  const dataToFrame = (data: FrameData): VideoFrame => {
    return new VideoFrame(data.buffer, {
      format: data.format,
      codedWidth: data.codedWidth,
      codedHeight: data.codedHeight,
      displayWidth: data.displayWidth,
      displayHeight: data.displayHeight,
      timestamp: data.timestamp,
      duration: data.duration,
    })
  }

  /** Find frame data at or before given time */
  const findFrameData = (time: number): FrameData | null => {
    if (frames.length === 0) return null

    const timeUs = time * 1_000_000

    // Find frame at or just before time
    let best: FrameData | null = null
    for (const frame of frames) {
      if (frame.timestamp <= timeUs) {
        best = frame
      } else {
        break // Frames are sorted
      }
    }

    return best ?? frames[0]
  }

  /** Decode samples and store as raw buffers */
  const decodeAndBuffer = async (samples: DemuxedSample[]) => {
    bufferLog('decodeAndBuffer', { sampleCount: samples.length })

    if (samples.length === 0 || destroyed) return

    if (!(await ensureDecoderOpen())) return

    for (const sample of samples) {
      if (destroyed) return

      // Skip delta frames if decoder not ready
      if (!decoderReady && !sample.isKeyframe) {
        bufferPosition = sample.pts + sample.duration
        continue
      }

      try {
        const videoFrame = await decoder.decode(sample)
        decoderReady = true

        // Convert to raw buffer immediately
        const data = await frameToData(videoFrame)

        // Insert in sorted order by timestamp
        const insertIndex = frames.findIndex(f => f.timestamp > data.timestamp)
        if (insertIndex === -1) {
          frames.push(data)
        } else {
          frames.splice(insertIndex, 0, data)
        }

        bufferPosition = sample.pts + sample.duration

        // Trim if over max
        while (frames.length > maxFrames) {
          frames.shift()
        }
      } catch (err) {
        bufferLog('decode error', { pts: sample.pts, error: err })

        if (decoder.decoder.state === 'closed') {
          if (!(await ensureDecoderOpen())) return
          decoderReady = false
        } else if (sample.isKeyframe) {
          decoderReady = false
        }

        bufferPosition = sample.pts + sample.duration
      }
    }

    // Flush decoder
    if (!destroyed && decoder.decoder.state !== 'closed') {
      await decoder.flush()
      decoderReady = false
    }

    bufferLog('decodeAndBuffer complete', { frameCount: frames.length })
  }

  return {
    get state() {
      return state
    },

    get size() {
      return frames.length
    },

    get trackInfo() {
      return trackInfo
    },

    getFrame(time: number): VideoFrame | null {
      const data = findFrameData(time)
      if (!data) return null

      // Create VideoFrame from buffer - caller takes ownership
      return dataToFrame(data)
    },

    getFrameTimestamp(time: number): number | null {
      const data = findFrameData(time)
      return data?.timestamp ?? null
    },

    async seekTo(time: number): Promise<void> {
      bufferLog('seekTo', { time })
      if (destroyed) return

      while (isBuffering) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      isBuffering = true

      try {
        state = 'buffering'

        // Clear buffer
        frames = []

        // Reset decoder
        if (decoder.decoder.state === 'closed') {
          await ensureDecoderOpen()
        } else {
          await decoder.reset()
        }
        decoderReady = false

        // Find keyframe before target
        const keyframe = await demuxer.getKeyframeBefore(trackInfo.id, time)
        bufferPosition = keyframe?.pts ?? 0

        // Get samples and decode
        const targetEnd = Math.min(time + bufferAhead, trackDuration)
        const samples = await demuxer.getSamples(trackInfo.id, bufferPosition, targetEnd)
        await decodeAndBuffer(samples)

        state = bufferPosition >= trackDuration ? 'ended' : frames.length > 0 ? 'ready' : 'idle'

        bufferLog('seekTo complete', { time, frameCount: frames.length })
      } finally {
        isBuffering = false
      }
    },

    async bufferMore(): Promise<void> {
      if (destroyed || state === 'ended' || isBuffering) return

      isBuffering = true

      try {
        state = 'buffering'

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
      const timeUs = time * 1_000_000
      const first = frames[0].timestamp
      const last = frames[frames.length - 1]
      return timeUs >= first && timeUs <= last.timestamp + last.duration
    },

    clear(): void {
      bufferLog('clear')
      frames = []
      bufferPosition = 0
      decoderReady = false
      isBuffering = false
      state = 'idle'
    },

    destroy(): void {
      bufferLog('destroy')
      destroyed = true
      isBuffering = false
      frames = []
      decoder.close()
      state = 'idle'
    },
  }
}
