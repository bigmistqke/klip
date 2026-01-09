import { expose, rpc, transfer, type RPC } from '@bigmistqke/rpc/messenger'
import type { DemuxedSample, VideoTrackInfo } from '@eddy/codecs'
import { createPerfMonitor, debug } from '@eddy/utils'
import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type EncodedPacket,
  type InputVideoTrack,
} from 'mediabunny'

const log = debug('playback-worker', false)
const perf = createPerfMonitor()

/** Methods exposed by compositor worker (subset we need) */
interface CompositorFrameMethods {
  setFrame(trackId: string, frame: VideoFrame | null): void
}

/** Worker state */
type WorkerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'seeking'

export interface PlaybackWorkerMethods {
  /** Load a blob for playback */
  load(buffer: ArrayBuffer): Promise<{ duration: number; videoTrack: VideoTrackInfo | null }>

  /** Connect to compositor via MessagePort */
  connectToCompositor(id: string, port: MessagePort): void

  /** Start playback from time at speed */
  play(startTime: number, playbackSpeed?: number): void

  /** Pause playback */
  pause(): void

  /** Seek to time (buffers from keyframe) */
  seek(time: number): Promise<void>

  /** Get current buffer range */
  getBufferRange(): { start: number; end: number }

  /** Get current state */
  getState(): WorkerState

  /** Get performance stats */
  getPerf(): Record<string, { samples: number; avg: number; max: number; min: number; overThreshold: number }>

  /** Reset performance stats */
  resetPerf(): void

  /** Clean up resources */
  destroy(): void
}

/** Plane layout for VideoFrame reconstruction */
interface PlaneLayout {
  offset: number
  stride: number
}

/** Raw frame data for buffering */
interface FrameData {
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
  displayWidth: number
  displayHeight: number
  timestamp: number // microseconds
  duration: number // microseconds
  layout: PlaneLayout[]
}

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

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

/** Convert VideoFrame to FrameData with aligned layout */
async function frameToData(frame: VideoFrame, sample: DemuxedSample): Promise<FrameData> {
  if (!frame.format) {
    frame.close()
    throw new Error(`VideoFrame has null format - cannot buffer`)
  }

  const { layout, totalSize } = calculateAlignedLayout(
    frame.format,
    frame.codedWidth,
    frame.codedHeight,
  )

  log('frameToData', {
    format: frame.format,
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    totalSize,
    layout,
  })

  const buffer = new ArrayBuffer(totalSize)
  await frame.copyTo(buffer, { layout })

  const data: FrameData = {
    buffer,
    format: frame.format,
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    timestamp: sample.pts * 1_000_000,
    duration: sample.duration * 1_000_000,
    layout,
  }

  frame.close()
  return data
}

