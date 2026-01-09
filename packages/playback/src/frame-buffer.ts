import type { DemuxedSample, Demuxer, VideoTrackInfo } from '@eddy/codecs'
import { createVideoDecoder } from '@eddy/codecs'
import { debug } from '@eddy/utils'

const log = debug('frame-buffer', false)

/** Plane layout for VideoFrame reconstruction */
interface PlaneLayout {
  offset: number
  stride: number
}

/** Align value up to nearest multiple of alignment */
function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

/** Calculate aligned layout for a video format (128-byte alignment for GPU compatibility) */
function calculateAlignedLayout(
  format: string, // Use string to allow newer formats not in TS types
  width: number,
  height: number,
): { layout: PlaneLayout[]; totalSize: number } {
  const ALIGNMENT = 128

  // Determine bytes per sample (10/12-bit formats use 2 bytes)
  const bytesPerSample = format.includes('P10') || format.includes('P12') ? 2 : 1
  const hasAlpha = format.includes('A') && format !== 'RGBA' && format !== 'BGRA'

  // I420 family (4:2:0 subsampling)
  if (format.startsWith('I420')) {
    const yStride = alignUp(width * bytesPerSample, ALIGNMENT)
    const uvStride = alignUp((width / 2) * bytesPerSample, ALIGNMENT)
    const ySize = yStride * height
    const uvSize = uvStride * (height / 2)

    const layout: PlaneLayout[] = [
      { offset: 0, stride: yStride },
      { offset: ySize, stride: uvStride },
      { offset: ySize + uvSize, stride: uvStride },
    ]

    if (hasAlpha) {
      layout.push({ offset: ySize + uvSize * 2, stride: yStride })
      return { layout, totalSize: ySize * 2 + uvSize * 2 }
    }

    return { layout, totalSize: ySize + uvSize * 2 }
  }

  // I422 family (4:2:2 subsampling)
  if (format.startsWith('I422')) {
    const yStride = alignUp(width * bytesPerSample, ALIGNMENT)
    const uvStride = alignUp((width / 2) * bytesPerSample, ALIGNMENT)
    const ySize = yStride * height
    const uvSize = uvStride * height

    const layout: PlaneLayout[] = [
      { offset: 0, stride: yStride },
      { offset: ySize, stride: uvStride },
      { offset: ySize + uvSize, stride: uvStride },
    ]

    if (hasAlpha) {
      layout.push({ offset: ySize + uvSize * 2, stride: yStride })
      return { layout, totalSize: ySize * 2 + uvSize * 2 }
    }

    return { layout, totalSize: ySize + uvSize * 2 }
  }

  // I444 family (4:4:4 no subsampling)
  if (format.startsWith('I444')) {
    const stride = alignUp(width * bytesPerSample, ALIGNMENT)
    const planeSize = stride * height
    const numPlanes = hasAlpha ? 4 : 3

    const layout: PlaneLayout[] = []
    for (let i = 0; i < numPlanes; i++) {
      layout.push({ offset: planeSize * i, stride })
    }

    return { layout, totalSize: planeSize * numPlanes }
  }

  // NV12 family (4:2:0 with interleaved UV)
  if (format.startsWith('NV12')) {
    const yStride = alignUp(width * bytesPerSample, ALIGNMENT)
    const uvStride = alignUp(width * bytesPerSample, ALIGNMENT)
    const ySize = yStride * height
    const uvSize = uvStride * (height / 2)

    const layout: PlaneLayout[] = [
      { offset: 0, stride: yStride },
      { offset: ySize, stride: uvStride },
    ]

    if (hasAlpha) {
      layout.push({ offset: ySize + uvSize, stride: yStride })
      return { layout, totalSize: ySize * 2 + uvSize }
    }

    return { layout, totalSize: ySize + uvSize }
  }

  // RGBA/BGRA family
  if (format === 'RGBA' || format === 'RGBX' || format === 'BGRA' || format === 'BGRX') {
    const stride = alignUp(width * 4, ALIGNMENT)
    return {
      layout: [{ offset: 0, stride }],
      totalSize: stride * height,
    }
  }

  throw new Error(`Unsupported pixel format: ${format}`)
}

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
  layout: PlaneLayout[] // plane layout for reconstruction
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

  // Track last accessed time for smart trimming
  let lastAccessedTime = 0

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

  /** Convert VideoFrame to raw FrameData with aligned layout */
  const frameToData = async (frame: VideoFrame, sample: DemuxedSample): Promise<FrameData> => {
    if (!frame.format) {
      frame.close()
      throw new Error(`VideoFrame has null format - cannot buffer. codedSize: ${frame.codedWidth}x${frame.codedHeight}`)
    }

    // Calculate aligned layout to satisfy VideoFrame constructor requirements
    const { layout, totalSize } = calculateAlignedLayout(
      frame.format,
      frame.codedWidth,
      frame.codedHeight,
    )

    const buffer = new ArrayBuffer(totalSize)
    await frame.copyTo(buffer, { layout })

    // Use sample.pts/duration instead of frame.timestamp/duration
    // because the decoder's pendingFrames queue can cause misalignment
    const data: FrameData = {
      buffer,
      format: frame.format,
      codedWidth: frame.codedWidth,
      codedHeight: frame.codedHeight,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      timestamp: sample.pts * 1_000_000, // Convert seconds to microseconds
      duration: sample.duration * 1_000_000,
      layout,
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
      layout: data.layout,
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

  /** Decode samples and store as raw buffers
   * @param flush - Whether to flush the decoder after decoding (clears reference frames, use only for seeking)
   */
  const decodeAndBuffer = async (samples: DemuxedSample[], flush = false) => {
    bufferLog('decodeAndBuffer', { sampleCount: samples.length, flush })

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

        // Capture frame timestamp before it gets closed
        const decoderTimestamp = videoFrame.timestamp

        // Convert to raw buffer immediately, using sample timestamps
        const data = await frameToData(videoFrame, sample)

        bufferLog('decoded frame', {
          samplePts: sample.pts,
          samplePtsUs: sample.pts * 1_000_000,
          assignedTimestamp: data.timestamp,
          decoderTimestamp,
        })

        // Insert in sorted order by timestamp
        const insertIndex = frames.findIndex(f => f.timestamp > data.timestamp)
        if (insertIndex === -1) {
          frames.push(data)
        } else {
          frames.splice(insertIndex, 0, data)
        }

        bufferPosition = sample.pts + sample.duration

        // Trim frames that are behind the playback position (with 100ms margin)
        // Only trim if over maxFrames to avoid unnecessary work
        const trimThreshold = (lastAccessedTime - 0.1) * 1_000_000
        while (frames.length > maxFrames && frames[0].timestamp < trimThreshold) {
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

    // Only flush when explicitly requested (e.g., after seeking)
    // Flushing clears the decoder's reference frames, requiring a keyframe for subsequent decodes
    if (flush && !destroyed && decoder.decoder.state !== 'closed') {
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
      // Track accessed time for smart trimming
      lastAccessedTime = time

      const data = findFrameData(time)
      if (!data) {
        bufferLog('getFrame: no data', { time, frameCount: frames.length })
        return null
      }

      // Log buffer range occasionally
      if (frames.length > 0) {
        const first = frames[0].timestamp / 1_000_000
        const last = frames[frames.length - 1].timestamp / 1_000_000
        bufferLog('getFrame', { time, foundTs: data.timestamp / 1_000_000, bufferRange: `${first.toFixed(2)}-${last.toFixed(2)}` })
      }

      // Create VideoFrame from buffer - caller takes ownership
      return dataToFrame(data)
    },

    getFrameTimestamp(time: number): number | null {
      // Track accessed time for smart trimming
      lastAccessedTime = time

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
        lastAccessedTime = time  // Reset accessed time to seek target

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

        // Get samples and decode (don't flush - decoder.reset() already cleared state)
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
      if (destroyed || state === 'ended' || isBuffering) {
        bufferLog('bufferMore: skipped', { destroyed, state, isBuffering })
        return
      }

      isBuffering = true

      try {
        state = 'buffering'

        const targetEnd = Math.min(bufferPosition + bufferAhead, trackDuration)
        bufferLog('bufferMore', { bufferPosition, targetEnd, trackDuration })

        if (bufferPosition >= targetEnd) {
          state = bufferPosition >= trackDuration ? 'ended' : 'ready'
          bufferLog('bufferMore: position past target', { state })
          return
        }

        const samples = await demuxer.getSamples(trackInfo.id, bufferPosition, targetEnd)
        bufferLog('bufferMore: got samples', {
          count: samples.length,
          firstPts: samples[0]?.pts,
          lastPts: samples[samples.length - 1]?.pts
        })

        if (samples.length === 0) {
          state = bufferPosition >= trackDuration ? 'ended' : 'ready'
          return
        }

        await decodeAndBuffer(samples)
        bufferLog('bufferMore complete', { newBufferPosition: bufferPosition })
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
      lastAccessedTime = 0
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
