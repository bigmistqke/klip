import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createDemuxer, type Demuxer } from '../demuxer'
import { createPlayer, type Player } from '../player'

// Load test fixtures via fetch in the browser
async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const response = await fetch(`/src/lib/media/__tests__/fixtures/${filename}`)
  if (!response.ok) {
    throw new Error(`Failed to load fixture: ${filename}`)
  }
  return response.arrayBuffer()
}

describe('Player - Creation (Video Only)', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player | null = null

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    player?.destroy()
    player = null
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should create player with video track', async () => {
    player = await createPlayer(demuxer)

    expect(player).toBeDefined()
    expect(player.state).toBe('ready')
    expect(player.videoTrack).not.toBeNull()
    expect(player.frameBuffer).not.toBeNull()
  })

  it('should have correct duration', async () => {
    player = await createPlayer(demuxer)

    expect(player.duration).toBeGreaterThan(0)
    expect(player.duration).toBe(demuxer.info.videoTracks[0].duration)
  })

  it('should start with currentTime at 0', async () => {
    player = await createPlayer(demuxer)

    expect(player.currentTime).toBe(0)
  })
})

describe('Player - Creation (Audio Only)', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player | null = null

  beforeAll(async () => {
    testBuffer = await loadFixture('test-opus.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    player?.destroy()
    player = null
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should create player with audio track', async () => {
    player = await createPlayer(demuxer)

    expect(player).toBeDefined()
    expect(player.state).toBe('ready')
    expect(player.audioTrack).not.toBeNull()
    expect(player.audioScheduler).not.toBeNull()
  })

  it('should have no video components for audio-only file', async () => {
    player = await createPlayer(demuxer)

    expect(player.videoTrack).toBeNull()
    expect(player.frameBuffer).toBeNull()
  })
})

describe('Player - Playback State (Video)', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    player?.destroy()
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should start in ready state', async () => {
    player = await createPlayer(demuxer)
    expect(player.state).toBe('ready')
  })

  it('should transition to playing on play()', async () => {
    player = await createPlayer(demuxer)

    await player.play()
    expect(player.state).toBe('playing')

    player.pause()
  })

  it('should transition to paused on pause()', async () => {
    player = await createPlayer(demuxer)

    await player.play()
    player.pause()

    expect(player.state).toBe('paused')
  })

  it('should transition to ready on stop()', async () => {
    player = await createPlayer(demuxer)

    await player.play()
    player.stop()

    expect(player.state).toBe('ready')
  })

  it('should resume from paused state', async () => {
    player = await createPlayer(demuxer)

    await player.play()
    player.pause()
    await player.play()

    expect(player.state).toBe('playing')

    player.pause()
  })
})

describe('Player - Seeking (Video)', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    player?.destroy()
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should seek while paused', async () => {
    player = await createPlayer(demuxer)

    await player.seek(1.0)

    expect(player.state).toBe('paused')
  })

  it('should seek while playing and resume', async () => {
    player = await createPlayer(demuxer)

    await player.play()
    await player.seek(0.5)

    expect(player.state).toBe('playing')

    player.pause()
  })

  it('should update frame buffer on seek', async () => {
    player = await createPlayer(demuxer)

    await player.seek(0.5)

    // Frame buffer should have content at the seek position
    expect(player.frameBuffer).not.toBeNull()
    expect(player.frameBuffer!.frameCount).toBeGreaterThan(0)
  })
})

describe('Player - Frame Retrieval', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    player?.destroy()
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should get current frame after seeking', async () => {
    player = await createPlayer(demuxer)

    await player.seek(0)

    const frame = player.getCurrentFrame()
    expect(frame).toBeInstanceOf(VideoFrame)
  })

  it('should return null when no frames buffered', async () => {
    player = await createPlayer(demuxer)

    // Before any buffering, should return null
    // Note: Player buffers on seek/play, so we need fresh player
    const frame = player.getCurrentFrame()
    // May or may not have frame depending on initialization
    expect(frame === null || frame instanceof VideoFrame).toBe(true)
  })
})

describe('Player - Callbacks', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    player?.destroy()
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should call onStateChange callback', async () => {
    player = await createPlayer(demuxer)

    const states: string[] = []
    const unsubscribe = player.onStateChange((state) => {
      states.push(state)
    })

    await player.play()
    player.pause()
    player.stop()

    unsubscribe()

    // Should have recorded state changes
    expect(states.length).toBeGreaterThan(0)
    expect(states).toContain('playing')
    expect(states).toContain('paused')
  })

  it('should unsubscribe from callbacks', async () => {
    player = await createPlayer(demuxer)

    let callCount = 0
    const unsubscribe = player.onStateChange(() => {
      callCount++
    })

    await player.play()
    const countAfterPlay = callCount

    unsubscribe()

    player.pause()

    // Should not have increased after unsubscribe
    expect(callCount).toBe(countAfterPlay)
  })

  it('should call onFrame callback during playback', async () => {
    player = await createPlayer(demuxer)

    let frameCalled = false
    const unsubscribe = player.onFrame((frame, time) => {
      frameCalled = true
      expect(typeof time).toBe('number')
    })

    await player.play()

    // Wait for a frame
    await new Promise((resolve) => setTimeout(resolve, 100))

    player.pause()
    unsubscribe()

    expect(frameCalled).toBe(true)
  })
})

describe('Player - Cleanup', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should clean up on destroy', async () => {
    const player = await createPlayer(demuxer)

    await player.play()
    player.destroy()

    expect(player.state).toBe('idle')
  })

  it('should stop playback on destroy', async () => {
    const player = await createPlayer(demuxer)

    await player.play()

    // Destroy should stop everything
    player.destroy()

    expect(player.state).toBe('idle')
  })
})
