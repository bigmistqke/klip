/**
 * Synchronized A/V Player - Coordinates video frame buffer and audio scheduler
 */

import type { Demuxer, VideoTrackInfo, AudioTrackInfo } from './demuxer'
import type { FrameBuffer } from './frame-buffer'
import type { AudioScheduler } from './audio-scheduler'
import { createFrameBuffer } from './frame-buffer'
import { createAudioScheduler } from './audio-scheduler'
import { createAudioDecoder, type AudioDecoderHandle } from './audio-decoder'

/** Player state */
export type PlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'ended'

export interface PlayerOptions {
  /** How far ahead to buffer video frames (default: 2 seconds) */
  videoBufferAhead?: number
  /** How far ahead to buffer/schedule audio (default: 0.5 seconds) */
  audioBufferAhead?: number
  /** Maximum video frames to keep in buffer (default: 60) */
  maxVideoFrames?: number
  /** Audio context to use (creates one if not provided) */
  audioContext?: AudioContext
}

export interface Player {
  /** Current player state */
  readonly state: PlayerState

  /** Current playback time in seconds */
  readonly currentTime: number

  /** Total duration in seconds */
  readonly duration: number

  /** Video track info (if available) */
  readonly videoTrack: VideoTrackInfo | null

  /** Audio track info (if available) */
  readonly audioTrack: AudioTrackInfo | null

  /** The frame buffer (for video) */
  readonly frameBuffer: FrameBuffer | null

  /** The audio scheduler */
  readonly audioScheduler: AudioScheduler | null

  /**
   * Start playback
   * @param time - Optional start time (default: current position or 0)
   */
  play(time?: number): Promise<void>

  /**
   * Pause playback
   */
  pause(): void

  /**
   * Stop playback and reset to beginning
   */
  stop(): void

  /**
   * Seek to a specific time
   * @param time - Time in seconds
   */
  seek(time: number): Promise<void>

  /**
   * Get the current video frame for rendering
   * Returns null if no frame is available
   */
  getCurrentFrame(): VideoFrame | null

  /**
   * Register a callback for frame updates (called on each animation frame during playback)
   * @param callback - Function called with the current VideoFrame (or null)
   * @returns Unsubscribe function
   */
  onFrame(callback: (frame: VideoFrame | null, time: number) => void): () => void

  /**
   * Register a callback for state changes
   * @param callback - Function called when state changes
   * @returns Unsubscribe function
   */
  onStateChange(callback: (state: PlayerState) => void): () => void

  /**
   * Clean up all resources
   */
  destroy(): void
}

/**
 * Create a synchronized A/V player
 */
