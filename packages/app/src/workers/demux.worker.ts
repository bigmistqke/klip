import { expose } from '@bigmistqke/rpc/messenger'
import type { AudioTrackInfo, DemuxedSample, DemuxerInfo, VideoTrackInfo } from '@eddy/codecs'
import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny'

export interface DemuxWorkerMethods {
  /** Initialize demuxer with file data */
  init(buffer: ArrayBuffer): Promise<DemuxerInfo>

  /** Get WebCodecs VideoDecoderConfig */
  getVideoConfig(): Promise<VideoDecoderConfig>

  /** Get WebCodecs AudioDecoderConfig */
  getAudioConfig(): Promise<AudioDecoderConfig>

  /** Get samples in time range */
  getSamples(trackId: number, startTime: number, endTime: number): Promise<DemuxedSample[]>

  /** Get all samples from track */
  getAllSamples(trackId: number): Promise<DemuxedSample[]>

  /** Find keyframe at or before time */
  getKeyframeBefore(trackId: number, time: number): Promise<DemuxedSample | null>

  /** Clean up resources */
  destroy(): void
}

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

function packetToSample(
  packet: EncodedPacket,
  trackId: number,
  sampleNumber: number,
): DemuxedSample {
  return {
    number: sampleNumber,
    trackId,
    pts: packet.timestamp,
    dts: packet.timestamp,
    duration: packet.duration,
    isKeyframe: packet.type === 'key',
    data: packet.data,
    size: packet.data.byteLength,
  }
}

async function parseVideoTrack(track: InputVideoTrack, index: number): Promise<VideoTrackInfo> {
  const codecString = await track.getCodecParameterString()
  return {
    id: track.id,
    index,
    codec: codecString ?? 'unknown',
    width: track.codedWidth,
    height: track.codedHeight,
    duration: await track.computeDuration(),
    timescale: 1,
    sampleCount: 0,
    bitrate: 0,
  }
}

async function parseAudioTrack(track: InputAudioTrack, index: number): Promise<AudioTrackInfo> {
  const codecString = await track.getCodecParameterString()
  return {
    id: track.id,
    index,
    codec: codecString ?? 'unknown',
    sampleRate: track.sampleRate,
    channelCount: track.numberOfChannels,
    sampleSize: 16,
    duration: await track.computeDuration(),
    timescale: 1,
    sampleCount: 0,
    bitrate: 0,
  }
}

/**********************************************************************************/
/*                                                                                */
/*                                     Methods                                    */
/*                                                                                */
/**********************************************************************************/

// Worker state
let input: Input | null = null
let videoTracks: InputVideoTrack[] = []
let audioTracks: InputAudioTrack[] = []
let videoTrackMap = new Map<number, { track: InputVideoTrack; sink: EncodedPacketSink }>()
let audioTrackMap = new Map<number, { track: InputAudioTrack; sink: EncodedPacketSink }>()

function getTrackData(trackId: number) {
  return videoTrackMap.get(trackId) ?? audioTrackMap.get(trackId) ?? null
}

expose<DemuxWorkerMethods>({
  async init(buffer) {
    // Clean up previous instance
    if (input) {
      input[Symbol.dispose]?.()
    }

    const blob = new Blob([buffer])
    input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    })

    // Get tracks
    videoTracks = await input.getVideoTracks()
    audioTracks = await input.getAudioTracks()

    // Parse track info
    const videoTrackInfos = await Promise.all(
      videoTracks.map((track, index) => parseVideoTrack(track, index)),
    )
    const audioTrackInfos = await Promise.all(
      audioTracks.map((track, index) => parseAudioTrack(track, index)),
    )

    // Build track lookup maps
    videoTrackMap = new Map()
    audioTrackMap = new Map()

    for (const track of videoTracks) {
      videoTrackMap.set(track.id, {
        track,
        sink: new EncodedPacketSink(track),
      })
    }

    for (const track of audioTracks) {
      audioTrackMap.set(track.id, {
        track,
        sink: new EncodedPacketSink(track),
      })
    }

    const duration = await input.computeDuration()

    return {
      duration,
      timescale: 1,
      isFragmented: false,
      videoTracks: videoTrackInfos,
      audioTracks: audioTrackInfos,
    }
  },

  async getVideoConfig() {
    if (videoTracks.length === 0) {
      throw new Error('No video track available')
    }
    const config = await videoTracks[0].getDecoderConfig()
    if (!config) {
      throw new Error('Could not get video decoder config')
    }
    return config
  },

  async getAudioConfig() {
    if (audioTracks.length === 0) {
      throw new Error('No audio track available')
    }
    const config = await audioTracks[0].getDecoderConfig()
    if (!config) {
      throw new Error('Could not get audio decoder config')
    }
    return config
  },

  async getSamples(trackId, startTime, endTime) {
    const trackData = getTrackData(trackId)
    if (!trackData) {
      throw new Error(`Track ${trackId} not found`)
    }

    if (endTime <= startTime) {
      return []
    }

    const { sink } = trackData
    const samples: DemuxedSample[] = []

    try {
      let packet = await sink.getPacket(startTime)
      if (!packet) {
        packet = await sink.getFirstPacket()
      }

      let sampleNumber = 0
      while (packet && packet.timestamp < endTime) {
        if (packet.timestamp >= startTime - packet.duration) {
          samples.push(packetToSample(packet, trackId, sampleNumber++))
        }
        packet = await sink.getNextPacket(packet)
      }
    } catch {
      // Return what we have on error
    }

    return samples
  },

  async getAllSamples(trackId) {
    const trackData = getTrackData(trackId)
    if (!trackData) {
      throw new Error(`Track ${trackId} not found`)
    }

    const { sink } = trackData
    const samples: DemuxedSample[] = []

    try {
      let sampleNumber = 0
      for await (const packet of sink.packets()) {
        samples.push(packetToSample(packet, trackId, sampleNumber++))
      }
    } catch {
      // Return what we have on error
    }

    return samples
  },

  async getKeyframeBefore(trackId, time) {
    const trackData = getTrackData(trackId)
    if (!trackData) {
      throw new Error(`Track ${trackId} not found`)
    }

    try {
      const { sink } = trackData
      const packet = await sink.getKeyPacket(time)
      if (!packet) return null
      return packetToSample(packet, trackId, 0)
    } catch {
      return null
    }
  },

  destroy() {
    if (input) {
      input[Symbol.dispose]?.()
      input = null
    }
    videoTracks = []
    audioTracks = []
    videoTrackMap.clear()
    audioTrackMap.clear()
  },
})
