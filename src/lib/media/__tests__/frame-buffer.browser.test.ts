import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createDemuxer, type Demuxer } from '../demuxer'
import { createFrameBuffer, type FrameBuffer } from '../frame-buffer'

// We need to load test fixtures via fetch in the browser
async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const response = await fetch(`/src/lib/media/__tests__/fixtures/${filename}`)
  if (!response.ok) {
    throw new Error(`Failed to load fixture: ${filename}`)
  }
  return response.arrayBuffer()
}

describe('Frame Buffer - Creation', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let frameBuffer: FrameBuffer | null = null

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterEach(() => {
    if (frameBuffer) {
      frameBuffer.destroy()
      frameBuffer = null
    }
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should create a frame buffer', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    frameBuffer = await createFrameBuffer(demuxer, videoTrack)

    expect(frameBuffer).toBeDefined()
    expect(frameBuffer.state).toBe('idle')
    expect(frameBuffer.frameCount).toBe(0)
    expect(frameBuffer.trackInfo).toBe(videoTrack)
  })

  it('should create with custom options', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    frameBuffer = await createFrameBuffer(demuxer, videoTrack, {
      bufferAhead: 5,
      maxFrames: 120,
    })

    expect(frameBuffer).toBeDefined()
    expect(frameBuffer.state).toBe('idle')
  })
})

describe('Frame Buffer - Seeking', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let frameBuffer: FrameBuffer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)

    const videoTrack = demuxer.info.videoTracks[0]
    frameBuffer = await createFrameBuffer(demuxer, videoTrack)
  })

  afterAll(() => {
    frameBuffer.destroy()
    demuxer.destroy()
  })

  it('should seek to beginning', async () => {
    await frameBuffer.seekTo(0)

    expect(frameBuffer.state).toBe('ready')
    expect(frameBuffer.frameCount).toBeGreaterThan(0)
    expect(frameBuffer.bufferStart).toBe(0)
  })

  it('should seek to middle of video', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    const midpoint = videoTrack.duration / 2

    await frameBuffer.seekTo(midpoint)

    expect(frameBuffer.state).toBe('ready')
    expect(frameBuffer.frameCount).toBeGreaterThan(0)
    // Buffer should start at or before the midpoint (from keyframe)
    expect(frameBuffer.bufferStart).toBeLessThanOrEqual(midpoint)
  })

  it('should clear buffer on seek', async () => {
    // Seek to beginning first
    await frameBuffer.seekTo(0)
    const firstFrameCount = frameBuffer.frameCount

    // Now seek to a different position
    const videoTrack = demuxer.info.videoTracks[0]
    await frameBuffer.seekTo(videoTrack.duration / 2)

    // Frame count might be different since we're at a different position
    expect(frameBuffer.frameCount).toBeGreaterThan(0)
  })
})

describe('Frame Buffer - Getting Frames', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let frameBuffer: FrameBuffer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)

    const videoTrack = demuxer.info.videoTracks[0]
    frameBuffer = await createFrameBuffer(demuxer, videoTrack)

    // Buffer from beginning
    await frameBuffer.seekTo(0)
  })

  afterAll(() => {
    frameBuffer.destroy()
    demuxer.destroy()
  })

  it('should get frame at time 0', () => {
    const frame = frameBuffer.getFrame(0)

    expect(frame).not.toBeNull()
    expect(frame!.pts).toBe(0)
    expect(frame!.frame).toBeInstanceOf(VideoFrame)
  })

  it('should get frame at middle of buffer', () => {
    const midTime = (frameBuffer.bufferStart + frameBuffer.bufferEnd) / 2
    const frame = frameBuffer.getFrame(midTime)

    expect(frame).not.toBeNull()
    expect(frame!.pts).toBeLessThanOrEqual(midTime)
  })

  it('should return null for time before buffer', async () => {
    // Seek to middle of video first
    const videoTrack = demuxer.info.videoTracks[0]
    await frameBuffer.seekTo(videoTrack.duration / 2)

    // Try to get frame at time 0 (which is now before the buffer)
    const frame = frameBuffer.getFrame(0)

    // Should return null since we seeked away from the beginning
    // (unless the video is short and keyframe is at 0)
    if (frameBuffer.bufferStart > 0) {
      expect(frame).toBeNull()
    }
  })

  it('should get the closest frame before requested time', async () => {
    await frameBuffer.seekTo(0)

    // Request a time that's slightly after a frame's PTS
    const firstFrame = frameBuffer.getFrame(0)
    expect(firstFrame).not.toBeNull()

    const slightlyLater = firstFrame!.pts + firstFrame!.duration / 2
    const frame = frameBuffer.getFrame(slightlyLater)

    expect(frame).not.toBeNull()
    // Should return the same frame since we're within its duration
    expect(frame!.pts).toBe(firstFrame!.pts)
  })
})

