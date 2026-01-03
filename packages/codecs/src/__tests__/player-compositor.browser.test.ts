import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createDemuxer, type Demuxer } from '../demuxer'
import { createPlayer, type Player } from '../player'
import { createCompositor, type Compositor } from '../../video/compositor'
import {
  createPlayerCompositor,
  createMultiTrackSetup,
  type PlayerCompositor,
} from '../player-compositor'

// Load test fixtures via fetch in the browser
async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const response = await fetch(`/src/lib/media/__tests__/fixtures/${filename}`)
  if (!response.ok) {
    throw new Error(`Failed to load fixture: ${filename}`)
  }
  return response.arrayBuffer()
}

describe('Player-Compositor Integration - Creation', () => {
  let compositor: Compositor
  let playerCompositor: PlayerCompositor | null = null

  beforeAll(() => {
    compositor = createCompositor(640, 480)
  })

  afterEach(() => {
    playerCompositor?.destroy()
    playerCompositor = null
  })

  afterAll(() => {
    compositor.destroy()
  })

  it('should create player-compositor integration', () => {
    playerCompositor = createPlayerCompositor(compositor)

    expect(playerCompositor).toBeDefined()
    expect(playerCompositor.compositor).toBe(compositor)
    expect(playerCompositor.slots.length).toBe(4)
  })

  it('should start automatically by default', () => {
    playerCompositor = createPlayerCompositor(compositor)

    // Should be running - hard to test directly, but shouldn't throw
    expect(playerCompositor).toBeDefined()
  })

  it('should not auto-start when disabled', () => {
    playerCompositor = createPlayerCompositor(compositor, { autoStart: false })

    expect(playerCompositor).toBeDefined()
  })
})

describe('Player-Compositor Integration - Attaching Players', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player
  let compositor: Compositor
  let playerCompositor: PlayerCompositor

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
    player = await createPlayer(demuxer)
    compositor = createCompositor(640, 480)
    playerCompositor = createPlayerCompositor(compositor, { autoStart: false })
  })

  afterAll(() => {
    playerCompositor.destroy()
    player.destroy()
    demuxer.destroy()
    compositor.destroy()
  })

  it('should attach player to track', () => {
    playerCompositor.attach(0, player)

    expect(playerCompositor.slots[0]).not.toBeNull()
    expect(playerCompositor.slots[0]?.player).toBe(player)
    expect(playerCompositor.slots[0]?.trackIndex).toBe(0)
  })

  it('should detach player from track', () => {
    playerCompositor.attach(0, player)
    playerCompositor.detach(0)

    expect(playerCompositor.slots[0]).toBeNull()
  })

  it('should throw for invalid track index', () => {
    expect(() => playerCompositor.attach(5, player)).toThrow()
    expect(() => playerCompositor.attach(-1, player)).toThrow()
  })

  it('should replace existing player on same track', async () => {
    const demuxer2 = await createDemuxer(testBuffer)
    const player2 = await createPlayer(demuxer2)

    playerCompositor.attach(0, player)
    playerCompositor.attach(0, player2)

    expect(playerCompositor.slots[0]?.player).toBe(player2)

    player2.destroy()
    demuxer2.destroy()
  })
})

describe('Player-Compositor Integration - Rendering', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let player: Player
  let compositor: Compositor
  let playerCompositor: PlayerCompositor

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
    player = await createPlayer(demuxer)
    compositor = createCompositor(640, 480)
    playerCompositor = createPlayerCompositor(compositor, { autoStart: false })
  })

  afterAll(() => {
    playerCompositor.destroy()
    player.destroy()
    demuxer.destroy()
    compositor.destroy()
  })

  it('should start and stop render loop', () => {
    playerCompositor.start()
    // Should not throw
    playerCompositor.stop()
  })

  it('should render frame manually', async () => {
    playerCompositor.attach(0, player)

    // Seek to get a frame buffered
    await player.seek(0)

    // Should not throw
    playerCompositor.renderFrame()
  })

  it('should render with multiple players', async () => {
    const demuxer2 = await createDemuxer(testBuffer)
    const player2 = await createPlayer(demuxer2)

    playerCompositor.attach(0, player)
    playerCompositor.attach(1, player2)

    await player.seek(0)
    await player2.seek(0)

    // Should render both
    playerCompositor.renderFrame()

    player2.destroy()
    demuxer2.destroy()
  })
})

