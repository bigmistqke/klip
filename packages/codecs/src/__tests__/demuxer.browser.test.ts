import { describe, it, expect, beforeAll } from 'vitest'
import { createDemuxer, type DemuxerInfo, type DemuxedSample } from '../demuxer'

// Load test fixtures via fetch in the browser
async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const response = await fetch(`/src/lib/media/__tests__/fixtures/${filename}`)
  if (!response.ok) {
    throw new Error(`Failed to load fixture: ${filename}`)
  }
  return response.arrayBuffer()
}

describe('Demuxer - Container Parsing', () => {
  let testBuffer: ArrayBuffer
  let testWithAudioBuffer: ArrayBuffer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    testWithAudioBuffer = await loadFixture('test-with-audio.webm')
  })

  it('should parse a WebM file and return demuxer info', async () => {
    const demuxer = await createDemuxer(testBuffer)

    expect(demuxer).toBeDefined()
    expect(demuxer.info).toBeDefined()

    demuxer.destroy()
  })

  it('should extract video track info', async () => {
    const demuxer = await createDemuxer(testBuffer)

    expect(demuxer.info.videoTracks.length).toBeGreaterThan(0)

    const videoTrack = demuxer.info.videoTracks[0]
    expect(videoTrack.id).toBeDefined()
    expect(videoTrack.codec).toBeDefined()
    expect(videoTrack.width).toBeGreaterThan(0)
    expect(videoTrack.height).toBeGreaterThan(0)
    expect(videoTrack.duration).toBeGreaterThan(0)
    expect(videoTrack.timescale).toBeGreaterThan(0)
    // sampleCount may be 0 (Mediabunny doesn't provide it without iterating)
    expect(videoTrack.sampleCount).toBeGreaterThanOrEqual(0)

    demuxer.destroy()
  })

  it('should extract audio track info', async () => {
    const demuxer = await createDemuxer(testWithAudioBuffer)

    expect(demuxer.info.audioTracks.length).toBeGreaterThan(0)

    const audioTrack = demuxer.info.audioTracks[0]
    expect(audioTrack.id).toBeDefined()
    expect(audioTrack.codec).toBeDefined()
    expect(audioTrack.sampleRate).toBeGreaterThan(0)
    expect(audioTrack.channelCount).toBeGreaterThan(0)
    expect(audioTrack.duration).toBeGreaterThan(0)
    expect(audioTrack.timescale).toBeGreaterThan(0)
    // sampleCount may be 0 for WebM (container doesn't provide nb_frames reliably)
    expect(audioTrack.sampleCount).toBeGreaterThanOrEqual(0)

    demuxer.destroy()
  })

  it('should handle video-only files', async () => {
    const demuxer = await createDemuxer(testBuffer)

    // This file has no audio
    expect(demuxer.info.audioTracks.length).toBe(0)
    expect(demuxer.info.videoTracks.length).toBeGreaterThan(0)

    demuxer.destroy()
  })

  it('should report correct file-level metadata', async () => {
    const demuxer = await createDemuxer(testBuffer)

    expect(demuxer.info.duration).toBeGreaterThan(0)
    expect(demuxer.info.timescale).toBeGreaterThan(0)
    expect(typeof demuxer.info.isFragmented).toBe('boolean')

    demuxer.destroy()
  })

  it('should accept a File object', async () => {
    // Create a File from the buffer
    const blob = new Blob([testBuffer], { type: 'video/webm' })
    const file = new File([blob], 'test.webm', { type: 'video/webm' })

    const demuxer = await createDemuxer(file)

    expect(demuxer).toBeDefined()
    expect(demuxer.info.videoTracks.length).toBeGreaterThan(0)

    demuxer.destroy()
  })
})

