import { expose, rpc } from '@bigmistqke/rpc/messenger'
import type { AudioFrameData, VideoFrameData } from '@eddy/codecs'
import { debug } from '@eddy/utils'

const log = debug('capture-worker', false)

export interface CaptureWorkerMethods {
  /** Set the muxer port for forwarding frames (called before start) */
  setMuxerPort(port: MessagePort): void

  /**
   * Start capturing frames from video and audio streams.
   * Frames are forwarded to the muxer via MessagePort.
   */
  start(
    videoStream: ReadableStream<VideoFrame>,
    audioStream?: ReadableStream<AudioData>,
  ): Promise<void>

  /** Stop capturing */
  stop(): void
}

/** Methods exposed by muxer on the capture port */
interface MuxerPortMethods {
  addVideoFrame(data: VideoFrameData): void
  addAudioFrame(data: AudioFrameData): void
  captureEnded(frameCount: number): void
}

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

async function copyVideoFrameToBuffer(frame: VideoFrame): Promise<{
  buffer: ArrayBuffer
  format: VideoPixelFormat
  codedWidth: number
  codedHeight: number
}> {
  const format = frame.format!
  const codedWidth = frame.codedWidth
  const codedHeight = frame.codedHeight
  const buffer = new ArrayBuffer(frame.allocationSize())
  await frame.copyTo(buffer)
  frame.close()
  return { buffer, format, codedWidth, codedHeight }
}

/** Convert AudioData to AudioFrameData format expected by muxer */
function audioDataToFrameData(audioData: AudioData, firstTimestamp: number): AudioFrameData {
  const numberOfChannels = audioData.numberOfChannels
  const numberOfFrames = audioData.numberOfFrames
  const sampleRate = audioData.sampleRate
  const format = audioData.format

  const data: Float32Array[] = []

  if (format?.endsWith('-planar')) {
    // Planar format: each channel is a separate plane
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames)
      audioData.copyTo(channelData, { planeIndex: channel })
      data.push(channelData)
    }
  } else {
    // Interleaved format: all channels in plane 0
    const byteSize = audioData.allocationSize({ planeIndex: 0 })
    const tempBuffer = new ArrayBuffer(byteSize)
    audioData.copyTo(tempBuffer, { planeIndex: 0 })

    if (format === 'f32') {
      const interleaved = new Float32Array(tempBuffer)
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames)
        for (let i = 0; i < numberOfFrames; i++) {
          channelData[i] = interleaved[i * numberOfChannels + channel]
        }
        data.push(channelData)
      }
    } else if (format === 's16') {
      const interleaved = new Int16Array(tempBuffer)
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames)
        for (let i = 0; i < numberOfFrames; i++) {
          channelData[i] = interleaved[i * numberOfChannels + channel] / 32768
        }
        data.push(channelData)
      }
    } else {
      // Fallback: try to copy as planar (might fail for some formats)
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames)
        try {
          audioData.copyTo(channelData, { planeIndex: channel })
        } catch {
          channelData.fill(0)
        }
        data.push(channelData)
      }
    }
  }

  const timestamp = (audioData.timestamp - firstTimestamp) / 1_000_000
  audioData.close()

  return { data, sampleRate, timestamp }
}

/**********************************************************************************/
/*                                                                                */
/*                                     Methods                                    */
/*                                                                                */
/**********************************************************************************/

let currentSessionId = 0
let videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null
let audioReader: ReadableStreamDefaultReader<AudioData> | null = null
let muxer: ReturnType<typeof rpc<MuxerPortMethods>> | null = null

expose<CaptureWorkerMethods>({
  setMuxerPort(port: MessagePort) {
    port.start()
    muxer = rpc<MuxerPortMethods>(port)
    log('received muxer port')
  },

  async start(videoStream: ReadableStream<VideoFrame>, audioStream?: ReadableStream<AudioData>) {
    if (!muxer) {
      throw new Error('No muxer - call setMuxerPort first')
    }

    // Increment session ID to invalidate any previous capture loops
    const sessionId = ++currentSessionId
    const isCurrentSession = () => sessionId === currentSessionId

    log('starting', { sessionId, hasAudio: !!audioStream })

    let firstVideoTimestamp: number | null = null
    let firstAudioTimestamp: number | null = null
    let videoFrameCount = 0

    // Start audio capture in parallel (fire and forget)
    let audioFrameCount = 0
    if (audioStream) {
      audioReader = audioStream.getReader()
      // Capture the reader reference for this session
      const myAudioReader = audioReader
      ;(async () => {
        try {
          while (isCurrentSession()) {
            const { done, value: audioData } = await myAudioReader.read()
            if (done || !audioData || !isCurrentSession()) break

            // Log first frame's audio format for debugging
            if (firstAudioTimestamp === null) {
              firstAudioTimestamp = audioData.timestamp
              log('first audio frame', {
                sessionId,
                format: audioData.format,
                sampleRate: audioData.sampleRate,
                numberOfChannels: audioData.numberOfChannels,
                numberOfFrames: audioData.numberOfFrames,
                timestamp: audioData.timestamp,
              })
            }

            const frameData = audioDataToFrameData(audioData, firstAudioTimestamp)
            muxer!.addAudioFrame(frameData)
            audioFrameCount++
          }
        } catch (err) {
          if (isCurrentSession()) {
            log('audio error', err)
          }
        }
        log('audio capture done', { sessionId, audioFrameCount })
      })()
    }

    // Video capture
    videoReader = videoStream.getReader()

    try {
      while (isCurrentSession()) {
        const { done, value: frame } = await videoReader.read()
        if (done || !frame || !isCurrentSession()) break

        // Use first frame's timestamp as reference
        if (firstVideoTimestamp === null) {
          firstVideoTimestamp = frame.timestamp
        }

        const timestamp = (frame.timestamp - firstVideoTimestamp) / 1_000_000
        const data = await copyVideoFrameToBuffer(frame)
        muxer.addVideoFrame({ ...data, timestamp })
        videoFrameCount++
      }
    } catch (err) {
      if (isCurrentSession()) {
        log('video error', err)
        throw err
      }
    }

    // Only signal end if this session is still current
    if (isCurrentSession()) {
      muxer.captureEnded(videoFrameCount)
      log('done', { sessionId, videoFrameCount })
    }
  },

  stop() {
    // Increment session ID to invalidate current capture loops
    currentSessionId++
    videoReader?.cancel().catch(() => {})
    audioReader?.cancel().catch(() => {})
    log('stop', { newSessionId: currentSessionId })
  },
})