/** Convert FrameData to VideoFrame (for transfer) */
function dataToFrame(data: FrameData): VideoFrame {
  log('dataToFrame', {
    format: data.format,
    codedWidth: data.codedWidth,
    codedHeight: data.codedHeight,
    bufferSize: data.buffer.byteLength,
  })

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

/**********************************************************************************/
/*                                                                                */
/*                                     Methods                                    */
/*                                                                                */
/**********************************************************************************/

/** Buffer configuration */
const BUFFER_AHEAD_FRAMES = 10
const BUFFER_AHEAD_SECONDS = 1.0
const BUFFER_MAX_FRAMES = 30

/** Worker state */
let state: WorkerState = 'idle'
let trackId: string = ''

// Demuxer state
let input: Input | null = null
let videoTrack: InputVideoTrack | null = null
let videoSink: EncodedPacketSink | null = null
let videoConfig: VideoDecoderConfig | null = null
let duration = 0

// Decoder state
let decoder: VideoDecoder | null = null
let decoderReady = false

// Buffer state (ring buffer of decoded frames)
let frameBuffer: FrameData[] = []
let bufferPosition = 0 // Where we've decoded up to (seconds)
let isBuffering = false // Lock to prevent concurrent buffer operations

// Playback timing state
let isPlaying = false
let startWallTime = 0 // performance.now() when play started
let startMediaTime = 0 // media time when play started
let speed = 1

// Compositor connection
let compositor: RPC<CompositorFrameMethods> | null = null
let lastSentTimestamp: number | null = null

// Animation frame ID
let animationFrameId: number | null = null

// Pending frame resolvers
let pendingFrameResolvers: Array<{
  resolve: (frame: VideoFrame) => void
  reject: (error: Error) => void
}> = []
let pendingFrames: VideoFrame[] = []
let currentError: Error | null = null

/** Convert packet to sample format */
function packetToSample(packet: EncodedPacket): DemuxedSample {
  return {
    number: 0,
    trackId: videoTrack?.id ?? 0,
    pts: packet.timestamp,
    dts: packet.timestamp,
    duration: packet.duration,
    isKeyframe: packet.type === 'key',
    data: packet.data,
    size: packet.data.byteLength,
  }
}

/** Find frame at or before time */
function findFrameData(timeSeconds: number): FrameData | null {
  if (frameBuffer.length === 0) return null

  const timeUs = timeSeconds * 1_000_000
  let best: FrameData | null = null

  for (const frame of frameBuffer) {
    if (frame.timestamp <= timeUs) {
      best = frame
    } else {
      break
    }
  }

  return best ?? frameBuffer[0]
}

/** Initialize decoder */
async function initDecoder(): Promise<void> {
  if (!videoConfig) throw new Error('No video config')

  log('initDecoder', {
    codec: videoConfig.codec,
    codedWidth: videoConfig.codedWidth,
    codedHeight: videoConfig.codedHeight,
    hasDescription: !!videoConfig.description,
    descriptionLength:
      videoConfig.description instanceof ArrayBuffer ? videoConfig.description.byteLength : 'N/A',
  })

  // Check if decoder supports this config
  const support = await VideoDecoder.isConfigSupported(videoConfig)
  log('decoder config support', { supported: support.supported, config: support.config })

  if (!support.supported) {
    throw new Error(`Unsupported video config: ${videoConfig.codec}`)
  }

  // Clear pending state
  pendingFrameResolvers = []
  pendingFrames = []
  currentError = null

  decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      log('decoder output', { timestamp: frame.timestamp, duration: frame.duration })
      // If we have pending resolvers, resolve the first one
      const pending = pendingFrameResolvers.shift()
      if (pending) {
        pending.resolve(frame)
      } else {
        // Otherwise queue the frame
        pendingFrames.push(frame)
      }
    },
    error: error => {
      log('decoder error callback', { error, message: error.message, name: error.name })
      currentError = error
      // Reject any pending promises
      const pending = pendingFrameResolvers.shift()
      if (pending) {
        pending.reject(error)
      }
    },
  })

  decoder.configure(videoConfig)
  decoderReady = false
}

/** Decode a sample and buffer the result */
async function decodeAndBuffer(sample: DemuxedSample): Promise<void> {
  perf.start('decode')
  if (!decoder || decoder.state === 'closed') {
    log('decodeAndBuffer: decoder not available', { decoderState: decoder?.state })
    perf.end('decode')
    return
  }

  // Skip delta frames if decoder not ready (need keyframe first)
  if (!decoderReady && !sample.isKeyframe) {
    log('skipping delta frame, decoder not ready')
    perf.end('decode')
    return
  }

  log('decodeAndBuffer', {
    pts: sample.pts,
    dts: sample.dts,
    duration: sample.duration,
    isKeyframe: sample.isKeyframe,
    dataSize: sample.data.byteLength,
    decoderState: decoder.state,
    decodeQueueSize: decoder.decodeQueueSize,
  })

  const chunk = new EncodedVideoChunk({
    type: sample.isKeyframe ? 'key' : 'delta',
    timestamp: sample.pts * 1_000_000,
    duration: sample.duration * 1_000_000,
    data: sample.data,
  })

  try {
    // Set up promise BEFORE decode (to avoid race condition)
    const framePromise = new Promise<VideoFrame>((resolve, reject) => {
      // Check if we already have a frame queued
      if (pendingFrames.length > 0) {
        resolve(pendingFrames.shift()!)
        return
      }

      // Set up timeout
      const timeoutId = setTimeout(() => {
        // Remove this resolver from queue
        const index = pendingFrameResolvers.findIndex(p => p.resolve === resolve)
        if (index !== -1) pendingFrameResolvers.splice(index, 1)
        reject(new Error('Decode timeout'))
      }, 5000)

      pendingFrameResolvers.push({
        resolve: frame => {
          clearTimeout(timeoutId)
          resolve(frame)
        },
        reject: error => {
          clearTimeout(timeoutId)
          reject(error)
        },
      })
    })

    // Now decode the chunk
    decoder.decode(chunk)

    // Wait for the frame
    const frame = await framePromise

    decoderReady = true
    log('decode success', { timestamp: frame.timestamp, duration: frame.duration })

    const data = await frameToData(frame, sample)

    // Insert in sorted order
    const insertIndex = frameBuffer.findIndex(f => f.timestamp > data.timestamp)
    if (insertIndex === -1) {
      frameBuffer.push(data)
    } else {
      frameBuffer.splice(insertIndex, 0, data)
    }

    bufferPosition = sample.pts + sample.duration

    // Trim old frames (keep max buffer size)
    while (frameBuffer.length > BUFFER_MAX_FRAMES) {
      frameBuffer.shift()
    }
    perf.end('decode')
  } catch (error) {
    perf.end('decode')
    log('decodeAndBuffer error', {
      error,
      errorMessage: error instanceof Error ? error.message : String(error),
      isKeyframe: sample.isKeyframe,
      pts: sample.pts,
      dataSize: sample.data.byteLength,
    })
    if (sample.isKeyframe) {
      decoderReady = false
    }
    // Re-throw to let caller handle
    throw error
  }
}

