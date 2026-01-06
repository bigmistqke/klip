/**
 * Audio Scheduler - Ring buffer based audio playback via AudioWorklet
 *
 * Uses a SharedArrayBuffer ring buffer for lock-free audio streaming.
 * The AudioWorkletProcessor pulls samples at the exact audio rate,
 * eliminating gaps and overlaps from chunk scheduling.
 */

import { rpc } from '@bigmistqke/rpc/messenger'
import { debug } from '@eddy/utils'
import { createAudioRingBuffer } from './audio-ring-buffer'
import type { RingBufferProcessorMethods } from './audio-ring-buffer-processor'
import workletURL from './audio-ring-buffer-processor?worker&url'

const log = debug('audio-scheduler', false)

/** Playback state */
export type AudioSchedulerState = 'stopped' | 'playing' | 'paused'

export interface AudioSchedulerOptions {
  /** How far ahead to buffer audio in seconds (default: 0.5) */
  bufferAhead?: number
  /** Destination node for audio output. If provided, uses its context. Otherwise creates own AudioContext. */
  destination?: AudioNode
  /** Sample rate (default: 48000) */
  sampleRate?: number
  /** Number of channels (default: 2 for stereo) */
  channels?: number
}

export interface AudioScheduler {
  /** Current playback state */
  readonly state: AudioSchedulerState

  /** Current media time in seconds */
  readonly currentTime: number

  /** The audio context being used */
  readonly audioContext: AudioContext

  /** The destination node (for connecting effects) */
  readonly destination: AudioNode

  /**
   * Schedule an AudioData for playback
   * @param audioData - The decoded audio data
   * @param mediaTime - The media time this audio should play at
   */
  schedule(audioData: AudioData, mediaTime: number): void

  /**
   * Start playback from a given media time
   * @param startTime - Media time to start from (default: 0)
   */
  play(startTime?: number): void

  /**
   * Pause playback
   */
  pause(): void

  /**
   * Stop playback and clear all scheduled audio
   */
  stop(): void

  /**
   * Seek to a new position (clears buffer)
   * @param time - Media time to seek to
   */
  seek(time: number): void

  /**
   * Clear all buffered audio
   */
  clearScheduled(): void

  /**
   * Clean up resources
   */
  destroy(): void
}

/** Extract samples from AudioData to Float32Array per channel */
function extractAudioSamples(audioData: AudioData): Float32Array[] {
  const numberOfChannels = audioData.numberOfChannels
  const numberOfFrames = audioData.numberOfFrames
  const format = audioData.format

  const channels: Float32Array[] = []

  if (format === 'f32-planar') {
    // Planar format: each channel is a separate plane
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = new Float32Array(numberOfFrames)
      audioData.copyTo(channelData, { planeIndex: ch })
      channels.push(channelData)
    }
  } else {
    // Interleaved formats: all channels in plane 0
    const byteSize = audioData.allocationSize({ planeIndex: 0 })
    const tempBuffer = new ArrayBuffer(byteSize)
    audioData.copyTo(tempBuffer, { planeIndex: 0 })

    if (format === 'f32') {
      const interleaved = new Float32Array(tempBuffer)
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const channelData = new Float32Array(numberOfFrames)
        for (let i = 0; i < numberOfFrames; i++) {
          channelData[i] = interleaved[i * numberOfChannels + ch]
        }
        channels.push(channelData)
      }
    } else if (format === 's16') {
      const interleaved = new Int16Array(tempBuffer)
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const channelData = new Float32Array(numberOfFrames)
        for (let i = 0; i < numberOfFrames; i++) {
          channelData[i] = interleaved[i * numberOfChannels + ch] / 32768
        }
        channels.push(channelData)
      }
    } else {
      // Fallback: try format conversion
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const channelData = new Float32Array(numberOfFrames)
        try {
          audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' })
        } catch {
          channelData.fill(0)
        }
        channels.push(channelData)
      }
    }
  }

  return channels
}

/**
 * Create an audio scheduler using ring buffer and AudioWorklet
 */
