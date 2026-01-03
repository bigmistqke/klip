/**
 * Recording Worker
 *
 * Handles video/audio encoding and muxing off the main thread.
 * Receives MediaStreamTrackProcessor streams and encodes with mediabunny.
 * Outputs WebM format.
 */

import { expose, transfer } from '@bigmistqke/rpc/messenger'
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny'
import type { RecordingStartConfig, RecordingWorkerMethods } from './types'

import { debug } from '@eddy/utils'

const log = debug('recording-worker', true)

// Worker state
let output: Output | null = null
let bufferTarget: BufferTarget | null = null
let videoSource: VideoSampleSource | null = null
let audioSource: AudioSampleSource | null = null
let videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null
let audioReader: ReadableStreamDefaultReader<AudioData> | null = null
let firstFrame: VideoFrame | null = null
let isRecording = false
let startTime = 0

let videoFrameCount = 0
let audioSampleCount = 0
let firstVideoTimestamp: number | null = null
let firstAudioTimestamp: number | null = null

async function processVideoStream(stream: ReadableStream<VideoFrame>) {
  log('processVideoStream: starting')
  videoReader = stream.getReader()

  try {
    while (isRecording) {
      const { done, value: frame } = await videoReader.read()
      if (done) {
        log('processVideoStream: stream done')
        break
      }
      if (!frame) {
        log('processVideoStream: null frame received')
        break
      }

      // Normalize timestamp to start from 0
      if (firstVideoTimestamp === null) {
        firstVideoTimestamp = frame.timestamp
        log('processVideoStream: first timestamp captured', { firstVideoTimestamp })
      }
      const normalizedTimestamp = frame.timestamp - firstVideoTimestamp

      videoFrameCount++
      if (videoFrameCount === 1 || videoFrameCount % 30 === 0) {
        log('processVideoStream: frame', {
          count: videoFrameCount,
          originalTimestamp: frame.timestamp,
          normalizedTimestamp,
          duration: frame.duration,
          width: frame.displayWidth,
          height: frame.displayHeight,
        })
      }

      // Capture first frame for preview (clone it since we'll close the original)
      if (!firstFrame) {
        log('processVideoStream: capturing first frame')
        firstFrame = frame.clone()
      }

      // Add frame to mediabunny output with normalized timestamp
      if (videoSource) {
        const sample = new VideoSample(frame)
        sample.setTimestamp(normalizedTimestamp / 1_000_000) // microseconds to seconds
        await videoSource.add(sample)
        sample[Symbol.dispose]?.()
      }

      frame.close()
    }
  } catch (e) {
    // Stream closed or error
    log('processVideoStream: error', e)
    console.error('Video stream error:', e)
  }
  log('processVideoStream: ended', { totalFrames: videoFrameCount })
}

async function processAudioStream(stream: ReadableStream<AudioData>) {
  log('processAudioStream: starting')
  audioReader = stream.getReader()

  try {
    while (isRecording) {
      const { done, value: data } = await audioReader.read()
      if (done) {
        log('processAudioStream: stream done')
        break
      }
      if (!data) {
        log('processAudioStream: null data received')
        break
      }

      // Normalize timestamp to start from 0
      if (firstAudioTimestamp === null) {
        firstAudioTimestamp = data.timestamp
        log('processAudioStream: first timestamp captured', { firstAudioTimestamp })
      }
      const normalizedTimestamp = data.timestamp - firstAudioTimestamp

      audioSampleCount++
      if (audioSampleCount === 1 || audioSampleCount % 100 === 0) {
        log('processAudioStream: sample', {
          count: audioSampleCount,
          originalTimestamp: data.timestamp,
          normalizedTimestamp,
          duration: data.duration,
          numberOfFrames: data.numberOfFrames,
          sampleRate: data.sampleRate,
        })
      }

      // Add audio to mediabunny output with normalized timestamp
      if (audioSource) {
        const sample = new AudioSample(data)
        sample.setTimestamp(normalizedTimestamp / 1_000_000) // microseconds to seconds
        await audioSource.add(sample)
        sample[Symbol.dispose]?.()
      }

      data.close()
    }
  } catch (e) {
    // Stream closed or error
    log('processAudioStream: error', e)
    console.error('Audio stream error:', e)
  }
  log('processAudioStream: ended', { totalSamples: audioSampleCount })
}