/** Buffer frames ahead of time */
async function bufferAhead(fromTime: number): Promise<void> {
  if (!videoSink || !videoTrack) return
  if (isBuffering) return // Prevent concurrent buffering

  const targetEnd = Math.min(fromTime + BUFFER_AHEAD_SECONDS, duration)
  if (bufferPosition >= targetEnd) return

  isBuffering = true
  perf.start('bufferAhead')
  log('bufferAhead', { fromTime, targetEnd, bufferPosition })

  try {
    // Get packet at current buffer position
    perf.start('demux')
    let packet = await videoSink.getPacket(bufferPosition)
    if (!packet) {
      packet = await videoSink.getFirstPacket()
    }
    perf.end('demux')

    let decoded = 0
    while (packet && packet.timestamp < targetEnd && decoded < BUFFER_AHEAD_FRAMES) {
      const sample = packetToSample(packet)
      try {
        await decodeAndBuffer(sample)
        decoded++
      } catch (error) {
        // Log but continue - try next packet
        log('bufferAhead: decode failed, skipping', { pts: sample.pts, error })
      }
      perf.start('demux')
      packet = await videoSink.getNextPacket(packet)
      perf.end('demux')
    }
  } catch (error) {
    log('bufferAhead error', { error })
  } finally {
    perf.end('bufferAhead')
    isBuffering = false
  }
}

/** Seek to time (from keyframe) */
async function seekToTime(time: number): Promise<void> {
  log('seekToTime', { time })

  // Clear buffer
  frameBuffer = []
  lastSentTimestamp = null
  isBuffering = false

  // Clear pending frame state
  for (const frame of pendingFrames) {
    frame.close()
  }
  pendingFrames = []
  // Reject any waiting resolvers
  for (const pending of pendingFrameResolvers) {
    pending.reject(new Error('Seek interrupted'))
  }
  pendingFrameResolvers = []

  // Reset decoder
  if (decoder && decoder.state !== 'closed') {
    decoder.reset()
    decoder.configure(videoConfig!)
  }
  decoderReady = false

  if (!videoSink) return

  // Find keyframe before target
  const keyPacket = await videoSink.getKeyPacket(time)
  bufferPosition = keyPacket?.timestamp ?? 0

  // Buffer from keyframe to target + ahead
  await bufferAhead(bufferPosition)
}

/** Get current media time from wall clock */
function getCurrentMediaTime(): number {
  if (!isPlaying) return startMediaTime
  const elapsed = (performance.now() - startWallTime) / 1000
  return startMediaTime + elapsed * speed
}

/** Send frame to compositor if needed */
function sendFrameToCompositor(time: number): void {
  if (!compositor) return

  const frameData = findFrameData(time)
  if (!frameData) {
    // No frame available - clear if we had one
    if (lastSentTimestamp !== null) {
      lastSentTimestamp = null
      compositor.setFrame(trackId, null)
    }
    return
  }

  // Skip if same frame
  if (frameData.timestamp === lastSentTimestamp) {
    return
  }

  // Create VideoFrame and transfer to compositor
  perf.start('transferFrame')
  const frame = dataToFrame(frameData)
  lastSentTimestamp = frameData.timestamp
  compositor.setFrame(trackId, transfer(frame))
  perf.end('transferFrame')
}

/** Trim frames that are too far behind current time */
function trimOldFrames(currentTime: number): void {
  // Keep a small amount of past frames for seeking back slightly
  const keepPastSeconds = 0.5
  const minTimestamp = (currentTime - keepPastSeconds) * 1_000_000

  while (frameBuffer.length > 1 && frameBuffer[0].timestamp < minTimestamp) {
    frameBuffer.shift()
  }
}

