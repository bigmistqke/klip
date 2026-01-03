import {
  Input,
  BlobSource,
  EncodedPacketSink,
  ALL_FORMATS,
  type InputVideoTrack,
  type InputAudioTrack,
  type EncodedPacket,
} from 'mediabunny'

export interface VideoTrackInfo {
  id: number
  index: number
  codec: string
  width: number
  height: number
  duration: number
  timescale: number
  sampleCount: number
  bitrate: number
}

export interface AudioTrackInfo {
  id: number
  index: number
  codec: string
  sampleRate: number
  channelCount: number
  sampleSize: number
  duration: number
  timescale: number
  sampleCount: number
  bitrate: number
}

export interface DemuxerInfo {
  duration: number
  timescale: number
  isFragmented: boolean
  videoTracks: VideoTrackInfo[]
  audioTracks: AudioTrackInfo[]
}

/** Normalized sample with timestamps in seconds */
export interface DemuxedSample {
  /** Sample number (0-indexed) */
  number: number
  /** Track ID this sample belongs to */
  trackId: number
  /** Presentation timestamp in seconds */
  pts: number
  /** Decode timestamp in seconds */
  dts: number
  /** Duration in seconds */
  duration: number
  /** Whether this is a sync/keyframe sample */
  isKeyframe: boolean
  /** Raw sample data */
  data: Uint8Array
  /** Size in bytes */
  size: number
}

export interface Demuxer {
  readonly info: DemuxerInfo

  /**
   * Get WebCodecs VideoDecoderConfig for the video track
   */
  getVideoConfig(): Promise<VideoDecoderConfig>

  /**
   * Get WebCodecs AudioDecoderConfig for the audio track
   */
  getAudioConfig(): Promise<AudioDecoderConfig>

  /**
   * Get samples from a track within a time range
   * @param trackId - The track ID to extract samples from
   * @param startTime - Start time in seconds
   * @param endTime - End time in seconds
   * @returns Promise resolving to array of samples
   */
  getSamples(trackId: number, startTime: number, endTime: number): Promise<DemuxedSample[]>

  /**
   * Get all samples from a track
   * @param trackId - The track ID to extract samples from
   * @returns Promise resolving to array of all samples
   */
  getAllSamples(trackId: number): Promise<DemuxedSample[]>

  /**
   * Find the keyframe at or before the given time
   * @param trackId - The track ID
   * @param time - Time in seconds
   * @returns The keyframe sample or null if not found
   */
  getKeyframeBefore(trackId: number, time: number): Promise<DemuxedSample | null>

  destroy(): void
}

function packetToSample(packet: EncodedPacket, trackId: number, sampleNumber: number): DemuxedSample {
  return {
    number: sampleNumber,
    trackId,
    pts: packet.timestamp,
    dts: packet.timestamp, // Mediabunny doesn't expose DTS separately
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
    timescale: 1, // Mediabunny uses seconds directly
    sampleCount: 0, // Not easily available without iterating
    bitrate: 0, // Not exposed directly
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
    sampleSize: 16, // Default, not exposed directly
    duration: await track.computeDuration(),
    timescale: 1, // Mediabunny uses seconds directly
    sampleCount: 0, // Not easily available without iterating
    bitrate: 0, // Not exposed directly
  }
}

export async function createDemuxer(source: ArrayBuffer | Blob): Promise<Demuxer> {
  // Convert ArrayBuffer to Blob if needed
  const blob = source instanceof Blob ? source : new Blob([source])

  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  })

  // Get tracks
  const videoTracks = await input.getVideoTracks()
  const audioTracks = await input.getAudioTracks()

  // Parse track info
  const videoTrackInfos = await Promise.all(
    videoTracks.map((track, index) => parseVideoTrack(track, index))
  )
  const audioTrackInfos = await Promise.all(
    audioTracks.map((track, index) => parseAudioTrack(track, index))
  )

  // Compute overall duration
  const duration = await input.computeDuration()

  const info: DemuxerInfo = {
    duration,
    timescale: 1,
    isFragmented: false,
    videoTracks: videoTrackInfos,
    audioTracks: audioTrackInfos,
  }

  // Build track lookup maps
  const videoTrackMap = new Map<number, { track: InputVideoTrack, sink: EncodedPacketSink }>()
  const audioTrackMap = new Map<number, { track: InputAudioTrack, sink: EncodedPacketSink }>()

  for (let i = 0; i < videoTracks.length; i++) {
    const track = videoTracks[i]
    videoTrackMap.set(track.id, {
      track,
      sink: new EncodedPacketSink(track),
    })
  }

  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i]
    audioTrackMap.set(track.id, {
      track,
      sink: new EncodedPacketSink(track),
    })
  }

  // Helper to get track and sink by ID
  const getTrackData = (trackId: number) => {
    return videoTrackMap.get(trackId) ?? audioTrackMap.get(trackId) ?? null
  }

  return {
    info,

    async getVideoConfig(): Promise<VideoDecoderConfig> {
      if (videoTracks.length === 0) {
        throw new Error('No video track available')
      }
      const config = await videoTracks[0].getDecoderConfig()
      if (!config) {
        throw new Error('Could not get video decoder config')
      }
      return config
    },

    async getAudioConfig(): Promise<AudioDecoderConfig> {
      if (audioTracks.length === 0) {
        throw new Error('No audio track available')
      }
      const config = await audioTracks[0].getDecoderConfig()
      if (!config) {
        throw new Error('Could not get audio decoder config')
      }
      return config
    },

    async getSamples(trackId: number, startTime: number, endTime: number): Promise<DemuxedSample[]> {
      const trackData = getTrackData(trackId)
      if (!trackData) {
        throw new Error(`Track ${trackId} not found`)
      }

      // Skip if time range is invalid
      if (endTime <= startTime) {
        return []
      }

      const { sink } = trackData
      const samples: DemuxedSample[] = []

      try {
        // Get the packet at or before startTime
        let packet = await sink.getPacket(startTime)
        if (!packet) {
          // Try getting the first packet
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

    async getAllSamples(trackId: number): Promise<DemuxedSample[]> {
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

    async getKeyframeBefore(trackId: number, time: number): Promise<DemuxedSample | null> {
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
      input[Symbol.dispose]?.()
    },
  }
}
