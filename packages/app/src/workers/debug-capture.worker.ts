/**
 * Capture Worker: Reads VideoFrames from camera stream, copies to ArrayBuffer, transfers to muxer.
 *
 * This worker's only job is to capture frames as fast as possible and release
 * VideoFrame hardware resources immediately. It does NOT wait for muxer - just queues everything.
 */

interface CaptureStartMessage {
  type: 'start'
  readable: ReadableStream<VideoFrame>
}

interface CapturePingMessage {
  type: 'ping'
  muxerPort: MessagePort
}

interface CaptureStopMessage {
  type: 'stop'
}

type CaptureMessage = CaptureStartMessage | CapturePingMessage | CaptureStopMessage

let capturing = false
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let muxerPort: MessagePort | null = null

async function copyFrameToBuffer(frame: VideoFrame): Promise<{
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
}> {
  const format = frame.format!
  const codedWidth = frame.codedWidth
  const codedHeight = frame.codedHeight
  const buffer = new ArrayBuffer(frame.allocationSize())
  await frame.copyTo(buffer)
  frame.close()
  return { buffer, format, codedWidth, codedHeight }
}

self.onmessage = async (e: MessageEvent<CaptureMessage>) => {
  const msg = e.data

  // Ping message - worker is ready, store muxer port and respond
  if (msg.type === 'ping') {
    muxerPort = msg.muxerPort
    self.postMessage({ type: 'ready' })
    return
  }

  if (msg.type === 'start') {
    if (!muxerPort) {
      self.postMessage({ type: 'error', error: 'No muxer port - call ping first' })
      return
    }

    self.postMessage({ type: 'debug', message: 'start received, beginning capture' })

    capturing = true
    const { readable } = msg

    reader = readable.getReader()

    let firstTimestamp: number | null = null
    let frameCount = 0

    try {
      // Read first frame
      const { done: done1, value: frame1 } = await reader.read()
      if (done1 || !frame1) {
        self.postMessage({ type: 'error', error: 'No frames available' })
        return
      }

      // Read second frame to check for staleness
      const { done: done2, value: frame2 } = await reader.read()
      if (done2 || !frame2) {
        // Only got one frame, use it
        firstTimestamp = frame1.timestamp
        const data = await copyFrameToBuffer(frame1)
        muxerPort.postMessage({ type: 'init', format: data.format, codedWidth: data.codedWidth, codedHeight: data.codedHeight })
        muxerPort.postMessage({ type: 'frame', ...data, timestampSec: 0 }, [data.buffer])
        frameCount++
        self.postMessage({ type: 'capturing', message: 'Capturing frames' })
      } else {
        // Check gap between frame1 and frame2
        const gap = (frame2.timestamp - frame1.timestamp) / 1_000_000

        if (gap > 0.5) {
          // Frame1 is stale - discard it, use frame2 as first
          self.postMessage({ type: 'debug', message: `discarding stale frame, gap=${gap.toFixed(3)}s` })
          frame1.close()
          firstTimestamp = frame2.timestamp
          const data = await copyFrameToBuffer(frame2)
          muxerPort.postMessage({ type: 'init', format: data.format, codedWidth: data.codedWidth, codedHeight: data.codedHeight })
          muxerPort.postMessage({ type: 'frame', ...data, timestampSec: 0 }, [data.buffer])
          frameCount++
        } else {
          // Frame1 is valid - use it as first, then process frame2
          firstTimestamp = frame1.timestamp
          const data1 = await copyFrameToBuffer(frame1)
          muxerPort.postMessage({ type: 'init', format: data1.format, codedWidth: data1.codedWidth, codedHeight: data1.codedHeight })
          muxerPort.postMessage({ type: 'frame', ...data1, timestampSec: 0 }, [data1.buffer])
          frameCount++

          const timestampSec2 = (frame2.timestamp - firstTimestamp) / 1_000_000
          const data2 = await copyFrameToBuffer(frame2)
          muxerPort.postMessage({ type: 'frame', ...data2, timestampSec: timestampSec2 }, [data2.buffer])
          frameCount++
        }
        self.postMessage({ type: 'debug', message: `first frame ts=${(firstTimestamp/1_000_000).toFixed(3)}s` })
        self.postMessage({ type: 'capturing', message: 'Capturing frames' })
      }

      // Continue with remaining frames
      while (capturing) {
        const { done, value: frame } = await reader.read()
        if (done || !frame) break

        const timestampSec = (frame.timestamp - firstTimestamp) / 1_000_000
        const data = await copyFrameToBuffer(frame)
        muxerPort.postMessage({ type: 'frame', ...data, timestampSec }, [data.buffer])
        frameCount++
      }
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) })
    }

    // Signal end of stream
    muxerPort.postMessage({ type: 'end', frameCount })
    self.postMessage({ type: 'done', frameCount })
  }

  if (msg.type === 'stop') {
    capturing = false
    reader?.cancel().catch(() => {})
  }
}
