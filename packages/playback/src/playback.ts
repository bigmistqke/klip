import type { AudioTrackInfo, Demuxer, VideoTrackInfo } from '@eddy/codecs'
import { createAudioDecoder, type AudioDecoderHandle } from '@eddy/codecs'
import { debug } from '@eddy/utils'
import type { AudioScheduler } from './audio-scheduler'
import { createAudioScheduler } from './audio-scheduler'
import type { FrameBuffer } from './frame-buffer'
import { createFrameBuffer } from './frame-buffer'

/** Playback state */
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'ended'

export interface PlaybackOptions {
  /** How far ahead to buffer video frames (default: 2 seconds) */
  videoBufferAhead?: number
  /** How far ahead to buffer/schedule audio (default: 0.5 seconds) */
  audioBufferAhead?: number
  /** Maximum video frames to keep in buffer (default: 60) */
  maxVideoFrames?: number
  /** Audio context to use (creates one if not provided) */
  audioContext?: AudioContext
  /** Destination node for audio output (defaults to audioContext.destination) */
  audioDestination?: AudioNode
}

export interface Playback {
  /** Current player state */
  readonly state: PlaybackState

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
   * Prepare for playback starting at given time
   * Buffers video and audio, sets up audio scheduler
   */
  prepareToPlay(startTime: number): Promise<void>

  /**
   * Start audio playback at given time
   * Call after prepareToPlay
   */
  startAudio(startTime: number): void

  /**
   * Reset playback state for looping (synchronous, no re-buffering)
   * Resets internal timing state so tick() will work from new time
   */
  resetForLoop(time: number): void

  /**
   * Pause playback
   */
  pause(): void

  /**
   * Stop playback and reset
   */
  stop(): void

  /**
   * Seek to a specific time (buffers frames around that time)
   */
  seek(time: number): Promise<void>

  /**
   * Tick the playback at given clock time
   * Buffers more content as needed, schedules audio
   * Does NOT return a frame - use getFrameTimestamp/takeFrameAt for borrow model
   * @param clockTime - Current time from master clock
   * @param bufferVideo - Whether to buffer video (default true). Set false for audio-only playback.
   */
  tick(clockTime: number, bufferVideo?: boolean): void

  /**
   * Get frame at specific time (for static display, clones from cache)
   */
  getFrameAt(time: number): VideoFrame | null

  /**
   * Get the timestamp of the frame at specific time (for checking if new frame needed)
   * @returns timestamp in microseconds (matching VideoFrame.timestamp), or null
   */
  getFrameTimestamp(time: number): number | null

  /**
   * Register a callback for state changes
   */
  onStateChange(callback: (state: PlaybackState) => void): () => void

  /**
   * Clean up all resources
   */
  destroy(): void
}

/**
 * Create a synchronized A/V playback
 */
let playbackIdCounter = 0

