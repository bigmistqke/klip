import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  ReadableStreamSource
} from 'mediabunny'

export interface RecordingResult {
  blob: Blob
  duration: number
  type: 'audio' | 'video'
  /** First decoded frame, ready for immediate display */
  firstFrame: VideoFrame | null
}

export async function requestMediaAccess(video: boolean = false): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: video ? { facingMode: 'user' } : false,
  })
}

export function createRecorder(stream: MediaStream): {
  start: () => void
  stop: () => Promise<RecordingResult>
  /** Get the first decoded frame (available during recording) */
  getFirstFrame: () => VideoFrame | null
} {
  const hasVideo = stream.getVideoTracks().length > 0
  const mimeType = hasVideo ? 'video/webm;codecs=vp9,opus' : 'audio/webm;codecs=opus'

  const mediaRecorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  let startTime = 0

  // Streaming demux infrastructure
  let streamController: { readable: ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array> } | null = null
  let input: Input | null = null
  let decoder: VideoDecoder | null = null
  let firstFrame: VideoFrame | null = null
  let hasInitialized = false

  // Initialize streaming demuxer
  const initStreaming = () => {
    if (!hasVideo) return

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    streamController = { readable, writer }
  }

  // Initialize demuxer when we have enough data
  const initDemuxer = async () => {
    if (hasInitialized || !streamController || !hasVideo) return
    hasInitialized = true

    try {
      const source = new ReadableStreamSource(streamController.readable, {
        maxCacheSize: 32 * 1024 * 1024,
      })

      input = new Input({
        source,
        formats: ALL_FORMATS,
      })

      // Wait for video track
      const videoTracks = await input.getVideoTracks()
      if (videoTracks.length === 0) return

      const videoTrack = videoTracks[0]
      const config = await videoTrack.getDecoderConfig()
      if (!config) return

      // Initialize decoder to capture first frame
      decoder = new VideoDecoder({
        output: (frame) => {
          if (!firstFrame) {
            firstFrame = frame
          } else {
            frame.close() // Only keep first frame
          }
        },
        error: () => {
          // Ignore decoder errors during streaming
        },
      })

      decoder.configure(config)

      // Decode the first keyframe
      const packetSink = new EncodedPacketSink(videoTrack)
      const firstPacket = await packetSink.getFirstPacket()
      if (firstPacket && decoder.state === 'configured') {
        const chunk = new EncodedVideoChunk({
          type: 'key',
          timestamp: firstPacket.timestamp * 1_000_000,
          duration: firstPacket.duration * 1_000_000,
          data: firstPacket.data,
        })
        decoder.decode(chunk)
        await decoder.flush()
      }
    } catch {
      // Ignore initialization errors - fall back to normal loading
    }
  }

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data)

      // Feed to streaming demuxer
      if (streamController && hasVideo) {
        try {
          const arrayBuffer = await e.data.arrayBuffer()
          await streamController.writer.write(new Uint8Array(arrayBuffer))

          // Initialize demuxer after first chunk
          if (!hasInitialized) {
            initDemuxer()
          }
        } catch {
          // Writer may be closed
        }
      }
    }
  }

  return {
    start() {
      chunks.length = 0
      firstFrame = null
      hasInitialized = false
      startTime = performance.now()

      // Set up streaming before starting
      initStreaming()

      // Start with 100ms timeslice for streaming
      mediaRecorder.start(100)
    },

    async stop(): Promise<RecordingResult> {
      return new Promise((resolve) => {
        mediaRecorder.onstop = async () => {
          // Abort stream immediately (don't wait for pending operations)
          if (streamController) {
            try {
              streamController.writer.abort()
            } catch {
              // May already be closed
            }
          }

          // Cleanup decoder (but keep firstFrame)
          if (decoder && decoder.state !== 'closed') {
            try {
              decoder.close()
            } catch {
              // May already be closed
            }
          }

          const duration = performance.now() - startTime
          const blob = new Blob(chunks, { type: mimeType })

          resolve({
            blob,
            duration,
            type: hasVideo ? 'video' : 'audio',
            firstFrame,
          })
        }
        mediaRecorder.stop()
      })
    },

    getFirstFrame(): VideoFrame | null {
      return firstFrame
    },
  }
}
