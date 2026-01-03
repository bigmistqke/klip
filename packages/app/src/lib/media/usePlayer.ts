/**
 * SolidJS hook for the WebCodecs-based Player
 */

import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { createDemuxer, type Demuxer, createPlayer, type Player, type PlayerState } from '@klip/codecs'

export interface UsePlayerOptions {
  /** Called when a new frame is available */
  onFrame?: (frame: VideoFrame | null, time: number) => void
  /** Audio context to use (creates one if not provided) */
  audioContext?: AudioContext
}

export interface UsePlayerReturn {
  /** Current player state */
  state: Accessor<PlayerState>
  /** Current playback time in seconds */
  currentTime: Accessor<number>
  /** Total duration in seconds */
  duration: Accessor<number>
  /** Whether the player is ready */
  isReady: Accessor<boolean>
  /** Whether the player is playing */
  isPlaying: Accessor<boolean>
  /** Error if loading failed */
  error: Accessor<Error | null>
  /** The underlying player instance (null until loaded) */
  player: Accessor<Player | null>
  /** Load a video from a Blob */
  load: (blob: Blob) => Promise<void>
  /** Load a video from an ArrayBuffer */
  loadBuffer: (buffer: ArrayBuffer) => Promise<void>
  /** Start playback */
  play: (time?: number) => Promise<void>
  /** Pause playback */
  pause: () => void
  /** Stop playback */
  stop: () => void
  /** Seek to a specific time */
  seek: (time: number) => Promise<void>
  /** Get the current video frame */
  getCurrentFrame: () => VideoFrame | null
  /** Unload and clean up */
  unload: () => void
}

/**
 * Create a reactive player for SolidJS
 */
export function usePlayer(options: UsePlayerOptions = {}): UsePlayerReturn {
  const [state, setState] = createSignal<PlayerState>('idle')
  const [currentTime, setCurrentTime] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [error, setError] = createSignal<Error | null>(null)
  const [player, setPlayer] = createSignal<Player | null>(null)

  let demuxer: Demuxer | null = null
  let unsubscribeState: (() => void) | null = null
  let unsubscribeFrame: (() => void) | null = null
  let timeUpdateInterval: number | null = null

  /** Clean up current player */
  const cleanup = () => {
    if (timeUpdateInterval !== null) {
      clearInterval(timeUpdateInterval)
      timeUpdateInterval = null
    }
    if (unsubscribeState) {
      unsubscribeState()
      unsubscribeState = null
    }
    if (unsubscribeFrame) {
      unsubscribeFrame()
      unsubscribeFrame = null
    }
    const currentPlayer = player()
    if (currentPlayer) {
      currentPlayer.destroy()
      setPlayer(null)
    }
    if (demuxer) {
      demuxer.destroy()
      demuxer = null
    }
  }

  /** Start time update polling */
  const startTimeUpdates = () => {
    if (timeUpdateInterval !== null) return
    timeUpdateInterval = window.setInterval(() => {
      const p = player()
      if (p) {
        setCurrentTime(p.currentTime)
      }
    }, 16) // ~60fps
  }

  /** Stop time update polling */
  const stopTimeUpdates = () => {
    if (timeUpdateInterval !== null) {
      clearInterval(timeUpdateInterval)
      timeUpdateInterval = null
    }
  }

  /** Load from ArrayBuffer */
  const loadBuffer = async (buffer: ArrayBuffer): Promise<void> => {
    cleanup()
    setError(null)
    setState('loading')

    try {
      demuxer = await createDemuxer(buffer)
      const newPlayer = await createPlayer(demuxer, {
        audioContext: options.audioContext,
      })

      // Subscribe to state changes
      unsubscribeState = newPlayer.onStateChange((newState) => {
        setState(newState)
        if (newState === 'playing') {
          startTimeUpdates()
        } else {
          stopTimeUpdates()
          // Update time one last time when stopping
          setCurrentTime(newPlayer.currentTime)
        }
      })

      // Subscribe to frame updates if callback provided
      if (options.onFrame) {
        unsubscribeFrame = newPlayer.onFrame(options.onFrame)
      }

      setDuration(newPlayer.duration)
      setPlayer(newPlayer)
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setState('idle')
      throw err
    }
  }

  /** Load from Blob */
  const load = async (blob: Blob): Promise<void> => {
    const buffer = await blob.arrayBuffer()
    return loadBuffer(buffer)
  }

  /** Play */
  const play = async (time?: number): Promise<void> => {
    const p = player()
    if (!p) throw new Error('No player loaded')
    await p.play(time)
  }

  /** Pause */
  const pause = (): void => {
    const p = player()
    if (p) p.pause()
  }

  /** Stop */
  const stop = (): void => {
    const p = player()
    if (p) p.stop()
    setCurrentTime(0)
  }

  /** Seek */
  const seek = async (time: number): Promise<void> => {
    const p = player()
    if (!p) throw new Error('No player loaded')
    await p.seek(time)
    setCurrentTime(time)
  }

  /** Get current frame */
  const getCurrentFrame = (): VideoFrame | null => {
    const p = player()
    return p?.getCurrentFrame() ?? null
  }

  /** Unload */
  const unload = (): void => {
    cleanup()
    setState('idle')
    setCurrentTime(0)
    setDuration(0)
    setError(null)
  }

  // Cleanup on component unmount
  onCleanup(cleanup)

  return {
    state,
    currentTime,
    duration,
    isReady: () => state() === 'ready' || state() === 'paused',
    isPlaying: () => state() === 'playing',
    error,
    player,
    load,
    loadBuffer,
    play,
    pause,
    stop,
    seek,
    getCurrentFrame,
    unload,
  }
}