/** Main streaming loop */
function streamLoop(): void {
  if (!isPlaying) return

  const time = getCurrentMediaTime()

  // Check for end
  if (duration > 0 && time >= duration) {
    log('streamLoop: reached end', { time, duration })
    isPlaying = false
    state = 'paused'
    return
  }

  // Send frame to compositor
  sendFrameToCompositor(time)

  // Trim frames behind us to free memory
  trimOldFrames(time)

  // Buffer ahead
  bufferAhead(time)

  // Continue loop
  animationFrameId = requestAnimationFrame(streamLoop)
}

/** Start streaming loop */
function startStreamLoop(): void {
  if (animationFrameId !== null) return
  animationFrameId = requestAnimationFrame(streamLoop)
}

/** Stop streaming loop */
function stopStreamLoop(): void {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
}

expose<PlaybackWorkerMethods>({
  async load(buffer) {
    log('load', { size: buffer.byteLength })
    state = 'loading'

    // Clean up previous
    if (input) {
      input[Symbol.dispose]?.()
    }
    if (decoder && decoder.state !== 'closed') {
      decoder.close()
    }
    frameBuffer = []
    bufferPosition = 0
    decoderReady = false

    // Create input from buffer
    const blob = new Blob([buffer])
    input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    })

    // Get video track
    const videoTracks = await input.getVideoTracks()
    videoTrack = videoTracks[0] ?? null

    let videoTrackInfo: VideoTrackInfo | null = null

    if (videoTrack) {
      videoSink = new EncodedPacketSink(videoTrack)
      videoConfig = await videoTrack.getDecoderConfig()
      duration = await videoTrack.computeDuration()

      const config = videoConfig
      log('videoTrack info', {
        id: videoTrack.id,
        codedWidth: videoTrack.codedWidth,
        codedHeight: videoTrack.codedHeight,
        duration,
        videoConfig: config
          ? {
              codec: config.codec,
              codedWidth: config.codedWidth,
              codedHeight: config.codedHeight,
              hasDescription: !!config.description,
            }
          : null,
      })

      // Log first packet to understand timestamp units
      const firstPacket = await videoSink.getFirstPacket()
      if (firstPacket) {
        log('first packet', {
          timestamp: firstPacket.timestamp,
          duration: firstPacket.duration,
          type: firstPacket.type,
          dataSize: firstPacket.data.byteLength,
        })
      }

      const codecString = await videoTrack.getCodecParameterString()
      videoTrackInfo = {
        id: videoTrack.id,
        index: 0,
        codec: codecString ?? 'unknown',
        width: videoTrack.codedWidth,
        height: videoTrack.codedHeight,
        duration,
        timescale: 1,
        sampleCount: 0,
        bitrate: 0,
      }

      // Initialize decoder
      await initDecoder()
    }

    state = 'ready'
    log('load complete', { duration, hasVideo: !!videoTrack })

    return { duration, videoTrack: videoTrackInfo }
  },

  connectToCompositor(id, port) {
    log('connectToCompositor', { id })
    trackId = id
    compositor = rpc<CompositorFrameMethods>(port)
  },

  play(startTime, playbackSpeed = 1) {
    log('play', { startTime, playbackSpeed })

    startMediaTime = startTime
    startWallTime = performance.now()
    speed = playbackSpeed
    isPlaying = true
    state = 'playing'

    startStreamLoop()
  },

  pause() {
    log('pause')

    // Capture current position
    startMediaTime = getCurrentMediaTime()
    isPlaying = false
    state = 'paused'

    stopStreamLoop()
  },

  async seek(time) {
    log('seek', { time })
    const wasPlaying = isPlaying

    if (wasPlaying) {
      isPlaying = false
      stopStreamLoop()
    }

    state = 'seeking'
    await seekToTime(time)

    // Update position
    startMediaTime = time

    // Send frame at seek position
    sendFrameToCompositor(time)

    if (wasPlaying) {
      startWallTime = performance.now()
      isPlaying = true
      state = 'playing'
      startStreamLoop()
    } else {
      state = 'paused'
    }
  },

  getBufferRange() {
    if (frameBuffer.length === 0) {
      return { start: 0, end: 0 }
    }
    return {
      start: frameBuffer[0].timestamp / 1_000_000,
      end: frameBuffer[frameBuffer.length - 1].timestamp / 1_000_000,
    }
  },

  getState() {
    return state
  },

  getPerf() {
    return perf.getAllStats()
  },

  resetPerf() {
    perf.reset()
  },

  destroy() {
    log('destroy')

    stopStreamLoop()

    if (decoder && decoder.state !== 'closed') {
      decoder.close()
    }
    decoder = null

    if (input) {
      input[Symbol.dispose]?.()
      input = null
    }

    videoTrack = null
    videoSink = null
    videoConfig = null
    frameBuffer = []
    compositor = null
    state = 'idle'
  },
})