const methods: RecordingWorkerMethods = {
  async start(config: RecordingStartConfig) {
    const { videoStream, audioStream, width, height } = config
    log('start called', { hasVideoStream: !!videoStream, hasAudioStream: !!audioStream, width, height })

    isRecording = true
    startTime = performance.now()
    firstFrame = null
    videoFrameCount = 0
    audioSampleCount = 0
    firstVideoTimestamp = null
    firstAudioTimestamp = null

    // Create buffer target for output
    log('creating BufferTarget')
    bufferTarget = new BufferTarget()

    // Create output with WebM format
    log('creating Output with WebMOutputFormat')
    output = new Output({
      format: new WebMOutputFormat(),
      target: bufferTarget,
    })

    // Setup video track
    if (videoStream) {
      log('setting up video track', { codec: 'vp9', bitrate: 2_000_000 })
      videoSource = new VideoSampleSource({
        codec: 'vp9',
        bitrate: 2_000_000,
      })
      output.addVideoTrack(videoSource)
      log('video track added')
    }

    // Setup audio track
    if (audioStream) {
      log('setting up audio track', { codec: 'opus', bitrate: 128_000 })
      audioSource = new AudioSampleSource({
        codec: 'opus',
        bitrate: 128_000,
      })
      output.addAudioTrack(audioSource)
      log('audio track added')
    }

    // Start the output
    log('starting output')
    await output.start()
    log('output started')

    // Start processing streams
    if (videoStream) {
      log('starting video stream processing')
      processVideoStream(videoStream)
    }
    if (audioStream) {
      log('starting audio stream processing')
      processAudioStream(audioStream)
    }
    log('start complete')
  },

  async stop() {
    log('stop called', { videoFrameCount, audioSampleCount })
    isRecording = false
    const duration = performance.now() - startTime
    log('stop: duration', { durationMs: duration })

    // Cancel readers
    if (videoReader) {
      log('stop: canceling video reader')
      try {
        await videoReader.cancel()
        log('stop: video reader canceled')
      } catch (e) {
        log('stop: video reader cancel error', e)
      }
      videoReader = null
    }

    if (audioReader) {
      log('stop: canceling audio reader')
      try {
        await audioReader.cancel()
        log('stop: audio reader canceled')
      } catch (e) {
        log('stop: audio reader cancel error', e)
      }
      audioReader = null
    }

    // Finalize the output
    let blob: Blob
    if (output && bufferTarget) {
      log('stop: finalizing output')
      await output.finalize()
      log('stop: output finalized')
      const buffer = bufferTarget.buffer
      log('stop: buffer', { hasBuffer: !!buffer, bufferSize: buffer?.byteLength })
      blob = buffer ? new Blob([buffer], { type: 'video/webm' }) : new Blob()
      log('stop: blob created', { size: blob.size, type: blob.type })
    } else {
      log('stop: no output or bufferTarget')
      blob = new Blob()
    }

    // Cleanup
    output = null
    bufferTarget = null
    videoSource = null
    audioSource = null
    log('stop: cleanup complete, returning', { blobSize: blob.size, duration })

    return { blob, duration }
  },

  async getFirstFrame() {
    log('getFirstFrame called', { hasFirstFrame: !!firstFrame })
    // Return the first frame wrapped for transfer
    // Cast needed because transfer() wrapper is transparent to the receiver
    if (firstFrame) {
      return transfer(firstFrame) as unknown as VideoFrame
    }
    return null
  },
}

expose(methods)
