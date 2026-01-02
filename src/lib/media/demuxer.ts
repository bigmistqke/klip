import { WebDemuxer, AVMediaType, AVSeekFlag, type WebMediaInfo, type WebAVStream, type WebAVPacket } from 'web-demuxer'

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

function parseSampleCount(nbFrames: string): number {
  const count = parseInt(nbFrames)
  // WebM containers often don't have valid nb_frames, return 0 for invalid values
  if (!Number.isFinite(count) || count < 0) {
    return 0
  }
  return count
}

function parseDuration(duration: number): number {
  // MediaRecorder WebM files may have invalid duration (AV_NOPTS_VALUE)
  if (!Number.isFinite(duration) || duration < 0) {
    return 0
  }
  return duration
}

function parseVideoTrack(stream: WebAVStream, index: number): VideoTrackInfo {
  return {
    id: stream.id,
    index,
    codec: stream.codec_string,
    width: stream.width,
    height: stream.height,
    duration: parseDuration(stream.duration),
    timescale: 1, // web-demuxer uses seconds directly
    sampleCount: parseSampleCount(stream.nb_frames),
    bitrate: parseInt(stream.bit_rate) || 0,
  }
}

function parseAudioTrack(stream: WebAVStream, index: number): AudioTrackInfo {
  return {
    id: stream.id,
    index,
    codec: stream.codec_string,
    sampleRate: stream.sample_rate,
    channelCount: stream.channels,
    sampleSize: 16, // Default, web-demuxer doesn't expose this directly
    duration: parseDuration(stream.duration),
    timescale: 1, // web-demuxer uses seconds directly
    sampleCount: parseSampleCount(stream.nb_frames),
    bitrate: parseInt(stream.bit_rate) || 0,
  }
}

function parseInfo(mediaInfo: WebMediaInfo): DemuxerInfo {
  const videoTracks: VideoTrackInfo[] = []
  const audioTracks: AudioTrackInfo[] = []

  for (const stream of mediaInfo.streams) {
    if (stream.codec_type === AVMediaType.AVMEDIA_TYPE_VIDEO) {
      videoTracks.push(parseVideoTrack(stream, stream.index))
    } else if (stream.codec_type === AVMediaType.AVMEDIA_TYPE_AUDIO) {
      audioTracks.push(parseAudioTrack(stream, stream.index))
    }
  }

  return {
    duration: parseDuration(mediaInfo.duration),
    timescale: 1, // web-demuxer uses seconds
    isFragmented: false, // web-demuxer doesn't expose this
    videoTracks,
    audioTracks,
  }
}

function packetToSample(packet: WebAVPacket, trackId: number, sampleNumber: number): DemuxedSample {
  return {
    number: sampleNumber,
    trackId,
    pts: packet.timestamp / 1_000_000, // Convert from microseconds to seconds
    dts: packet.timestamp / 1_000_000, // DTS same as PTS for most cases
    duration: packet.duration / 1_000_000,
    isKeyframe: packet.keyframe === 1,
    data: packet.data,
    size: packet.size,
  }
}

async function collectStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const items: T[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    items.push(value)
  }

  return items
}

export async function createDemuxer(source: ArrayBuffer | File): Promise<Demuxer> {
  const demuxer = new WebDemuxer({
    // Use CDN for WASM file
    wasmFilePath: 'https://cdn.jsdelivr.net/npm/web-demuxer@latest/dist/wasm-files/web-demuxer.wasm',
  })

  // Convert ArrayBuffer to File if needed (web-demuxer only accepts File or URL)
  let file: File
  if (source instanceof ArrayBuffer) {
    // Detect format from magic bytes
    const view = new Uint8Array(source)
    let mimeType = 'video/mp4' // default

    // WebM/MKV starts with EBML header: 0x1A 0x45 0xDF 0xA3
    if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
      mimeType = 'video/webm'
    }

    file = new File([source], 'video', { type: mimeType })
  } else {
    file = source
  }

  await demuxer.load(file)

  const mediaInfo = await demuxer.getMediaInfo()
  const info = parseInfo(mediaInfo)

  // Build track index mapping (trackId -> stream info)
  const trackMap = new Map<number, { type: 'video' | 'audio', index: number }>()
  for (const track of info.videoTracks) {
    trackMap.set(track.id, { type: 'video', index: track.index })
  }
  for (const track of info.audioTracks) {
    trackMap.set(track.id, { type: 'audio', index: track.index })
  }

  return {
    info,

    async getVideoConfig(): Promise<VideoDecoderConfig> {
      if (info.videoTracks.length === 0) {
        throw new Error('No video track available')
      }
      return demuxer.getDecoderConfig('video')
    },

    async getAudioConfig(): Promise<AudioDecoderConfig> {
      if (info.audioTracks.length === 0) {
        throw new Error('No audio track available')
      }
      return demuxer.getDecoderConfig('audio')
    },

    async getSamples(trackId: number, startTime: number, endTime: number): Promise<DemuxedSample[]> {
      const trackInfo = trackMap.get(trackId)
      if (!trackInfo) {
        throw new Error(`Track ${trackId} not found`)
      }

      try {
        // Use readMediaPacket which handles stream selection by type
        const stream = demuxer.readMediaPacket(trackInfo.type, startTime, endTime)
        const packets = await collectStream(stream)
        return packets.map((packet, i) => packetToSample(packet, trackId, i))
      } catch (err) {
        console.error(`Failed to get samples for track ${trackId}:`, err)
        return []
      }
    },

    async getAllSamples(trackId: number): Promise<DemuxedSample[]> {
      const trackInfo = trackMap.get(trackId)
      if (!trackInfo) {
        throw new Error(`Track ${trackId} not found`)
      }

      try {
        // Use readMediaPacket which handles stream selection by type
        const stream = demuxer.readMediaPacket(trackInfo.type, 0, info.duration)
        const packets = await collectStream(stream)
        return packets.map((packet, i) => packetToSample(packet, trackId, i))
      } catch (err) {
        console.error(`Failed to get all samples for track ${trackId}:`, err)
        return []
      }
    },

    async getKeyframeBefore(trackId: number, time: number): Promise<DemuxedSample | null> {
      const trackInfo = trackMap.get(trackId)
      if (!trackInfo) {
        throw new Error(`Track ${trackId} not found`)
      }

      try {
        // Use seekMediaPacket which handles stream selection by type
        // AVSEEK_FLAG_BACKWARD seeks to keyframe at or before time
        const packet = await demuxer.seekMediaPacket(trackInfo.type, time, AVSeekFlag.AVSEEK_FLAG_BACKWARD)

        if (!packet) return null

        return packetToSample(packet, trackId, 0)
      } catch {
        return null
      }
    },

    destroy() {
      demuxer.destroy()
    },
  }
}