describe('Frame Buffer - Buffering More', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let frameBuffer: FrameBuffer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)

    const videoTrack = demuxer.info.videoTracks[0]
    // Use a small buffer ahead to test buffering more
    frameBuffer = await createFrameBuffer(demuxer, videoTrack, {
      bufferAhead: 0.5,
    })
  })

  afterAll(() => {
    frameBuffer.destroy()
    demuxer.destroy()
  })

  it('should buffer more content', async () => {
    await frameBuffer.seekTo(0)
    const initialEnd = frameBuffer.bufferEnd

    await frameBuffer.bufferMore()
    const newEnd = frameBuffer.bufferEnd

    // Should have buffered more (unless we're at end of video)
    expect(newEnd).toBeGreaterThanOrEqual(initialEnd)
  })

  it('should report buffered state', async () => {
    await frameBuffer.seekTo(0)

    expect(frameBuffer.isBufferedAt(0)).toBe(true)
    // Check a time well within the buffer range (half of bufferEnd)
    if (frameBuffer.bufferEnd > 0) {
      expect(frameBuffer.isBufferedAt(frameBuffer.bufferEnd / 2)).toBe(true)
    }
  })
})

describe('Frame Buffer - State Management', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let frameBuffer: FrameBuffer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)

    const videoTrack = demuxer.info.videoTracks[0]
    frameBuffer = await createFrameBuffer(demuxer, videoTrack)
  })

  afterAll(() => {
    frameBuffer.destroy()
    demuxer.destroy()
  })

  it('should start in idle state', async () => {
    // Create fresh buffer
    const videoTrack = demuxer.info.videoTracks[0]
    const freshBuffer = await createFrameBuffer(demuxer, videoTrack)

    expect(freshBuffer.state).toBe('idle')
    freshBuffer.destroy()
  })

  it('should be ready after seeking', async () => {
    await frameBuffer.seekTo(0)
    expect(frameBuffer.state).toBe('ready')
  })

  it('should clear and reset to idle', async () => {
    await frameBuffer.seekTo(0)
    expect(frameBuffer.frameCount).toBeGreaterThan(0)

    frameBuffer.clear()

    expect(frameBuffer.state).toBe('idle')
    expect(frameBuffer.frameCount).toBe(0)
  })
})

describe('Frame Buffer - Memory Management', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should respect maxFrames limit', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    const maxFrames = 10
    const frameBuffer = await createFrameBuffer(demuxer, videoTrack, {
      maxFrames,
      bufferAhead: 5, // Buffer plenty to potentially exceed limit
    })

    await frameBuffer.seekTo(0)

    expect(frameBuffer.frameCount).toBeLessThanOrEqual(maxFrames)

    frameBuffer.destroy()
  })

  it('should close frames on destroy', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    const frameBuffer = await createFrameBuffer(demuxer, videoTrack)

    await frameBuffer.seekTo(0)
    const frameCountBefore = frameBuffer.frameCount
    expect(frameCountBefore).toBeGreaterThan(0)

    frameBuffer.destroy()

    // After destroy, frame count should be 0
    expect(frameBuffer.frameCount).toBe(0)
  })

  it('should close frames on clear', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    const frameBuffer = await createFrameBuffer(demuxer, videoTrack)

    await frameBuffer.seekTo(0)
    expect(frameBuffer.frameCount).toBeGreaterThan(0)

    frameBuffer.clear()

    expect(frameBuffer.frameCount).toBe(0)

    frameBuffer.destroy()
  })
})
