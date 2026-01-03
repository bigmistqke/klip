/**
 * Worker-based recorder that handles encoding/muxing in a Web Worker.
 * Uses MediaStreamTrackProcessor to capture frames and transfers them to the worker.
 */

import { transfer } from '@bigmistqke/rpc/messenger'
import { debug } from '@eddy/utils'
import { createRecordingWorker, type RecordingWorkerMethods, type WorkerHandle } from './index'
import type { RecordingResult } from './types'

const log = debug('recorder-worker', true)

export interface WorkerRecorder {
  /** Start recording from the media stream */
  start(): void
  /** Stop recording and get the result */
  stop(): Promise<RecordingResult & { firstFrame: VideoFrame | null }>
  /** Get first frame for preview (available during recording) */
  getFirstFrame(): VideoFrame | null
  /** Clean up resources */
  destroy(): void
}

/**
 * Create a recorder that runs encoding/muxing in a Web Worker.
 *
 * @param stream - MediaStream from getUserMedia
 * @returns WorkerRecorder interface
 */
export function createRecorderWorker(stream: MediaStream): WorkerRecorder {
  const hasVideo = stream.getVideoTracks().length > 0
  const hasAudio = stream.getAudioTracks().length > 0

  log('createRecorderWorker', { hasVideo, hasAudio })

  let handle: WorkerHandle<RecordingWorkerMethods> | null = null
  let videoProcessor: MediaStreamTrackProcessor<VideoFrame> | null = null
  let audioProcessor: MediaStreamTrackProcessor<AudioData> | null = null
  let firstFrame: VideoFrame | null = null
  let isRecording = false

  return {
    start() {
      log('start called', { isRecording })
      if (isRecording) return
      isRecording = true

      // Create worker
      handle = createRecordingWorker()
      log('worker created')

      // Get video dimensions
      const videoTrack = stream.getVideoTracks()[0]
      const settings = videoTrack?.getSettings() ?? {}
      const width = settings.width ?? 640
      const height = settings.height ?? 480
      log('video settings', { width, height, frameRate: settings.frameRate })

      // Create track processors
      let videoStream: ReadableStream<VideoFrame> | undefined
      let audioStream: ReadableStream<AudioData> | undefined

      if (hasVideo && videoTrack) {
        log('creating video processor')
        videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack })
        videoStream = videoProcessor.readable
        log('video processor created', { hasReadable: !!videoStream })
      }

      if (hasAudio) {
        const audioTrack = stream.getAudioTracks()[0]
        if (audioTrack) {
          log('creating audio processor')
          audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack })
          audioStream = audioProcessor.readable
          log('audio processor created', { hasReadable: !!audioStream })
        }
      }

      // Start recording in worker with transferred streams
      log('calling worker start', { hasVideoStream: !!videoStream, hasAudioStream: !!audioStream, width, height })
      handle.rpc.start({
        videoStream: videoStream ? transfer(videoStream) as unknown as ReadableStream<VideoFrame> : undefined,
        audioStream: audioStream ? transfer(audioStream) as unknown as ReadableStream<AudioData> : undefined,
        width,
        height,
      })

      // Poll for first frame
      if (hasVideo) {
        const pollFirstFrame = async () => {
          if (!handle || !isRecording) return
          const frame = await handle.rpc.getFirstFrame()
          if (frame) {
            firstFrame = frame
          } else {
            // Keep polling until we get a frame
            setTimeout(pollFirstFrame, 50)
          }
        }
        pollFirstFrame()
      }
    },

    async stop() {
      log('stop called', { hasHandle: !!handle })
      if (!handle) {
        log('stop: no handle, returning empty result')
        return { blob: new Blob(), duration: 0, firstFrame: null }
      }

      isRecording = false

      log('stop: calling worker stop')
      const result = await handle.rpc.stop()
      log('stop: worker returned', { blobSize: result.blob.size, duration: result.duration, blobType: result.blob.type })

      // Clean up
      handle.terminate()
      handle = null
      videoProcessor = null
      audioProcessor = null
      log('stop: cleanup complete')

      return {
        ...result,
        firstFrame,
      }
    },

    getFirstFrame() {
      return firstFrame
    },

    destroy() {
      isRecording = false
      if (handle) {
        handle.terminate()
        handle = null
      }
      if (firstFrame) {
        firstFrame.close()
        firstFrame = null
      }
      videoProcessor = null
      audioProcessor = null
    },
  }
}
