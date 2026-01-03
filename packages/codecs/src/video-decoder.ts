import { debug } from '@klip/utils'
import type { DemuxedSample, Demuxer, VideoTrackInfo } from './demuxer'

const log = debug('video-decoder', true)

export interface VideoDecoderHandle {
  readonly config: VideoDecoderConfig
  readonly decoder: VideoDecoder

  /**
   * Decode a single sample and return the resulting VideoFrame
   * The caller is responsible for closing the VideoFrame when done
   */
  decode(sample: DemuxedSample): Promise<VideoFrame>

  /**
   * Decode multiple samples and return all resulting VideoFrames
   * The caller is responsible for closing all VideoFrames when done
   */
  decodeAll(samples: DemuxedSample[]): Promise<VideoFrame[]>

  /**
   * Flush the decoder to ensure all pending frames are output
   */
  flush(): Promise<void>

  /**
   * Reset the decoder state (useful for seeking)
   */
  reset(): Promise<void>

  /**
   * Close the decoder and release resources
   */
  close(): void
}

export interface CreateVideoDecoderOptions {
  /**
   * Called when a frame is decoded
   * If not provided, frames are collected internally
   */
  onFrame?: (frame: VideoFrame) => void

  /**
   * Called when a decode error occurs
   */
  onError?: (error: DOMException) => void

  /**
   * Hardware acceleration preference
   */
  hardwareAcceleration?: HardwareAcceleration
}

/**
 * Create a VideoDecoder for a video track
 */
export async function createVideoDecoder(
  demuxer: Demuxer,
  _trackInfo: VideoTrackInfo,
  options: CreateVideoDecoderOptions = {}
): Promise<VideoDecoderHandle> {
  log('createVideoDecoder')

  // Get config from demuxer
  const config = await demuxer.getVideoConfig()
  log('got config', { codec: config.codec, width: config.codedWidth, height: config.codedHeight })

  // Check if the codec is supported
  const support = await VideoDecoder.isConfigSupported({
    ...config,
    hardwareAcceleration: options.hardwareAcceleration,
  })

  if (!support.supported) {
    throw new Error(`Codec ${config.codec} is not supported`)
  }

  // Frame collection for batch decoding
  let pendingFrames: VideoFrame[] = []
  let decodeResolvers: Array<(frame: VideoFrame) => void> = []
  let errorHandler: ((error: DOMException) => void) | undefined = options.onError

  const decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      if (options.onFrame) {
        options.onFrame(frame)
      } else if (decodeResolvers.length > 0) {
        const resolver = decodeResolvers.shift()!
        resolver(frame)
      } else {
        pendingFrames.push(frame)
      }
    },
    error: (error: DOMException) => {
      if (errorHandler) {
        errorHandler(error)
      } else {
        console.error('VideoDecoder error:', error)
      }
    },
  })

  decoder.configure({
    ...config,
    hardwareAcceleration: options.hardwareAcceleration,
  })

  return {
    config,
    decoder,

    async decode(sample: DemuxedSample): Promise<VideoFrame> {
      // Check if decoder is in a usable state
      if (decoder.state === 'closed') {
        throw new Error('VideoDecoder is closed')
      }

      const chunk = new EncodedVideoChunk({
        type: sample.isKeyframe ? 'key' : 'delta',
        timestamp: sample.pts * 1_000_000, // Convert to microseconds
        duration: sample.duration * 1_000_000,
        data: sample.data,
      })

      // If we have a pending frame, return it
      if (pendingFrames.length > 0) {
        decoder.decode(chunk)
        return pendingFrames.shift()!
      }

      // Otherwise, wait for the frame
      return new Promise((resolve, reject) => {
        const originalErrorHandler = errorHandler
        errorHandler = (error) => {
          errorHandler = originalErrorHandler
          reject(error)
        }
        decodeResolvers.push((frame) => {
          errorHandler = originalErrorHandler
          resolve(frame)
        })
        decoder.decode(chunk)
      })
    },

    async decodeAll(samples: DemuxedSample[]): Promise<VideoFrame[]> {
      const frames: VideoFrame[] = []

      // Decode all samples
      for (const sample of samples) {
        const chunk = new EncodedVideoChunk({
          type: sample.isKeyframe ? 'key' : 'delta',
          timestamp: sample.pts * 1_000_000,
          duration: sample.duration * 1_000_000,
          data: sample.data,
        })
        decoder.decode(chunk)
      }

      // Flush to ensure all frames are output
      await decoder.flush()

      // Collect all pending frames
      frames.push(...pendingFrames)
      pendingFrames = []

      return frames
    },

    async flush(): Promise<void> {
      if (decoder.state === 'closed') return
      await decoder.flush()
    },

    async reset(): Promise<void> {
      if (decoder.state === 'closed') return
      decoder.reset()
      // Re-configure after reset
      decoder.configure({
        ...config,
        hardwareAcceleration: options.hardwareAcceleration,
      })
      // Clear any pending frames
      for (const frame of pendingFrames) {
        frame.close()
      }
      pendingFrames = []
      decodeResolvers = []
    },

    close(): void {
      if (decoder.state === 'closed') return
      decoder.close()
      // Close any remaining frames
      for (const frame of pendingFrames) {
        frame.close()
      }
      pendingFrames = []
      decodeResolvers = []
    },
  }
}

/**
 * Check if WebCodecs VideoDecoder is available
 */
export function isVideoDecoderSupported(): boolean {
  return typeof VideoDecoder !== 'undefined'
}

/**
 * Check if a specific codec is supported
 */
export async function isVideoCodecSupported(codec: string): Promise<boolean> {
  if (!isVideoDecoderSupported()) {
    return false
  }

  try {
    const support = await VideoDecoder.isConfigSupported({
      codec,
      codedWidth: 1920,
      codedHeight: 1080,
    })
    return support.supported === true
  } catch {
    return false
  }
}
