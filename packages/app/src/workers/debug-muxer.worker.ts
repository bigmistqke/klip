/**
 * Muxer Worker: Receives frame buffers, queues them, muxes to WebM.
 *
 * This worker processes frames at whatever speed it can. Blocking is fine here
 * since it doesn't affect capture rate (that happens in the capture worker).
 */

import {
  BufferTarget,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny'

interface MuxerInitMessage {
  type: 'init'
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
}

interface MuxerFrameMessage {
  type: 'frame'
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
  timestampSec: number
}

interface MuxerEndMessage {
  type: 'end'
  frameCount: number
}

type MuxerMessage = MuxerInitMessage | MuxerFrameMessage | MuxerEndMessage

interface QueuedFrame {
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
  timestampSec: number
}

let output: Output | null = null
let bufferTarget: BufferTarget | null = null
let videoSource: VideoSampleSource | null = null
let frameQueue: QueuedFrame[] = []
let isProcessing = false
let streamEnded = false
let encodedCount = 0

let lastTimestamp = -1

async function processQueue() {
  if (isProcessing || !videoSource) return
  isProcessing = true

  while (frameQueue.length > 0) {
    const { buffer, format, codedWidth, codedHeight, timestampSec } = frameQueue.shift()!

    // Log first few frames and any timestamp gaps
    const gap = lastTimestamp >= 0 ? timestampSec - lastTimestamp : 0
    if (encodedCount < 5 || gap > 0.1) {
      self.postMessage({
        type: 'debug',
        message: `frame ${encodedCount}: ts=${timestampSec.toFixed(3)}s, gap=${(gap * 1000).toFixed(0)}ms`
      })
    }
    lastTimestamp = timestampSec

    try {
      // Recreate VideoFrame from buffer with original timestamp and format
      const frame = new VideoFrame(buffer, {
        format,
        codedWidth,
        codedHeight,
        timestamp: timestampSec * 1_000_000,
      })

      const sample = new VideoSample(frame)
      sample.setTimestamp(timestampSec)
      await videoSource.add(sample)
      sample[Symbol.dispose]?.()
      frame.close()

      encodedCount++

      // Report progress periodically
      if (encodedCount % 30 === 0) {
        self.postMessage({ type: 'progress', encoded: encodedCount, queued: frameQueue.length })
      }
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) })
    }
  }

  isProcessing = false

  // If stream ended and queue is empty, finalize
  if (streamEnded && frameQueue.length === 0) {
    await finalize()
  }
}

async function finalize() {
  if (!output || !bufferTarget) return

  try {
    if (videoSource) await videoSource.close()
    await output.finalize()

    const buffer = bufferTarget.buffer
    if (buffer && buffer.byteLength > 0) {
      // Transfer the final buffer back to main thread
      postMessage({ type: 'complete', buffer, encodedCount }, { transfer: [buffer] })
    } else {
      self.postMessage({ type: 'error', error: 'No output data' })
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err) })
  }

  output = null
  bufferTarget = null
  videoSource = null
}

let capturePort: MessagePort | null = null

// Handle messages from capture worker via MessagePort
async function handleCaptureMessage(msg: MuxerMessage) {
  if (msg.type === 'init') {
    // Initialize muxer on first frame info
    bufferTarget = new BufferTarget()
    output = new Output({ format: new WebMOutputFormat(), target: bufferTarget })
    videoSource = new VideoSampleSource({ codec: 'vp9', bitrate: 2_000_000 })
    output.addVideoTrack(videoSource)
    await output.start()

    self.postMessage({ type: 'started', queued: frameQueue.length })

    // Process any frames that queued during initialization
    processQueue()
  }

  if (msg.type === 'frame') {
    frameQueue.push({
      buffer: msg.buffer,
      format: msg.format,
      codedWidth: msg.codedWidth,
      codedHeight: msg.codedHeight,
      timestampSec: msg.timestampSec,
    })
    processQueue()
  }

  if (msg.type === 'end') {
    streamEnded = true
    self.postMessage({ type: 'draining', queued: frameQueue.length, captured: msg.frameCount })
    // If queue is already empty, finalize now
    if (frameQueue.length === 0 && !isProcessing) {
      finalize()
    }
  }
}

// Main thread sends us the MessagePort to receive from capture worker
self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'port') {
    capturePort = e.data.port as MessagePort
    capturePort.onmessage = (ev: MessageEvent<MuxerMessage>) => handleCaptureMessage(ev.data)
  }

  if (e.data.type === 'reset') {
    frameQueue = []
    streamEnded = false
    encodedCount = 0
    isProcessing = false
    lastTimestamp = -1
  }
}
