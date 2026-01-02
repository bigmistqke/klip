import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDemuxer, type Demuxer } from '../demuxer'
import {
  createVideoDecoder,
  isVideoDecoderSupported,
  isCodecSupported,
  type VideoDecoderHandle,
} from '../video-decoder'

// We need to load test fixtures via fetch in the browser
async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const response = await fetch(`/src/lib/media/__tests__/fixtures/${filename}`)
  if (!response.ok) {
    throw new Error(`Failed to load fixture: ${filename}`)
  }
  return response.arrayBuffer()
}

describe('Video Decoder - Codec Support', () => {
  it('should detect WebCodecs support', () => {
    const supported = isVideoDecoderSupported()
    expect(supported).toBe(true)
  })

  it('should detect VP9 codec support', async () => {
    // VP9 is royalty-free and included in Chromium
    const supported = await isCodecSupported('vp09.00.10.08')
    expect(supported).toBe(true)
  })

  it('should return false for invalid codec', async () => {
    const supported = await isCodecSupported('invalid-codec')
    expect(supported).toBe(false)
  })
})

describe('Video Decoder - Codec Configuration', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should get video decoder config', async () => {
    const videoTrack = demuxer.info.videoTracks[0]
    const config = await demuxer.getVideoConfig()

    expect(config.codec).toBeDefined()
    expect(config.codec.length).toBeGreaterThan(0)
    expect(config.codedWidth).toBe(videoTrack.width)
    expect(config.codedHeight).toBe(videoTrack.height)
  })

  it('should have valid codec string format for VP9', async () => {
    const config = await demuxer.getVideoConfig()

    // VP9 codec string format
    expect(config.codec).toMatch(/^vp09/)
  })
})

describe('Video Decoder - Decoding (VP9)', () => {
  // Use VP9 file because it's royalty-free and supported in Chromium
  // H.264 is not included in Chromium due to licensing (only in Chrome)
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let decoder: VideoDecoderHandle

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)

    const videoTrack = demuxer.info.videoTracks[0]
    decoder = await createVideoDecoder(demuxer, videoTrack)
  })

  afterAll(() => {
    decoder.close()
    demuxer.destroy()
  })

  it('should create video decoder', () => {
    expect(decoder).toBeDefined()
    expect(decoder.config).toBeDefined()
    expect(decoder.decoder).toBeDefined()
    expect(decoder.config.codec).toMatch(/^vp09/)
  })

  it('should decode a keyframe', async () => {
    const videoTrack = demuxer.info.videoTracks[0]

    // Reset to ensure clean state
    await decoder.reset()

    // Get samples from the beginning
    const samples = await demuxer.getSamples(videoTrack.id, 0, 0.5)
    const firstKeyframe = samples.find((s) => s.isKeyframe)

    expect(firstKeyframe).toBeDefined()
    expect(firstKeyframe!.data.byteLength).toBeGreaterThan(0)

    const frame = await decoder.decode(firstKeyframe!)

    expect(frame).toBeInstanceOf(VideoFrame)
    expect(frame.displayWidth).toBe(videoTrack.width)
    expect(frame.displayHeight).toBe(videoTrack.height)

    frame.close()
  })

  it('should decode multiple frames', async () => {
    const videoTrack = demuxer.info.videoTracks[0]

    // Reset decoder before decoding new sequence
    await decoder.reset()

    // Get first few samples (starting from keyframe)
    const samples = await demuxer.getSamples(videoTrack.id, 0, 0.5)
    expect(samples.length).toBeGreaterThan(0)

    const frames = await decoder.decodeAll(samples)

    expect(frames.length).toBeGreaterThan(0)

    for (const frame of frames) {
      expect(frame).toBeInstanceOf(VideoFrame)
      frame.close()
    }
  })

  it('should flush pending frames', async () => {
    await decoder.reset()
    await decoder.flush()
    // Should not throw
  })

  it('should reset decoder state', async () => {
    await decoder.reset()

    // After reset, decoder should be ready for new sequence
    expect(decoder.decoder.state).toBe('configured')
  })
})

describe('Video Decoder - Error Handling', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should throw for invalid track ID when getting samples', async () => {
    await expect(demuxer.getAllSamples(9999)).rejects.toThrow('Track 9999 not found')
  })
})