export async function createAudioScheduler(
  options: AudioSchedulerOptions = {},
): Promise<AudioScheduler> {
  log('createAudioScheduler')

  const channels = options.channels ?? 2
  const bufferAhead = options.bufferAhead ?? 2
  const sourceSampleRate = options.sampleRate ?? 48000

  // Get context from destination, or create our own
  const ownsContext = !options.destination
  const audioContext = (options.destination?.context as AudioContext) ?? new AudioContext()
  const destination = options.destination ?? audioContext.destination

  // Use the actual AudioContext sample rate
  const actualSampleRate = audioContext.sampleRate
  log('sample rates', { source: sourceSampleRate, context: actualSampleRate })

  // Ring buffer size: enough for bufferAhead seconds plus some extra
  const bufferCapacity = Math.ceil(actualSampleRate * (bufferAhead + 1))

  // Create ring buffer
  const ringBuffer = createAudioRingBuffer(bufferCapacity, channels)

  // Load worklet processor
  await audioContext.audioWorklet.addModule(workletURL)

  // Create worklet node
  const workletNode = new AudioWorkletNode(audioContext, 'ring-buffer-processor', {
    outputChannelCount: [channels],
  })
  workletNode.connect(destination)

  const audioWorkletMethods = rpc<RingBufferProcessorMethods>(workletNode.port)
  audioWorkletMethods.init(ringBuffer.sampleBuffer, ringBuffer.controlBuffer)

  // State
  let state: AudioSchedulerState = 'stopped'
  let playbackStartContextTime = 0
  let playbackStartMediaTime = 0
  let pausedMediaTime = 0

  // Track how many samples we've written to ring buffer (for media time calculation)
  let samplesWrittenToBuffer = 0
  let bufferStartMediaTime = 0

  // Pending audio samples sorted by media time
  const pendingSamples: Array<{
    mediaTime: number
    channels: Float32Array[]
    sampleRate: number
  }> = []

  /** Get current media time */
  const getCurrentMediaTime = (): number => {
    if (state === 'stopped') return 0
    if (state === 'paused') return pausedMediaTime
    const elapsed = audioContext.currentTime - playbackStartContextTime
    return playbackStartMediaTime + elapsed
  }

  /** Simple linear interpolation resampling */
  const resample = (input: Float32Array, inputRate: number, outputRate: number): Float32Array => {
    if (inputRate === outputRate) return input

    const ratio = inputRate / outputRate
    const outputLength = Math.floor(input.length / ratio)
    const output = new Float32Array(outputLength)

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio
      const srcIndexFloor = Math.floor(srcIndex)
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1)
      const t = srcIndex - srcIndexFloor
      output[i] = input[srcIndexFloor] * (1 - t) + input[srcIndexCeil] * t
    }

    return output
  }

  /** Flush pending samples to ring buffer up to current time + buffer ahead */
  const flushPendingSamples = () => {
    if (state !== 'playing') return

    const currentMedia = getCurrentMediaTime()
    const targetTime = currentMedia + bufferAhead

    while (pendingSamples.length > 0) {
      const sample = pendingSamples[0]
      const sampleDuration = sample.channels[0].length / sample.sampleRate

      // Skip samples in the past
      if (sample.mediaTime + sampleDuration < currentMedia) {
        pendingSamples.shift()
        continue
      }

      // Stop if we've buffered enough
      if (sample.mediaTime > targetTime) break

      // Resample if needed
      let channelsToWrite = sample.channels
      if (sample.sampleRate !== actualSampleRate) {
        channelsToWrite = sample.channels.map(ch =>
          resample(ch, sample.sampleRate, actualSampleRate),
        )
      }

      // Try to write to ring buffer
      const written = ringBuffer.write(channelsToWrite, channelsToWrite[0].length)
      if (written === channelsToWrite[0].length) {
        samplesWrittenToBuffer += written
        pendingSamples.shift()
      } else if (written > 0) {
        samplesWrittenToBuffer += written
        // Partial write - trim the sample (from original, not resampled)
        const originalWritten = Math.floor(
          (written / channelsToWrite[0].length) * sample.channels[0].length,
        )
        for (let ch = 0; ch < sample.channels.length; ch++) {
          sample.channels[ch] = sample.channels[ch].slice(originalWritten)
        }
        sample.mediaTime += originalWritten / sample.sampleRate
        break // Buffer is full
      } else {
        break // Buffer is full
      }
    }
  }

  return {
    get state() {
      return state
    },

    get currentTime() {
      return getCurrentMediaTime()
    },

    get audioContext() {
      return audioContext
    },

    get destination() {
      return destination
    },

    schedule(audioData: AudioData, mediaTime: number): void {
      // Extract samples from AudioData
      const extractedChannels = extractAudioSamples(audioData)
      const sampleRate = audioData.sampleRate

      // Add to pending queue (keep sorted by media time)
      const sample = { mediaTime, channels: extractedChannels, sampleRate }
      let inserted = false
      for (let i = 0; i < pendingSamples.length; i++) {
        if (mediaTime < pendingSamples[i].mediaTime) {
          pendingSamples.splice(i, 0, sample)
          inserted = true
          break
        }
      }
      if (!inserted) {
        pendingSamples.push(sample)
      }

      // Flush to ring buffer
      flushPendingSamples()
    },

    play(startTime: number = 0): void {
      log('play', { startTime, currentState: state })
      if (state === 'playing') return

      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        audioContext.resume()
      }

      if (state === 'paused') {
        playbackStartContextTime = audioContext.currentTime
        playbackStartMediaTime = pausedMediaTime
      } else {
        playbackStartContextTime = audioContext.currentTime
        playbackStartMediaTime = startTime
        bufferStartMediaTime = startTime
        samplesWrittenToBuffer = 0
      }

      ringBuffer.setPlaying(true)
      state = 'playing'

      // Flush pending samples
      flushPendingSamples()
    },

    pause(): void {
      log('pause', { currentState: state })
      if (state !== 'playing') return

      pausedMediaTime = getCurrentMediaTime()
      ringBuffer.setPlaying(false)
      state = 'paused'
    },

    stop(): void {
      log('stop', { currentState: state })
      ringBuffer.setPlaying(false)
      ringBuffer.clear()
      pendingSamples.length = 0
      samplesWrittenToBuffer = 0
      bufferStartMediaTime = 0
      state = 'stopped'
      playbackStartContextTime = 0
      playbackStartMediaTime = 0
      pausedMediaTime = 0
    },

    seek(time: number): void {
      log('seek', { time, currentState: state })
      const wasPlaying = state === 'playing'

      // Clear buffer and pending samples
      ringBuffer.clear()
      pendingSamples.length = 0
      samplesWrittenToBuffer = 0
      bufferStartMediaTime = time

      if (wasPlaying) {
        playbackStartContextTime = audioContext.currentTime
        playbackStartMediaTime = time
      } else {
        pausedMediaTime = time
      }
    },

    clearScheduled(): void {
      ringBuffer.clear()
      pendingSamples.length = 0
      samplesWrittenToBuffer = 0
    },

    destroy(): void {
      ringBuffer.setPlaying(false)
      ringBuffer.clear()
      workletNode.disconnect()
      pendingSamples.length = 0
      state = 'stopped'
      // Only close the context if we created it (not passed via options or destination)
      if (ownsContext) {
        audioContext.close()
      }
    },
  }
}

/**
 * Check if Web Audio API with AudioWorklet is available
 */
export function isWebAudioSupported(): boolean {
  return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
}
