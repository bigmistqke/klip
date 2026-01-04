import { createSignal, type Accessor } from 'solid-js'

export interface Clock {
  /** Current time in seconds */
  time: Accessor<number>
  /** Whether clock is running */
  isPlaying: Accessor<boolean>
  /** Whether loop is enabled */
  loop: Accessor<boolean>
  /** Duration for loop (0 = no limit) */
  duration: Accessor<number>
  /** Start or resume the clock */
  play: (startTime?: number) => void
  /** Pause the clock */
  pause: () => void
  /** Stop and reset to 0 */
  stop: () => void
  /** Seek to specific time */
  seek: (time: number) => void
  /** Set loop enabled */
  setLoop: (enabled: boolean) => void
  /** Set duration for loop boundary */
  setDuration: (duration: number) => void
  /** Tick the clock (call from render loop) */
  tick: () => number
}

/**
 * Creates a clock for managing playback time
 * The clock maintains its own time state and can be ticked from a render loop
 */
export function createClock(): Clock {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [time, setTime] = createSignal(0)
  const [loop, setLoop] = createSignal(false)
  const [duration, setDuration] = createSignal(0)

  // Internal state for high-precision timing
  let clockStartTime = 0 // performance.now() when playback started
  let clockStartPosition = 0 // time when playback started

  function getCurrentTime(): number {
    if (isPlaying()) {
      const elapsed = (performance.now() - clockStartTime) / 1000
      return clockStartPosition + elapsed
    }
    return time()
  }

  function tick(): number {
    let currentTime = getCurrentTime()

    // Handle loop
    if (isPlaying() && loop()) {
      const maxDuration = duration()
      if (maxDuration > 0 && currentTime >= maxDuration) {
        // Loop back to start
        clockStartPosition = 0
        clockStartTime = performance.now()
        currentTime = 0
      }
    }

    // Update signal for reactive consumers
    setTime(currentTime)
    return currentTime
  }

  function play(startTime?: number) {
    const start = startTime ?? time()
    clockStartPosition = start
    clockStartTime = performance.now()
    setTime(start)
    setIsPlaying(true)
  }

  function pause() {
    if (!isPlaying()) return
    // Save current time before stopping
    setTime(getCurrentTime())
    setIsPlaying(false)
  }

  function stop() {
    setIsPlaying(false)
    setTime(0)
    clockStartPosition = 0
  }

  function seek(newTime: number) {
    const wasPlaying = isPlaying()

    if (wasPlaying) {
      setIsPlaying(false)
    }

    setTime(newTime)
    clockStartPosition = newTime

    if (wasPlaying) {
      clockStartTime = performance.now()
      setIsPlaying(true)
    }
  }

  return {
    time,
    isPlaying,
    loop,
    duration,
    play,
    pause,
    stop,
    seek,
    setLoop,
    setDuration,
    tick,
  }
}