export async function createPlayer(
  demuxer: Demuxer,
  options: PlayerOptions = {}
): Promise<Player> {
  const videoBufferAhead = options.videoBufferAhead ?? 2
  const audioBufferAhead = options.audioBufferAhead ?? 0.5
  const maxVideoFrames = options.maxVideoFrames ?? 60

  // Get first video and audio tracks
  const videoTrack = demuxer.info.videoTracks[0] ?? null
  const audioTrack = demuxer.info.audioTracks[0] ?? null

  if (!videoTrack && !audioTrack) {
    throw new Error('No video or audio tracks found')
  }

  // State
  let state: PlayerState = 'loading'
  let animationFrameId: number | null = null
  let lastFramePts = -1

  // Callbacks
  const frameCallbacks: Array<(frame: VideoFrame | null, time: number) => void> = []
  const stateCallbacks: Array<(state: PlayerState) => void> = []

  const setState = (newState: PlayerState) => {
    if (state !== newState) {
      state = newState
      for (const cb of stateCallbacks) {
        cb(newState)
      }
    }
  }

  // Create frame buffer for video
  let frameBuffer: FrameBuffer | null = null
  if (videoTrack) {
    frameBuffer = await createFrameBuffer(demuxer, videoTrack, {
      bufferAhead: videoBufferAhead,
      maxFrames: maxVideoFrames,
    })
  }

  // Create audio scheduler and decoder
  let audioScheduler: AudioScheduler | null = null
  let audioDecoder: AudioDecoderHandle | null = null
  if (audioTrack) {
    audioScheduler = createAudioScheduler({
      scheduleAhead: audioBufferAhead,
      audioContext: options.audioContext,
    })
    audioDecoder = await createAudioDecoder(demuxer, audioTrack)
  }

  // Duration is the max of video and audio durations
  const duration = Math.max(
    videoTrack?.duration ?? 0,
    audioTrack?.duration ?? 0
  )

  /** Get current time from audio scheduler or estimate from video */
  const getCurrentTime = (): number => {
    if (audioScheduler && audioScheduler.state === 'playing') {
      return audioScheduler.currentTime
    }
    // Fallback for video-only or when audio is not playing
    if (frameBuffer) {
      const frame = frameBuffer.getFrame(Infinity)
      if (frame) {
        return frame.pts
      }
    }
    return 0
  }

  /** Buffer and schedule audio for a time range */
  const bufferAudio = async (startTime: number, endTime: number) => {
    if (!audioTrack || !audioDecoder || !audioScheduler) return

    const samples = await demuxer.getSamples(audioTrack.id, startTime, endTime)
    if (samples.length === 0) return

    // Decode and schedule each sample
    for (const sample of samples) {
      try {
        const audioData = await audioDecoder.decode(sample)
        audioScheduler.schedule(audioData, sample.pts)
        audioData.close()
      } catch (err) {
        // Skip failed samples
      }
    }
  }

  /** Animation frame loop for video rendering */
  const renderLoop = () => {
    if (state !== 'playing') return

    const currentTime = getCurrentTime()

    // Check if we've reached the end (only if duration is known)
    if (duration > 0 && currentTime >= duration) {
      setState('ended')
      return
    }

    // Get current frame
    let currentFrame: VideoFrame | null = null
    if (frameBuffer) {
      const bufferedFrame = frameBuffer.getFrame(currentTime)
      if (bufferedFrame && bufferedFrame.pts !== lastFramePts) {
        currentFrame = bufferedFrame.frame
        lastFramePts = bufferedFrame.pts
      }
    }

    // Notify frame callbacks
    for (const cb of frameCallbacks) {
      cb(currentFrame, currentTime)
    }

    // Buffer more video if needed
    if (frameBuffer && !frameBuffer.isBufferedAt(currentTime + videoBufferAhead / 2)) {
      frameBuffer.bufferMore()
    }

    // Buffer more audio if needed
    if (audioScheduler && audioTrack) {
      const audioEnd = currentTime + audioBufferAhead
      bufferAudio(currentTime, audioEnd)
    }

    // Schedule next frame
    animationFrameId = requestAnimationFrame(renderLoop)
  }

  // Mark as ready
  setState('ready')

  return {
    get state() {
      return state
    },

    get currentTime() {
      return getCurrentTime()
    },

    get duration() {
      return duration
    },

    get videoTrack() {
      return videoTrack
    },

    get audioTrack() {
      return audioTrack
    },

    get frameBuffer() {
      return frameBuffer
    },

    get audioScheduler() {
      return audioScheduler
    },

    async play(time?: number): Promise<void> {
      if (state === 'playing') return

      const startTime = time ?? getCurrentTime()

      setState('loading')

      // Seek to start position if specified
      if (time !== undefined || state === 'ready' || state === 'ended') {
        if (frameBuffer) {
          await frameBuffer.seekTo(startTime)
        }
        if (audioScheduler) {
          audioScheduler.seek(startTime)
        }
      }

      // Buffer initial audio
      if (audioTrack && audioDecoder && audioScheduler) {
        await bufferAudio(startTime, startTime + audioBufferAhead)
      }

      // Start audio playback (audio is the master clock)
      if (audioScheduler) {
        audioScheduler.play(startTime)
      }

      setState('playing')
      lastFramePts = -1

      // Start render loop
      animationFrameId = requestAnimationFrame(renderLoop)
    },

    pause(): void {
      if (state !== 'playing') return

      // Stop animation loop
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }

      // Pause audio
      if (audioScheduler) {
        audioScheduler.pause()
      }

      setState('paused')
    },

    stop(): void {
      // Stop animation loop
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }

      // Stop audio
      if (audioScheduler) {
        audioScheduler.stop()
      }

      // Clear video buffer
      if (frameBuffer) {
        frameBuffer.clear()
      }

      lastFramePts = -1
      setState('ready')
    },

    async seek(time: number): Promise<void> {
      const wasPlaying = state === 'playing'

      // Stop animation loop during seek
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }

      setState('seeking')

      // Seek video
      if (frameBuffer) {
        await frameBuffer.seekTo(time)
      }

      // Seek audio
      if (audioScheduler) {
        audioScheduler.seek(time)
      }

      // Reset audio decoder for clean state
      if (audioDecoder) {
        await audioDecoder.reset()
      }

      lastFramePts = -1

      // Resume if was playing
      if (wasPlaying) {
        // Buffer audio before resuming
        if (audioTrack && audioDecoder && audioScheduler) {
          await bufferAudio(time, time + audioBufferAhead)
        }

        if (audioScheduler) {
          audioScheduler.play(time)
        }

        setState('playing')
        animationFrameId = requestAnimationFrame(renderLoop)
      } else {
        setState('paused')
      }
    },

    getCurrentFrame(): VideoFrame | null {
      if (!frameBuffer) return null
      const bufferedFrame = frameBuffer.getFrame(getCurrentTime())
      return bufferedFrame?.frame ?? null
    },

    onFrame(callback: (frame: VideoFrame | null, time: number) => void): () => void {
      frameCallbacks.push(callback)
      return () => {
        const index = frameCallbacks.indexOf(callback)
        if (index !== -1) {
          frameCallbacks.splice(index, 1)
        }
      }
    },

    onStateChange(callback: (state: PlayerState) => void): () => void {
      stateCallbacks.push(callback)
      return () => {
        const index = stateCallbacks.indexOf(callback)
        if (index !== -1) {
          stateCallbacks.splice(index, 1)
        }
      }
    },

    destroy(): void {
      // Stop animation loop
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }

      // Clean up resources
      if (frameBuffer) {
        frameBuffer.destroy()
      }
      if (audioScheduler) {
        audioScheduler.destroy()
      }
      if (audioDecoder) {
        audioDecoder.close()
      }

      frameCallbacks.length = 0
      stateCallbacks.length = 0

      setState('idle')
    },
  }
}