export async function createPlayback(
  demuxer: Demuxer,
  options: PlaybackOptions = {},
): Promise<Playback> {
  const id = String(playbackIdCounter++)
  const log = debug(`playback-${id}`, false)
  log('creating playback')

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
  let state: PlaybackState = 'loading'
  let lastFramePts = -1
  let lastTickTime = -1

  // Callbacks
  const stateCallbacks: Array<(state: PlaybackState) => void> = []

  const setState = (newState: PlaybackState) => {
    if (state !== newState) {
      log('setState', { from: state, to: newState })
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
      destination: options.audioDestination,
    })
    audioDecoder = await createAudioDecoder(demuxer, audioTrack)
  }

  // Duration is the max of video and audio durations
  const duration = Math.max(videoTrack?.duration ?? 0, audioTrack?.duration ?? 0)

  /** Buffer and schedule audio for a time range */
  const bufferAudio = async (startTime: number, endTime: number) => {
    if (!audioTrack || !audioDecoder || !audioScheduler) return

    const samples = await demuxer.getSamples(audioTrack.id, startTime, endTime)
    if (samples.length === 0) return

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

  /** Get frame at specific time (returns null if past duration) */
  const getFrameAtTime = (time: number): VideoFrame | null => {
    if (!frameBuffer) return null
    // Return null if past the clip's duration
    if (duration > 0 && time >= duration) return null
    const bufferedFrame = frameBuffer.getFrame(time)
    return bufferedFrame?.frame ?? null
  }

  /** Get timestamp of frame at specific time (for checking if new frame needed) */
  const getFrameTimestampAtTime = (time: number): number | null => {
    if (!frameBuffer) return null
    if (duration > 0 && time >= duration) return null
    return frameBuffer.getFrameTimestamp(time)
  }

  // Mark as ready
  setState('ready')

  return {
    get state() {
      return state
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

    async prepareToPlay(startTime: number): Promise<void> {
      log('prepareToPlay', { startTime, currentState: state })
      setState('loading')

      // Buffer video
      if (frameBuffer) {
        await frameBuffer.seekTo(startTime)
      }

      // Seek audio
      if (audioScheduler) {
        audioScheduler.seek(startTime)
      }

      // Buffer initial audio
      if (audioTrack && audioDecoder && audioScheduler) {
        await bufferAudio(startTime, startTime + audioBufferAhead)
      }

      lastFramePts = -1
      lastTickTime = startTime
      setState('ready')
      log('prepareToPlay complete')
    },

    startAudio(startTime: number): void {
      log('startAudio', { startTime })
      if (audioScheduler) {
        audioScheduler.play(startTime)
      }
      setState('playing')
    },

    resetForLoop(time: number): void {
      log('resetForLoop', { time })
      // Reset internal timing state
      lastFramePts = -1
      lastTickTime = time

      // Reset audio scheduler for new position
      if (audioScheduler) {
        audioScheduler.seek(time)
        audioScheduler.play(time)
      }

      // Trigger audio buffering from new position
      if (audioTrack && audioDecoder && audioScheduler) {
        bufferAudio(time, time + audioBufferAhead)
      }
    },

    pause(): void {
      log('pause', { currentState: state })
      if (state !== 'playing') return

      if (audioScheduler) {
        audioScheduler.pause()
      }
      setState('paused')
    },

    stop(): void {
      log('stop', { currentState: state })

      if (audioScheduler) {
        audioScheduler.stop()
      }

      if (frameBuffer) {
        frameBuffer.clear()
      }

      lastFramePts = -1
      lastTickTime = -1
      setState('ready')
    },

    async seek(time: number): Promise<void> {
      log('seek', { time, currentState: state })
      const wasPlaying = state === 'playing'

      setState('seeking')

      // Buffer video around seek time
      if (frameBuffer) {
        await frameBuffer.seekTo(time)
      }

      // Seek audio
      if (audioScheduler) {
        audioScheduler.seek(time)
      }

      // Reset audio decoder
      if (audioDecoder) {
        await audioDecoder.reset()
      }

      lastFramePts = -1
      lastTickTime = time

      if (wasPlaying) {
        // Buffer audio and resume
        if (audioTrack && audioDecoder && audioScheduler) {
          await bufferAudio(time, time + audioBufferAhead)
          audioScheduler.play(time)
        }
        setState('playing')
      } else {
        setState('paused')
      }
      log('seek complete', { finalState: state })
    },

    tick(clockTime: number, bufferVideo = true): void {
      if (state !== 'playing') {
        return
      }

      // Check for end
      if (duration > 0 && clockTime >= duration) {
        log('tick: reached end', { clockTime, duration })
        setState('ended')
        return
      }

      // Buffer more video if needed
      if (bufferVideo && frameBuffer && !frameBuffer.isBufferedAt(clockTime + videoBufferAhead / 2)) {
        frameBuffer.bufferMore()
      }

      // Buffer more audio if needed
      if (audioScheduler && audioTrack && state === 'playing') {
        const audioEnd = clockTime + audioBufferAhead
        if (audioEnd > lastTickTime + audioBufferAhead / 2) {
          bufferAudio(lastTickTime, audioEnd)
          lastTickTime = clockTime
        }
      }
    },

    getFrameAt(time: number): VideoFrame | null {
      return getFrameAtTime(time)
    },

    getFrameTimestamp(time: number): number | null {
      return getFrameTimestampAtTime(time)
    },

    onStateChange(callback: (state: PlaybackState) => void): () => void {
      stateCallbacks.push(callback)
      return () => {
        const index = stateCallbacks.indexOf(callback)
        if (index !== -1) {
          stateCallbacks.splice(index, 1)
        }
      }
    },

    destroy(): void {
      log('destroy')
      if (frameBuffer) {
        frameBuffer.destroy()
      }
      if (audioScheduler) {
        audioScheduler.destroy()
      }
      if (audioDecoder) {
        audioDecoder.close()
      }

      stateCallbacks.length = 0
      setState('idle')
    },
  }
}
