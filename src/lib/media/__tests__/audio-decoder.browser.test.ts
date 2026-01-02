import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDemuxer, type Demuxer } from '../demuxer'
import {
  createAudioDecoder,
  isAudioDecoderSupported,
  isAudioCodecSupported,
  type AudioDecoderHandle,
} from '../audio-decoder'

// Load test fixtures via fetch in the browser
async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const response = await fetch(`/src/lib/media/__tests__/fixtures/${filename}`)
  if (!response.ok) {
    throw new Error(`Failed to load fixture: ${filename}`)
  }
  return response.arrayBuffer()
}

describe('Audio Decoder - Codec Support', () => {
  it('should detect WebCodecs AudioDecoder support', () => {
    const supported = isAudioDecoderSupported()
    expect(supported).toBe(true)
  })

  it('should detect Opus codec support', async () => {
    // Opus is royalty-free and included in Chromium
    const supported = await isAudioCodecSupported('opus')
    expect(supported).toBe(true)
  })

  it('should return false for invalid codec', async () => {
    const supported = await isAudioCodecSupported('invalid-codec')
    expect(supported).toBe(false)
  })
})

describe('Audio Decoder - Codec Configuration', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-opus.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should have audio tracks', () => {
    expect(demuxer.info.audioTracks.length).toBeGreaterThan(0)
  })

  it('should get audio decoder config', async () => {
    const audioTrack = demuxer.info.audioTracks[0]
    const config = await demuxer.getAudioConfig()

    expect(config.codec).toBeDefined()
    expect(config.codec.length).toBeGreaterThan(0)
    expect(config.sampleRate).toBe(audioTrack.sampleRate)
    expect(config.numberOfChannels).toBe(audioTrack.channelCount)
  })

  it('should have codec description for Opus', async () => {
    const config = await demuxer.getAudioConfig()

    // Opus requires dOps description
    if (config.codec.startsWith('opus') || config.codec === 'opus') {
      // web-demuxer returns Uint8Array, which is valid for WebCodecs
      expect(config.description).toBeDefined()
      const desc = config.description as Uint8Array | ArrayBuffer
      const length = desc instanceof ArrayBuffer ? desc.byteLength : desc.length
      expect(length).toBeGreaterThan(0)
    }
  })
})

describe('Audio Decoder - Decoding (Opus)', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer
  let decoder: AudioDecoderHandle

  beforeAll(async () => {
    testBuffer = await loadFixture('test-opus.webm')
    demuxer = await createDemuxer(testBuffer)

    const audioTrack = demuxer.info.audioTracks[0]
    decoder = await createAudioDecoder(demuxer, audioTrack)
  })

  afterAll(() => {
    decoder.close()
    demuxer.destroy()
  })

  it('should create audio decoder', () => {
    expect(decoder).toBeDefined()
    expect(decoder.config).toBeDefined()
    expect(decoder.decoder).toBeDefined()
  })

  it('should decode an audio sample', async () => {
    const audioTrack = demuxer.info.audioTracks[0]

    // Reset to ensure clean state
    await decoder.reset()

    // Get samples from the beginning
    const samples = await demuxer.getSamples(audioTrack.id, 0, 0.5)
    expect(samples.length).toBeGreaterThan(0)

    const firstSample = samples[0]
    expect(firstSample.data.byteLength).toBeGreaterThan(0)

    const audioData = await decoder.decode(firstSample)

    expect(audioData).toBeInstanceOf(AudioData)
    expect(audioData.sampleRate).toBe(audioTrack.sampleRate)
    // WebCodecs may upmix mono to stereo, so just check it's at least the source channel count
    expect(audioData.numberOfChannels).toBeGreaterThanOrEqual(audioTrack.channelCount)

    audioData.close()
  })

  it('should decode multiple samples', async () => {
    const audioTrack = demuxer.info.audioTracks[0]

    // Reset decoder before decoding new sequence
    await decoder.reset()

    // Get samples
    const samples = await demuxer.getSamples(audioTrack.id, 0, 0.5)
    expect(samples.length).toBeGreaterThan(0)

    const audioDataList = await decoder.decodeAll(samples)

    expect(audioDataList.length).toBeGreaterThan(0)

    for (const audioData of audioDataList) {
      expect(audioData).toBeInstanceOf(AudioData)
      audioData.close()
    }
  })

  it('should flush pending data', async () => {
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

describe('Audio Decoder - Error Handling', () => {
  let testBuffer: ArrayBuffer
  let demuxer: Demuxer

  beforeAll(async () => {
    testBuffer = await loadFixture('test-opus.webm')
    demuxer = await createDemuxer(testBuffer)
  })

  afterAll(() => {
    demuxer.destroy()
  })

  it('should throw for invalid track ID when getting samples', async () => {
    await expect(demuxer.getAllSamples(9999)).rejects.toThrow('Track 9999 not found')
  })
})