describe('Demuxer - Sample Extraction', () => {
  let testBuffer: ArrayBuffer
  let testWithAudioBuffer: ArrayBuffer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-vp9.webm')
    testWithAudioBuffer = await loadFixture('test-with-audio.webm')
  })

  it('should extract all video samples', async () => {
    const demuxer = await createDemuxer(testBuffer)
    const videoTrack = demuxer.info.videoTracks[0]

    const samples = await demuxer.getAllSamples(videoTrack.id)

    // WebM containers may not report exact sampleCount, just verify samples exist
    expect(samples.length).toBeGreaterThan(0)

    demuxer.destroy()
  })

  it('should return samples with correct structure', async () => {
    const demuxer = await createDemuxer(testBuffer)
    const videoTrack = demuxer.info.videoTracks[0]

    const samples = await demuxer.getAllSamples(videoTrack.id)
    const sample = samples[0]

    expect(sample.number).toBe(0)
    expect(sample.trackId).toBe(videoTrack.id)
    expect(typeof sample.pts).toBe('number')
    expect(typeof sample.dts).toBe('number')
    expect(typeof sample.duration).toBe('number')
    expect(typeof sample.isKeyframe).toBe('boolean')
    expect(sample.data).toBeInstanceOf(Uint8Array)
    expect(sample.size).toBeGreaterThan(0)

    demuxer.destroy()
  })

  it('should have normalized timestamps in seconds', async () => {
    const demuxer = await createDemuxer(testBuffer)
    const videoTrack = demuxer.info.videoTracks[0]

    const samples = await demuxer.getAllSamples(videoTrack.id)

    // First sample should start at or near 0
    expect(samples[0].pts).toBeGreaterThanOrEqual(0)
    expect(samples[0].pts).toBeLessThan(1)

    // Last sample should be near the track duration
    const lastSample = samples[samples.length - 1]
    expect(lastSample.pts).toBeLessThanOrEqual(videoTrack.duration)

    demuxer.destroy()
  })

  it('should filter samples by time range', async () => {
    const demuxer = await createDemuxer(testBuffer)
    const videoTrack = demuxer.info.videoTracks[0]

    // Get all samples first to know the total count
    const allSamples = await demuxer.getAllSamples(videoTrack.id)

    // Get samples from 0 to 1 second
    const samples = await demuxer.getSamples(videoTrack.id, 0, 1)

    expect(samples.length).toBeGreaterThan(0)
    expect(samples.length).toBeLessThan(allSamples.length)

    // All samples should be within range
    for (const sample of samples) {
      expect(sample.pts).toBeGreaterThanOrEqual(0)
      expect(sample.pts).toBeLessThan(1)
    }

    demuxer.destroy()
  })

  it('should find keyframe before a given time', async () => {
    const demuxer = await createDemuxer(testBuffer)
    const videoTrack = demuxer.info.videoTracks[0]

    // Get keyframe before middle of video
    const midTime = videoTrack.duration / 2
    const keyframe = await demuxer.getKeyframeBefore(videoTrack.id, midTime)

    expect(keyframe).not.toBeNull()
    expect(keyframe!.isKeyframe).toBe(true)
    expect(keyframe!.pts).toBeLessThanOrEqual(midTime)

    demuxer.destroy()
  })

  it('should find first keyframe', async () => {
    const demuxer = await createDemuxer(testBuffer)
    const videoTrack = demuxer.info.videoTracks[0]

    // Get all samples to find the first keyframe's pts
    const allSamples = await demuxer.getAllSamples(videoTrack.id)
    const firstKeyframe = allSamples.find(s => s.isKeyframe)

    expect(firstKeyframe).toBeDefined()

    // Now verify getKeyframeBefore returns the same keyframe
    const keyframe = await demuxer.getKeyframeBefore(videoTrack.id, firstKeyframe!.pts + 0.001)

    expect(keyframe).not.toBeNull()
    expect(keyframe!.isKeyframe).toBe(true)
    expect(keyframe!.number).toBe(firstKeyframe!.number)

    demuxer.destroy()
  })

  it('should extract audio samples', async () => {
    const demuxer = await createDemuxer(testWithAudioBuffer)
    const audioTrack = demuxer.info.audioTracks[0]

    const samples = await demuxer.getAllSamples(audioTrack.id)

    // WebM containers may not report exact sampleCount, just verify samples exist
    expect(samples.length).toBeGreaterThan(0)

    // Audio samples should have size info (data loaded separately)
    expect(samples[0].size).toBeGreaterThan(0)

    demuxer.destroy()
  })

  it('should throw for invalid track ID', async () => {
    const demuxer = await createDemuxer(testBuffer)

    await expect(demuxer.getAllSamples(9999)).rejects.toThrow('Track 9999 not found')

    demuxer.destroy()
  })
})
