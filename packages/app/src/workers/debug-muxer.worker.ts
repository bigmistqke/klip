import { expose } from '@bigmistqke/rpc/messenger'
import { debug } from '@eddy/utils'
import { BufferTarget, Output, VideoSample, VideoSampleSource, WebMOutputFormat } from 'mediabunny'

const log = debug('debug-muxer', true)

export interface MuxerInitConfig {
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
}

export interface MuxerFrameData {
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
  timestampSec: number
}

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
   * Initialize with format info from first frame.
   * If preInit was called, this just stores the format.
   */
  init(config: MuxerInitConfig): Promise<void>

  /**
   * Add a frame to be encoded.
   * Frames are queued and processed as fast as possible.
   */
  addFrame(data: MuxerFrameData): void

  /**
   * Signal end of stream and finalize the output.
   * Returns the encoded WebM blob.
   */
  finalize(): Promise<{ blob: Blob; frameCount: number }>

  /** Reset state for next recording */
  reset(): void
}

/**********************************************************************************/
/*                                                                                */
/*                                     Methods                                    */
/*                                                                                */
/**********************************************************************************/

// Worker state
let output: Output | null = null
let bufferTarget: BufferTarget | null = null
let videoSource: VideoSampleSource | null = null
let frameQueue: MuxerFrameData[] = []
let isProcessing = false
let encodedCount = 0
let isPreInitialized = false
let capturedFrameCount = 0

async function processQueue() {
  if (isProcessing || !videoSource) return
  isProcessing = true

  while (frameQueue.length > 0) {
    const { buffer, format, codedWidth, codedHeight, timestampSec } = frameQueue.shift()!

    try {
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
    } catch (err) {
      log('encode error:', err)
    }
  }

  isProcessing = false
}

async function init(config: MuxerInitConfig) {
  // If not pre-initialized, do full init now
  if (!isPreInitialized) {
    log('initializing (not pre-initialized)...')
    bufferTarget = new BufferTarget()
    output = new Output({ format: new WebMOutputFormat(), target: bufferTarget })
    videoSource = new VideoSampleSource({ codec: 'vp9', bitrate: 2_000_000 })
    output.addVideoTrack(videoSource)
    await output.start()
  }

  log('init complete, format:', config.format, config.codedWidth, 'x', config.codedHeight)
}

function addFrame(data: MuxerFrameData) {
  frameQueue.push(data)
  processQueue()
}

expose<MuxerWorkerMethods>({
  init,
  addFrame,

  setCapturePort(port: MessagePort) {
    log('received capture port, exposing methods on it')
    // Expose a subset of methods on this port for capture worker to call via RPC
    expose(
      {
        init,
        addFrame,
        captureEnded: (frameCount: number) => {
          capturedFrameCount = frameCount
          log('capture ended, frameCount:', capturedFrameCount)
        },
      },
      { to: port },
    )
  },

  async preInit() {
    if (isPreInitialized) return

    log('pre-initializing VP9 encoder...')

    bufferTarget = new BufferTarget()
    output = new Output({ format: new WebMOutputFormat(), target: bufferTarget })
    videoSource = new VideoSampleSource({ codec: 'vp9', bitrate: 2_000_000 })
    output.addVideoTrack(videoSource)
    await output.start()

    isPreInitialized = true
    log('pre-initialization complete')
  },

  async finalize() {
    console.log(
      '[debug-muxer] finalizing, queue:',
      frameQueue.length,
      'captured:',
      capturedFrameCount,
    )

    // Drain queue
    while (frameQueue.length > 0 || isProcessing) {
      if (frameQueue.length > 0 && !isProcessing) {
        await processQueue()
      }
      await new Promise(r => setTimeout(r, 10))
    }

    let blob: Blob
    if (output && bufferTarget) {
      if (videoSource) await videoSource.close()
      await output.finalize()

      const buffer = bufferTarget.buffer
      blob =
        buffer && buffer.byteLength > 0 ? new Blob([buffer], { type: 'video/webm' }) : new Blob()
    } else {
      blob = new Blob()
    }

    const frameCount = encodedCount
    log('finalized:', frameCount, 'frames,', blob.size, 'bytes')

    return { blob, frameCount }
  },

  reset() {
    frameQueue = []
    encodedCount = 0
    capturedFrameCount = 0
    isProcessing = false
    isPreInitialized = false
    output = null
    bufferTarget = null
    videoSource = null
  },
})
