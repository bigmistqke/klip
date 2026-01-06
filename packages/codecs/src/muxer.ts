/**
 * Video/Audio Muxer
 *
 * Encodes and muxes video/audio frames into WebM format using mediabunny.
 * Designed for progressive encoding - frames can be added one at a time.
 */

import { debug } from '@eddy/utils'
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny'

const log = debug('muxer', false)

export interface MuxerOptions {
  /** Video codec (default: 'vp9') */
  videoCodec?: 'vp8' | 'vp9' | 'av1'
  /** Video bitrate in bits/second (default: 2_000_000) */
  videoBitrate?: number
  /** Audio codec (default: 'opus') */
  audioCodec?: 'opus' | 'vorbis'
  /** Audio bitrate in bits/second (default: 128_000) */
  audioBitrate?: number
  /** Whether to include video track (default: true) */
  video?: boolean
  /** Whether to include audio track (default: false) */
  audio?: boolean
}

export interface VideoFrameData {
  /** Raw frame buffer */
  buffer: ArrayBuffer
  /** Pixel format */
  format: VideoPixelFormat
  /** Coded width */
  codedWidth: number
  /** Coded height */
  codedHeight: number
  /** Timestamp in seconds */
  timestamp: number
}

export interface AudioFrameData {
  /** Raw audio samples (Float32Array per channel) */
  data: Float32Array[]
  /** Sample rate */
  sampleRate: number
  /** Timestamp in seconds */
  timestamp: number
}

export interface Muxer {
  /** Whether the muxer is initialized and ready for frames */
  readonly isReady: boolean

  /** Number of video frames encoded */
  readonly videoFrameCount: number

  /** Number of audio frames encoded */
  readonly audioFrameCount: number

  /**
   * Initialize the muxer (creates encoder).
   * Must be called before adding frames.
   */
  init(): Promise<void>

  /**
   * Add a video frame to be encoded.
   * Frames are queued and processed as fast as possible.
   */
  addVideoFrame(data: VideoFrameData): void

  /**
   * Add audio samples to be encoded.
   */
  addAudioFrame(data: AudioFrameData): void

  /**
   * Finalize encoding and return the WebM blob.
   * Drains all queued frames before finalizing.
   */
  finalize(): Promise<{ blob: Blob; videoFrameCount: number; audioFrameCount: number }>

  /**
   * Reset state for next recording.
   * Must call init() again before adding frames.
   */
  reset(): void
}

/**
 * Create a muxer for encoding video/audio to WebM.
 */
export function createMuxer(options: MuxerOptions = {}): Muxer {
  const {
    videoCodec = 'vp9',
    videoBitrate = 2_000_000,
    audioCodec = 'opus',
    audioBitrate = 128_000,
    video = true,
    audio = false,
  } = options

  // State
  let output: Output | null = null
  let bufferTarget: BufferTarget | null = null
  let videoSource: VideoSampleSource | null = null
  let audioSource: AudioSampleSource | null = null
  let videoQueue: VideoFrameData[] = []
  let audioQueue: AudioFrameData[] = []
  let isProcessingVideo = false
  let isProcessingAudio = false
  let videoFrameCount = 0
  let audioFrameCount = 0
  let isReady = false

  async function processVideoQueue() {
    if (isProcessingVideo || !videoSource) return
    isProcessingVideo = true

    while (videoQueue.length > 0) {
      const { buffer, format, codedWidth, codedHeight, timestamp } = videoQueue.shift()!

      try {
        const frame = new VideoFrame(buffer, {
          format,
          codedWidth,
          codedHeight,
          timestamp: timestamp * 1_000_000,
        })

        const sample = new VideoSample(frame)
        sample.setTimestamp(timestamp)
        await videoSource.add(sample)
        sample[Symbol.dispose]?.()
        frame.close()

        videoFrameCount++
      } catch (err) {
        log('video encode error:', err)
      }
    }

    isProcessingVideo = false
  }

  async function processAudioQueue() {
    if (isProcessingAudio || !audioSource) return
    isProcessingAudio = true

    while (audioQueue.length > 0) {
      const { data, sampleRate, timestamp } = audioQueue.shift()!

      try {
        // Create AudioData from raw samples
        const numberOfChannels = data.length
        const numberOfFrames = data[0].length

        // Log first audio frame for debugging
        if (audioFrameCount === 0) {
          log('first audio frame to encode', {
            sampleRate,
            numberOfChannels,
            numberOfFrames,
            timestamp,
            dataLength: data.map(ch => ch.length),
          })
        }

        // Concatenate channels (planar format: all ch0 samples, then all ch1 samples, etc.)
        const planar = new Float32Array(numberOfChannels * numberOfFrames)
        for (let channel = 0; channel < numberOfChannels; channel++) {
          planar.set(data[channel], channel * numberOfFrames)
        }

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames,
          numberOfChannels,
          timestamp: timestamp * 1_000_000,
          data: planar,
        })

        const sample = new AudioSample(audioData)
        sample.setTimestamp(timestamp)
        await audioSource.add(sample)
        sample[Symbol.dispose]?.()
        audioData.close()

        audioFrameCount++
      } catch (err) {
        log('audio encode error:', err)
      }
    }

    isProcessingAudio = false
  }

  return {
    get isReady() {
      return isReady
    },

    get videoFrameCount() {
      return videoFrameCount
    },

    get audioFrameCount() {
      return audioFrameCount
    },

    async init() {
      if (isReady) return

      log('initializing muxer...')

      bufferTarget = new BufferTarget()
      output = new Output({ format: new WebMOutputFormat(), target: bufferTarget })

      if (video) {
        videoSource = new VideoSampleSource({ codec: videoCodec, bitrate: videoBitrate })
        output.addVideoTrack(videoSource)
      }

      if (audio) {
        audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: audioBitrate })
        output.addAudioTrack(audioSource)
      }

      await output.start()

      isReady = true
      log('muxer initialized')
    },

    addVideoFrame(data: VideoFrameData) {
      if (!isReady) {
        log('muxer not ready, dropping video frame')
        return
      }
      videoQueue.push(data)
      processVideoQueue()
    },

    addAudioFrame(data: AudioFrameData) {
      if (!isReady) {
        log('muxer not ready, dropping audio frame')
        return
      }
      audioQueue.push(data)
      processAudioQueue()
    },

    async finalize() {
      log('finalizing, video queue:', videoQueue.length, 'audio queue:', audioQueue.length)

      // Drain queues
      while (videoQueue.length > 0 || audioQueue.length > 0 || isProcessingVideo || isProcessingAudio) {
        if (videoQueue.length > 0 && !isProcessingVideo) {
          await processVideoQueue()
        }
        if (audioQueue.length > 0 && !isProcessingAudio) {
          await processAudioQueue()
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      let blob: Blob
      if (output && bufferTarget) {
        if (videoSource) await videoSource.close()
        if (audioSource) await audioSource.close()
        await output.finalize()

        const buffer = bufferTarget.buffer
        blob = buffer && buffer.byteLength > 0 ? new Blob([buffer], { type: 'video/webm' }) : new Blob()
      } else {
        blob = new Blob()
      }

      log('finalized:', videoFrameCount, 'video frames,', audioFrameCount, 'audio frames,', blob.size, 'bytes')

      return { blob, videoFrameCount, audioFrameCount }
    },

    reset() {
      videoQueue = []
      audioQueue = []
      videoFrameCount = 0
      audioFrameCount = 0
      isProcessingVideo = false
      isProcessingAudio = false
      isReady = false
      output = null
      bufferTarget = null
      videoSource = null
      audioSource = null
    },
  }
}
