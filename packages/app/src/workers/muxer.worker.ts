/**
 * Muxer Worker
 *
 * Handles video encoding and muxing off the main thread.
 * Uses @eddy/codecs muxer for VP9 encoding to WebM format.
 *
 * Communication:
 * - Main thread: RPC via @bigmistqke/rpc (preInit, finalize, reset)
 * - Capture worker: Raw messages via transferred MessagePort (addVideoFrame, captureEnded)
 *
 * Supports pre-initialization to avoid ~2s encoder startup during recording.
 */

import { expose } from '@bigmistqke/rpc/messenger'
import { createMuxer, type Muxer, type VideoFrameData } from '@eddy/codecs'
import { debug } from '@eddy/utils'

const log = debug('muxer-worker', false)

export interface MuxerWorkerMethods {
  /**
   * Set the capture port for receiving frames from capture worker.
   * Call this before recording.
   */
  setCapturePort(port: MessagePort): void

  /**
   * Pre-initialize the muxer (creates VP9 encoder).
   * Call this before recording to avoid startup delay.
   */
  preInit(): Promise<void>

  /**
   * Add a video frame to be encoded.
   * Frames are queued and processed as fast as possible.
   */
  addVideoFrame(data: VideoFrameData): void

  /**
   * Signal end of stream and finalize the output.
   * Returns the encoded WebM blob.
   */
  finalize(): Promise<{ blob: Blob; frameCount: number }>

  /** Reset state for next recording */
  reset(): void
}

// Worker state
let muxer: Muxer | null = null
let capturedFrameCount = 0

const methods: MuxerWorkerMethods = {
  setCapturePort(port: MessagePort) {
    log('received capture port')
    // Expose methods on this port for capture worker to call
    expose(
      {
        addVideoFrame: methods.addVideoFrame,
        captureEnded: (frameCount: number) => {
          capturedFrameCount = frameCount
          log('capture ended', { frameCount: capturedFrameCount })
        },
      },
      { to: port },
    )
  },

  async preInit() {
    if (muxer?.isReady) return

    log('pre-initializing VP9 encoder...')
    muxer = createMuxer({ videoCodec: 'vp9', videoBitrate: 2_000_000 })
    await muxer.init()
    log('pre-initialization complete')
  },

  addVideoFrame(data: VideoFrameData) {
    if (!muxer) {
      log('not initialized, dropping frame')
      return
    }
    muxer.addVideoFrame(data)
  },

  async finalize() {
    log('finalizing', { captured: capturedFrameCount })

    if (!muxer) {
      return { blob: new Blob(), frameCount: 0 }
    }

    const result = await muxer.finalize()
    log('finalized', { frames: result.videoFrameCount, bytes: result.blob.size })

    return { blob: result.blob, frameCount: result.videoFrameCount }
  },

  reset() {
    capturedFrameCount = 0
    muxer?.reset()
    muxer = null
  },
}

expose(methods)