describe('Player-Compositor Integration - Multi-Track Setup', () => {
  let testBuffer: ArrayBuffer
  let demuxer1: Demuxer
  let demuxer2: Demuxer
  let player1: Player
  let player2: Player
  let compositor: Compositor

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer1 = await createDemuxer(testBuffer)
    demuxer2 = await createDemuxer(testBuffer)
    player1 = await createPlayer(demuxer1)
    player2 = await createPlayer(demuxer2)
    compositor = createCompositor(640, 480)
  })

  afterAll(() => {
    demuxer1.destroy()
    demuxer2.destroy()
    compositor.destroy()
  })

  it('should create multi-track setup', () => {
    const setup = createMultiTrackSetup([player1, player2], compositor)

    expect(setup.players.length).toBe(2)
    expect(setup.playerCompositor).toBeDefined()

    setup.destroy()
  })

  it('should play all tracks', async () => {
    const p1 = await createPlayer(await createDemuxer(testBuffer))
    const p2 = await createPlayer(await createDemuxer(testBuffer))
    const setup = createMultiTrackSetup([p1, p2], compositor)

    await setup.playAll()

    expect(p1.state).toBe('playing')
    expect(p2.state).toBe('playing')

    setup.destroy()
  })

  it('should pause all tracks', async () => {
    const p1 = await createPlayer(await createDemuxer(testBuffer))
    const p2 = await createPlayer(await createDemuxer(testBuffer))
    const setup = createMultiTrackSetup([p1, p2], compositor)

    await setup.playAll()
    setup.pauseAll()

    expect(p1.state).toBe('paused')
    expect(p2.state).toBe('paused')

    setup.destroy()
  })

  it('should stop all tracks', async () => {
    const p1 = await createPlayer(await createDemuxer(testBuffer))
    const p2 = await createPlayer(await createDemuxer(testBuffer))
    const setup = createMultiTrackSetup([p1, p2], compositor)

    await setup.playAll()
    setup.stopAll()

    expect(p1.state).toBe('ready')
    expect(p2.state).toBe('ready')

    setup.destroy()
  })

  it('should seek all tracks', async () => {
    const p1 = await createPlayer(await createDemuxer(testBuffer))
    const p2 = await createPlayer(await createDemuxer(testBuffer))
    const setup = createMultiTrackSetup([p1, p2], compositor)

    await setup.seekAll(0.5)

    // Both should have buffered content around 0.5
    expect(p1.frameBuffer?.frameCount).toBeGreaterThan(0)
    expect(p2.frameBuffer?.frameCount).toBeGreaterThan(0)

    setup.destroy()
  })
})

describe('Compositor - VideoFrame Support', () => {
  let compositor: Compositor

  beforeAll(() => {
    compositor = createCompositor(640, 480)
  })

  afterAll(() => {
    compositor.destroy()
  })

  it('should accept VideoFrame via setFrame', () => {
    // Create a simple VideoFrame
    const frame = new VideoFrame(new Uint8Array(640 * 480 * 4), {
      format: 'RGBA',
      codedWidth: 640,
      codedHeight: 480,
      timestamp: 0,
    })

    // Should not throw
    compositor.setFrame(0, frame)
    compositor.render()

    frame.close()
  })

  it('should accept null to clear frame', () => {
    compositor.setFrame(0, null)
    compositor.render()
    // Should not throw
  })

  it('should support setSource for both video elements and frames', () => {
    const frame = new VideoFrame(new Uint8Array(640 * 480 * 4), {
      format: 'RGBA',
      codedWidth: 640,
      codedHeight: 480,
      timestamp: 0,
    })

    compositor.setSource(0, frame)
    compositor.setSource(1, null)
    compositor.render()

    frame.close()
  })
})
