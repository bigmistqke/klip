/**
 * Capture Worker
 *
 * Reads VideoFrames from camera stream, copies to ArrayBuffer, transfers to muxer.
 * Designed to release VideoFrame hardware resources immediately.
 *
 * Communication:
 * - Main thread: RPC via @bigmistqke/rpc (setMuxerPort, start, stop)
 * - Muxer worker: RPC via @bigmistqke/rpc on transferred MessagePort
 */

import { expose, rpc } from '@bigmistqke/rpc/messenger'
import type { VideoFrameData } from '@eddy/codecs'
import { debug } from '@eddy/utils'

const log = debug('capture-worker', false)

export interface CaptureWorkerMethods {
  /** Set the muxer port for forwarding frames (called before start) */
  setMuxerPort(port: MessagePort): void

  /**
   * Start capturing frames from a video stream.
   * Frames are forwarded to the muxer via MessagePort.
   */
  start(readable: ReadableStream<VideoFrame>): Promise<void>

  /** Stop capturing */
  stop(): void
}

/** Methods exposed by muxer on the capture port */
interface MuxerPortMethods {
  addVideoFrame(data: VideoFrameData): void
  captureEnded(frameCount: number): void
}

let capturing = false
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let muxer: ReturnType<typeof rpc<MuxerPortMethods>> | null = null

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

const methods: CaptureWorkerMethods = {
  setMuxerPort(port: MessagePort) {
    port.start()
    muxer = rpc<MuxerPortMethods>(port)
    log('received muxer port')
  },

  async start(readable: ReadableStream<VideoFrame>) {
    if (!muxer) {
      throw new Error('No muxer - call setMuxerPort first')
    }

    log('starting')
    capturing = true
    reader = readable.getReader()

    let firstTimestamp: number | null = null
    let frameCount = 0

    try {
      // Read first frame
      const { done: done1, value: frame1 } = await reader.read()
      if (done1 || !frame1) {
        throw new Error('No frames available')
      }

      // Read second frame to check for staleness
      const { done: done2, value: frame2 } = await reader.read()
      if (done2 || !frame2) {
        // Only got one frame, use it
        firstTimestamp = frame1.timestamp
        const data = await copyFrameToBuffer(frame1)
        muxer.addVideoFrame({ ...data, timestamp: 0 })
        frameCount++
      } else {
        // Check gap between frame1 and frame2
        const gap = (frame2.timestamp - frame1.timestamp) / 1_000_000

        if (gap > 0.5) {
          // Frame1 is stale - discard it, use frame2 as first
          log('discarding stale frame', { gap: gap.toFixed(3) })
          frame1.close()
          firstTimestamp = frame2.timestamp
          const data = await copyFrameToBuffer(frame2)
          muxer.addVideoFrame({ ...data, timestamp: 0 })
          frameCount++
        } else {
          // Frame1 is valid - use both
          firstTimestamp = frame1.timestamp
          const data1 = await copyFrameToBuffer(frame1)
          muxer.addVideoFrame({ ...data1, timestamp: 0 })
          frameCount++

          const timestamp2 = (frame2.timestamp - firstTimestamp) / 1_000_000
          const data2 = await copyFrameToBuffer(frame2)
          muxer.addVideoFrame({ ...data2, timestamp: timestamp2 })
          frameCount++
        }
      }

      // Continue with remaining frames
      while (capturing) {
        const { done, value: frame } = await reader.read()
        if (done || !frame) break

        const timestamp = (frame.timestamp - firstTimestamp!) / 1_000_000
        const data = await copyFrameToBuffer(frame)
        muxer.addVideoFrame({ ...data, timestamp })
        frameCount++
      }
    } catch (err) {
      log('error', err)
      throw err
    }

    // Signal end of stream
    muxer.captureEnded(frameCount)
    log('done', { frameCount })
  },

  stop() {
    capturing = false
    reader?.cancel().catch(() => {})
    log('stop')
  },
}

expose(methods)
