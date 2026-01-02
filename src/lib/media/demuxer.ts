import { createFile, type ISOFile, type Movie, type Track, type Sample, MP4BoxBuffer } from 'mp4box'

export interface VideoTrackInfo {
  id: number
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

export { type Sample }

export interface Demuxer {
  readonly info: DemuxerInfo
  readonly file: ISOFile

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

type VideoTrack = Track & { video: NonNullable<Track['video']> }
type AudioTrack = Track & { audio: NonNullable<Track['audio']> }

function isVideoTrack(track: Track): track is VideoTrack {
  return track.video !== undefined
}

function isAudioTrack(track: Track): track is AudioTrack {
  return track.audio !== undefined
}

function parseVideoTrack(track: VideoTrack): VideoTrackInfo {
  return {
    id: track.id,
    codec: track.codec,
    width: track.video.width,
    height: track.video.height,
    duration: track.duration / track.timescale,
    timescale: track.timescale,
    sampleCount: track.nb_samples,
    bitrate: track.bitrate,
  }
}

function parseAudioTrack(track: AudioTrack): AudioTrackInfo {
  return {
    id: track.id,
    codec: track.codec,
    sampleRate: track.audio.sample_rate,
    channelCount: track.audio.channel_count,
    sampleSize: track.audio.sample_size,
    duration: track.duration / track.timescale,
    timescale: track.timescale,
    sampleCount: track.nb_samples,
    bitrate: track.bitrate,
  }
}

function parseInfo(info: Movie): DemuxerInfo {
  const videoTracks: VideoTrackInfo[] = []
  const audioTracks: AudioTrackInfo[] = []

  for (const track of info.tracks) {
    if (isVideoTrack(track)) {
      videoTracks.push(parseVideoTrack(track))
    } else if (isAudioTrack(track)) {
      audioTracks.push(parseAudioTrack(track))
    }
  }

  return {
    duration: info.duration / info.timescale,
    timescale: info.timescale,
    isFragmented: info.isFragmented,
    videoTracks,
    audioTracks,
  }
}

export async function createDemuxer(source: ArrayBuffer | File): Promise<Demuxer> {
  const file = createFile()

  const buffer = source instanceof File ? await source.arrayBuffer() : source

  return new Promise((resolve, reject) => {
    file.onError = (module: string, message: string) => {
      reject(new Error(`MP4Box error in ${module}: ${message}`))
    }

    file.onReady = (mp4Info: Movie) => {
      const info = parseInfo(mp4Info)

      // Build sample lists so we can access individual samples
      file.buildSampleLists()

      // Helper to get track info by ID
      const getTrackInfo = (trackId: number) => {
        return [...info.videoTracks, ...info.audioTracks].find(t => t.id === trackId)
      }

      // Cache for extracted samples per track
      const samplesCache = new Map<number, Sample[]>()

      // Get all samples for a track using getTrackSamplesInfo
      const getSamplesForTrack = (trackId: number): Sample[] => {
        // Return cached samples if available
        const cached = samplesCache.get(trackId)
        if (cached) {
          return cached
        }

        const samples = file.getTrackSamplesInfo(trackId)
        samplesCache.set(trackId, samples)
        return samples
      }

      // Extract sample data from the buffer using offset and size
      const extractSampleData = (sample: Sample): Uint8Array => {
        // If sample already has data, return it
        if (sample.data && sample.data.byteLength > 0) {
          return sample.data
        }
        // Extract from buffer using offset and size
        return new Uint8Array(buffer, sample.offset, sample.size)
      }

      // Normalize sample with extracted data
      const normalizeSampleWithData = (sample: Sample): DemuxedSample => {
        const timescale = sample.timescale
        return {
          number: sample.number,
          trackId: sample.track_id,
          pts: sample.cts / timescale,
          dts: sample.dts / timescale,
          duration: sample.duration / timescale,
          isKeyframe: sample.is_sync,
          data: extractSampleData(sample),
          size: sample.size,
        }
      }

      resolve({
        info,
        file,

        async getSamples(trackId: number, startTime: number, endTime: number): Promise<DemuxedSample[]> {
          const trackInfo = getTrackInfo(trackId)
          if (!trackInfo) {
            throw new Error(`Track ${trackId} not found`)
          }

          const allSamples = getSamplesForTrack(trackId)

          return allSamples
            .filter(sample => {
              const pts = sample.cts / sample.timescale
              return pts >= startTime && pts < endTime
            })
            .map(normalizeSampleWithData)
        },

        async getAllSamples(trackId: number): Promise<DemuxedSample[]> {
          const trackInfo = getTrackInfo(trackId)
          if (!trackInfo) {
            throw new Error(`Track ${trackId} not found`)
          }

          const allSamples = getSamplesForTrack(trackId)
          return allSamples.map(normalizeSampleWithData)
        },

        async getKeyframeBefore(trackId: number, time: number): Promise<DemuxedSample | null> {
          const trackInfo = getTrackInfo(trackId)
          if (!trackInfo) {
            throw new Error(`Track ${trackId} not found`)
          }

          const allSamples = getSamplesForTrack(trackId)

          // Find the last keyframe at or before the given time
          let lastKeyframe: Sample | null = null
          for (const sample of allSamples) {
            const pts = sample.cts / sample.timescale
            if (sample.is_sync && pts <= time) {
              lastKeyframe = sample
            }
            if (pts > time) break
          }

          return lastKeyframe ? normalizeSampleWithData(lastKeyframe) : null
        },

        destroy() {
          file.flush()
          samplesCache.clear()
        },
      })
    }

    const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(buffer, 0)
    file.appendBuffer(mp4Buffer)
    file.flush()
  })
}
