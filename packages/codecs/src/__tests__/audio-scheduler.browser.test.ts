import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createAudioScheduler,
  isWebAudioSupported,
  type AudioScheduler,
} from '../audio-scheduler'

describe('Audio Scheduler - Support Detection', () => {
  it('should detect Web Audio API support', () => {
    const supported = isWebAudioSupported()
    expect(supported).toBe(true)
  })
})

describe('Audio Scheduler - Creation', () => {
  let scheduler: AudioScheduler

  afterEach(() => {
    scheduler?.destroy()
  })

  it('should create scheduler with default options', () => {
    scheduler = createAudioScheduler()

    expect(scheduler).toBeDefined()
    expect(scheduler.state).toBe('stopped')
    expect(scheduler.currentTime).toBe(0)
    expect(scheduler.audioContext).toBeInstanceOf(AudioContext)
  })

  it('should create scheduler with custom audio context', () => {
    const customContext = new AudioContext()
    scheduler = createAudioScheduler({ audioContext: customContext })

    expect(scheduler.audioContext).toBe(customContext)

    customContext.close()
  })

  it('should expose destination for effects chain', () => {
    scheduler = createAudioScheduler()

    expect(scheduler.destination).toBeDefined()
    expect(scheduler.destination).toBe(scheduler.audioContext.destination)
  })
})

describe('Audio Scheduler - Playback State', () => {
  let scheduler: AudioScheduler

  beforeEach(() => {
    scheduler = createAudioScheduler()
  })

  afterEach(() => {
    scheduler.destroy()
  })

  it('should start in stopped state', () => {
    expect(scheduler.state).toBe('stopped')
  })

  it('should transition to playing on play()', () => {
    scheduler.play()
    expect(scheduler.state).toBe('playing')
  })

  it('should transition to paused on pause()', () => {
    scheduler.play()
    scheduler.pause()
    expect(scheduler.state).toBe('paused')
  })

  it('should transition to stopped on stop()', () => {
    scheduler.play()
    scheduler.stop()
    expect(scheduler.state).toBe('stopped')
  })

  it('should resume from paused state', () => {
    scheduler.play()
    scheduler.pause()
    expect(scheduler.state).toBe('paused')

    scheduler.play()
    expect(scheduler.state).toBe('playing')
  })

  it('should not change state if already playing', () => {
    scheduler.play()
    scheduler.play() // Should be idempotent
    expect(scheduler.state).toBe('playing')
  })

  it('should not pause if not playing', () => {
    scheduler.pause() // Should be no-op
    expect(scheduler.state).toBe('stopped')
  })
})

describe('Audio Scheduler - Time Tracking', () => {
  let scheduler: AudioScheduler

  beforeEach(() => {
    scheduler = createAudioScheduler()
  })

  afterEach(() => {
    scheduler.destroy()
  })

  it('should return 0 when stopped', () => {
    expect(scheduler.currentTime).toBe(0)
  })

  it('should start from specified time', () => {
    scheduler.play(5.0)

    // Current time should be at or near 5.0
    expect(scheduler.currentTime).toBeGreaterThanOrEqual(5.0)
    expect(scheduler.currentTime).toBeLessThan(5.1)
  })

  it('should preserve time when paused', async () => {
    scheduler.play(2.0)

    // Wait a tiny bit
    await new Promise((resolve) => setTimeout(resolve, 50))

    scheduler.pause()
    const pausedTime = scheduler.currentTime

    // Wait more
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Time should not have changed
    expect(scheduler.currentTime).toBe(pausedTime)
  })

  it('should resume from paused time', async () => {
    scheduler.play(1.0)

    await new Promise((resolve) => setTimeout(resolve, 50))

    scheduler.pause()
    const pausedTime = scheduler.currentTime

    scheduler.play()

    // Should be at or near the paused time
    expect(scheduler.currentTime).toBeGreaterThanOrEqual(pausedTime)
    expect(scheduler.currentTime).toBeLessThan(pausedTime + 0.1)
  })

  it('should reset time on stop', () => {
    scheduler.play(10.0)
    scheduler.stop()

    expect(scheduler.currentTime).toBe(0)
  })
})

describe('Audio Scheduler - Seeking', () => {
  let scheduler: AudioScheduler

  beforeEach(() => {
    scheduler = createAudioScheduler()
  })

  afterEach(() => {
    scheduler.destroy()
  })

  it('should seek while playing', () => {
    scheduler.play(0)
    scheduler.seek(5.0)

    expect(scheduler.currentTime).toBeGreaterThanOrEqual(5.0)
    expect(scheduler.currentTime).toBeLessThan(5.1)
    expect(scheduler.state).toBe('playing')
  })

  it('should seek while paused', () => {
    scheduler.play(0)
    scheduler.pause()
    scheduler.seek(3.0)

    expect(scheduler.currentTime).toBe(3.0)
    expect(scheduler.state).toBe('paused')
  })

  it('should seek while stopped', () => {
    scheduler.seek(2.0)

    // When stopped, currentTime returns 0 regardless of seek
    expect(scheduler.state).toBe('stopped')
  })
})

describe('Audio Scheduler - Scheduling Audio', () => {
  let scheduler: AudioScheduler
  let audioContext: AudioContext

  beforeEach(() => {
    audioContext = new AudioContext()
    scheduler = createAudioScheduler({ audioContext })
  })

  afterEach(() => {
    scheduler.destroy()
    audioContext.close()
  })

  it('should not schedule when not playing', () => {
    // Create a simple AudioData
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 4800,
      numberOfChannels: 2,
      timestamp: 0,
      data: new Float32Array(4800 * 2),
    })

    // Should not throw, but should not schedule either
    scheduler.schedule(audioData, 0)

    audioData.close()
  })

  it('should schedule audio when playing', () => {
    scheduler.play(0)

    // Create a simple AudioData
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 4800, // 100ms of audio
      numberOfChannels: 2,
      timestamp: 0,
      data: new Float32Array(4800 * 2),
    })

    // Should not throw
    scheduler.schedule(audioData, 0)

    audioData.close()
  })

  it('should clear scheduled audio on seek', () => {
    scheduler.play(0)

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 4800,
      numberOfChannels: 2,
      timestamp: 0,
      data: new Float32Array(4800 * 2),
    })

    scheduler.schedule(audioData, 0)
    scheduler.seek(5.0)

    // Should not throw - scheduled audio should be cleared
    audioData.close()
  })

  it('should clear scheduled audio on stop', () => {
    scheduler.play(0)

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 4800,
      numberOfChannels: 2,
      timestamp: 0,
      data: new Float32Array(4800 * 2),
    })

    scheduler.schedule(audioData, 0)
    scheduler.stop()

    audioData.close()
  })
})

describe('Audio Scheduler - Cleanup', () => {
  it('should clean up on destroy', () => {
    const scheduler = createAudioScheduler()
    const context = scheduler.audioContext

    scheduler.play(0)
    scheduler.destroy()

    expect(scheduler.state).toBe('stopped')
    // Context should be closed (state becomes 'closed')
    expect(context.state).toBe('closed')
  })

  it('should not close provided audio context', () => {
    const customContext = new AudioContext()
    const scheduler = createAudioScheduler({ audioContext: customContext })

    scheduler.destroy()

    // Custom context should not be closed
    expect(customContext.state).not.toBe('closed')

    customContext.close()
  })
})
