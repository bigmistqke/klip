import { DataStream, MP4BoxBuffer, Endianness, type Sample, type SampleEntry, type Box } from 'mp4box'
import type { DemuxedSample, VideoTrackInfo, Demuxer } from './demuxer'

/** Codec configuration extracted from mp4box sample description */
export interface CodecConfig {
  codec: string
  codedWidth: number
  codedHeight: number
  description?: ArrayBuffer
}

type VisualSampleEntry = SampleEntry & {
  width: number
  height: number
  avcC?: Box & { write(stream: DataStream): void }
  hvcC?: Box & { write(stream: DataStream): void }
  av1C?: Box & { write(stream: DataStream): void }
  vvcC?: Box & { write(stream: DataStream): void }
  vpcC?: Box & { write(stream: DataStream): void }
  getCodec(): string
}

/**
 * Extract codec configuration from a video track's sample description
 * This is needed to configure the WebCodecs VideoDecoder
 */
export function getCodecConfig(
  demuxer: Demuxer,
  trackInfo: VideoTrackInfo
): CodecConfig {
  // Get the track from the file to access sample descriptions
  const track = demuxer.file.getTrackById(trackInfo.id)
  if (!track) {
    throw new Error(`Track ${trackInfo.id} not found in file`)
  }

  // Get the sample description (stsd entry)
  const stsd = track.mdia?.minf?.stbl?.stsd
  if (!stsd || !stsd.entries || stsd.entries.length === 0) {
    throw new Error(`No sample description found for track ${trackInfo.id}`)
  }

  const sampleEntry = stsd.entries[0] as VisualSampleEntry
  const codec = sampleEntry.getCodec()

  const config: CodecConfig = {
    codec,
    codedWidth: sampleEntry.width,
    codedHeight: sampleEntry.height,
  }

  // Extract decoder-specific configuration (avcC, hvcC, etc.)
  const configBox = sampleEntry.avcC || sampleEntry.hvcC || sampleEntry.av1C || sampleEntry.vvcC || sampleEntry.vpcC

  if (configBox) {
    config.description = serializeBox(configBox)
  }

  return config
}

/**
 * Serialize a box to an ArrayBuffer
 */
function serializeBox(box: Box & { write(stream: DataStream): void }): ArrayBuffer {
  // Create a DataStream to write to
  // We need to estimate the size - most codec configs are under 1KB
  const buffer = MP4BoxBuffer.fromArrayBuffer(new ArrayBuffer(1024), 0)
  const stream = new DataStream(buffer, 0, Endianness.BIG_ENDIAN)

  // Write the box
  box.write(stream)

  // Return only the written portion
  return buffer.slice(0, stream.getPosition())
}

export interface VideoDecoderHandle {
  readonly config: CodecConfig
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
  trackInfo: VideoTrackInfo,
  options: CreateVideoDecoderOptions = {}
): Promise<VideoDecoderHandle> {
  const config = getCodecConfig(demuxer, trackInfo)

  // Check if the codec is supported
  const support = await VideoDecoder.isConfigSupported({
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
    description: config.description,
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
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
    description: config.description,
    hardwareAcceleration: options.hardwareAcceleration,
  })

  return {
    config,
    decoder,

    async decode(sample: DemuxedSample): Promise<VideoFrame> {
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
      await decoder.flush()
    },

    async reset(): Promise<void> {
      decoder.reset()
      // Re-configure after reset
      decoder.configure({
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        description: config.description,
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
export async function isCodecSupported(codec: string): Promise<boolean> {
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
