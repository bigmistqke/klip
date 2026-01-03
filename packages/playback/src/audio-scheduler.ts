/**
 * Audio Scheduler - Schedules decoded AudioData for playback via Web Audio API
 */

import { debug } from '@klip/utils'

const log = debug('audio-scheduler', true)

/** Playback state */
export type AudioSchedulerState = 'stopped' | 'playing' | 'paused'

/** A scheduled audio chunk */
interface ScheduledChunk {
  /** The AudioBufferSourceNode for this chunk */
  source: AudioBufferSourceNode
  /** Start time in the audio context timeline */
  contextStartTime: number
  /** Media time this chunk starts at */
  mediaStartTime: number
  /** Duration in seconds */
  duration: number
}

export interface AudioSchedulerOptions {
  /** How far ahead to schedule audio (default: 0.5 seconds) */
  scheduleAhead?: number
  /** Audio context to use (creates one if not provided) */
  audioContext?: AudioContext
  /** Destination node for audio output (defaults to audioContext.destination) */
  destination?: AudioNode
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
   * Seek to a new position (clears scheduled audio)
   * @param time - Media time to seek to
   */
  seek(time: number): void

  /**
   * Clear all scheduled audio chunks
   */
  clearScheduled(): void

  /**
   * Clean up resources
   */
  destroy(): void
}

/**
 * Convert AudioData to AudioBuffer for Web Audio API
 */
function audioDataToBuffer(audioData: AudioData, audioContext: AudioContext): AudioBuffer {
  const numberOfChannels = audioData.numberOfChannels
  const numberOfFrames = audioData.numberOfFrames
  const sampleRate = audioData.sampleRate

  // Create an AudioBuffer
  const audioBuffer = audioContext.createBuffer(numberOfChannels, numberOfFrames, sampleRate)

  // Copy data from AudioData to AudioBuffer
  // AudioData uses planar float32 format when we copy to it
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel)
    audioData.copyTo(channelData, { planeIndex: channel, format: 'f32-planar' })
  }

  return audioBuffer
}

/**
 * Create an audio scheduler for Web Audio API playback
 */
export function createAudioScheduler(options: AudioSchedulerOptions = {}): AudioScheduler {
  log('createAudioScheduler')
  const scheduleAhead = options.scheduleAhead ?? 0.5
  // Use the destination's context if available, otherwise use provided context or create new
  const audioContext = options.destination?.context as AudioContext
    ?? options.audioContext
    ?? new AudioContext()
  const destination = options.destination ?? audioContext.destination

  // Scheduled chunks
  let scheduledChunks: ScheduledChunk[] = []

  // Playback state
  let state: AudioSchedulerState = 'stopped'

  // The context time when playback started
  let playbackStartContextTime = 0

  // The media time when playback started
  let playbackStartMediaTime = 0

  // Paused media time (for resuming)
  let pausedMediaTime = 0

  /** Get current media time based on audio context time */
  const getCurrentMediaTime = (): number => {
    if (state === 'stopped') {
      return 0
    }
    if (state === 'paused') {
      return pausedMediaTime
    }
    // Playing: calculate based on context time
    const elapsed = audioContext.currentTime - playbackStartContextTime
    return playbackStartMediaTime + elapsed
  }

  /** Clear all scheduled chunks */
  const clearAllScheduled = () => {
    for (const chunk of scheduledChunks) {
      try {
        chunk.source.stop()
        chunk.source.disconnect()
      } catch {
        // May already be stopped
      }
    }
    scheduledChunks = []
  }

  /** Remove chunks that have finished playing */
  const pruneFinishedChunks = () => {
    const now = audioContext.currentTime
    scheduledChunks = scheduledChunks.filter((chunk) => {
      const endTime = chunk.contextStartTime + chunk.duration
      return endTime > now
    })
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
      return audioContext.destination
    },

    schedule(audioData: AudioData, mediaTime: number): void {
      if (state !== 'playing') {
        // Don't schedule if not playing
        return
      }

      // Prune old chunks first
      pruneFinishedChunks()

      // Convert AudioData to AudioBuffer
      const audioBuffer = audioDataToBuffer(audioData, audioContext)

      // Calculate when this should play in context time
      const mediaOffset = mediaTime - playbackStartMediaTime
      const contextPlayTime = playbackStartContextTime + mediaOffset

      // Don't schedule if it's in the past
      if (contextPlayTime + audioBuffer.duration < audioContext.currentTime) {
        return
      }

      // Create and schedule the source
      const source = audioContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(destination)

      // Schedule playback
      const startTime = Math.max(contextPlayTime, audioContext.currentTime)
      source.start(startTime)

      // Track the scheduled chunk
      scheduledChunks.push({
        source,
        contextStartTime: startTime,
        mediaStartTime: mediaTime,
        duration: audioBuffer.duration,
      })
    },

    play(startTime: number = 0): void {
      log('play', { startTime, currentState: state })
      if (state === 'playing') {
        return
      }

      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        audioContext.resume()
      }

      if (state === 'paused') {
        // Resume from paused position
        playbackStartContextTime = audioContext.currentTime
        playbackStartMediaTime = pausedMediaTime
      } else {
        // Start fresh
        playbackStartContextTime = audioContext.currentTime
        playbackStartMediaTime = startTime
      }

      state = 'playing'
    },

    pause(): void {
      log('pause', { currentState: state })
      if (state !== 'playing') {
        return
      }

      // Save current position
      pausedMediaTime = getCurrentMediaTime()

      // Stop all scheduled audio
      clearAllScheduled()

      state = 'paused'
    },

    stop(): void {
      log('stop', { currentState: state })
      clearAllScheduled()
      state = 'stopped'
      playbackStartContextTime = 0
      playbackStartMediaTime = 0
      pausedMediaTime = 0
    },

    seek(time: number): void {
      log('seek', { time, currentState: state })
      const wasPlaying = state === 'playing'

      // Clear all scheduled audio
      clearAllScheduled()

      // Update position
      if (wasPlaying) {
        playbackStartContextTime = audioContext.currentTime
        playbackStartMediaTime = time
      } else {
        pausedMediaTime = time
      }
    },

    clearScheduled(): void {
      clearAllScheduled()
    },

    destroy(): void {
      clearAllScheduled()
      state = 'stopped'
      // Only close if we created the context
      if (!options.audioContext) {
        audioContext.close()
      }
    },
  }
}

/**
 * Check if Web Audio API is available
 */
export function isWebAudioSupported(): boolean {
  return typeof AudioContext !== 'undefined'
}
