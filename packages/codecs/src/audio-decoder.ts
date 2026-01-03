import { debug } from '@eddy/utils'
import type { AudioTrackInfo, DemuxedSample, Demuxer } from './demuxer'

const log = debug('audio-decoder', true)

export interface AudioDecoderHandle {
  readonly config: AudioDecoderConfig
  readonly decoder: AudioDecoder

  /**
   * Decode a single sample and return the resulting AudioData
   * The caller is responsible for closing the AudioData when done
   */
  decode(sample: DemuxedSample): Promise<AudioData>

  /**
   * Decode multiple samples and return all resulting AudioData
   * The caller is responsible for closing all AudioData when done
   */
  decodeAll(samples: DemuxedSample[]): Promise<AudioData[]>

  /**
   * Flush the decoder to ensure all pending data is output
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

export interface CreateAudioDecoderOptions {
  /**
   * Called when audio data is decoded
   * If not provided, data is collected internally
   */
  onData?: (data: AudioData) => void

  /**
   * Called when a decode error occurs
   */
  onError?: (error: DOMException) => void
}

/**
 * Create an AudioDecoder for an audio track
 */
export async function createAudioDecoder(
  demuxer: Demuxer,
  _trackInfo: AudioTrackInfo,
  options: CreateAudioDecoderOptions = {},
): Promise<AudioDecoderHandle> {
  log('createAudioDecoder')

  // Get config from demuxer
  const config = await demuxer.getAudioConfig()
  log('got config', {
    codec: config.codec,
    sampleRate: config.sampleRate,
    channels: config.numberOfChannels,
  })

  // Check if the codec is supported
  const support = await AudioDecoder.isConfigSupported(config)

  if (!support.supported) {
    throw new Error(`Audio codec ${config.codec} is not supported`)
  }

  // Audio data collection for batch decoding
  let pendingData: AudioData[] = []
  let decodeResolvers: Array<(data: AudioData) => void> = []
  let errorHandler: ((error: DOMException) => void) | undefined = options.onError

  const decoder = new AudioDecoder({
    output: (data: AudioData) => {
      if (options.onData) {
        options.onData(data)
      } else if (decodeResolvers.length > 0) {
        const resolver = decodeResolvers.shift()!
        resolver(data)
      } else {
        pendingData.push(data)
      }
    },
    error: (error: DOMException) => {
      if (errorHandler) {
        errorHandler(error)
      } else {
        console.error('AudioDecoder error:', error)
      }
    },
  })

  decoder.configure(config)

  return {
    config,
    decoder,

    async decode(sample: DemuxedSample): Promise<AudioData> {
      const chunk = new EncodedAudioChunk({
        type: 'key', // Audio chunks are typically all keyframes
        timestamp: sample.pts * 1_000_000, // Convert to microseconds
        duration: sample.duration * 1_000_000,
        data: sample.data,
      })

      // If we have pending data, return it
      if (pendingData.length > 0) {
        decoder.decode(chunk)
        return pendingData.shift()!
      }

      // Otherwise, wait for the data
      return new Promise((resolve, reject) => {
        const originalErrorHandler = errorHandler
        errorHandler = error => {
          errorHandler = originalErrorHandler
          reject(error)
        }
        decodeResolvers.push(data => {
          errorHandler = originalErrorHandler
          resolve(data)
        })
        decoder.decode(chunk)
      })
    },

    async decodeAll(samples: DemuxedSample[]): Promise<AudioData[]> {
      const results: AudioData[] = []

      // Decode all samples
      for (const sample of samples) {
        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: sample.pts * 1_000_000,
          duration: sample.duration * 1_000_000,
          data: sample.data,
        })
        decoder.decode(chunk)
      }

      // Flush to ensure all data is output
      await decoder.flush()

      // Collect all pending data
      results.push(...pendingData)
      pendingData = []

      return results
    },

    async flush(): Promise<void> {
      await decoder.flush()
    },

    async reset(): Promise<void> {
      decoder.reset()
      // Re-configure after reset
      decoder.configure(config)
      // Clear any pending data
      for (const data of pendingData) {
        data.close()
      }
      pendingData = []
      decodeResolvers = []
    },

    close(): void {
      decoder.close()
      // Close any remaining data
      for (const data of pendingData) {
        data.close()
      }
      pendingData = []
      decodeResolvers = []
    },
  }
}

/**
 * Check if WebCodecs AudioDecoder is available
 */
export function isAudioDecoderSupported(): boolean {
  return typeof AudioDecoder !== 'undefined'
}

/**
 * Check if a specific audio codec is supported
 */
export async function isAudioCodecSupported(codec: string): Promise<boolean> {
  if (!isAudioDecoderSupported()) {
    return false
  }

  try {
    const support = await AudioDecoder.isConfigSupported({
      codec,
      sampleRate: 48000,
      numberOfChannels: 2,
    })
    return support.supported === true
  } catch {
    return false
  }
}
