/**
 * Worker-based compositor that handles WebGL rendering in a Web Worker.
 * Uses OffscreenCanvas for off-main-thread rendering.
 */

import { transfer } from '@bigmistqke/rpc/messenger'
import { debug } from '@eddy/utils'
import { createCompositorWorker, type CompositorWorkerMethods, type WorkerHandle } from './index'

const log = debug('compositor-wrapper', true)

export interface WorkerCompositor {
  /** The canvas element (rendered by worker via OffscreenCanvas) */
  readonly canvas: HTMLCanvasElement

  /** Set a preview stream for a track slot (continuously reads latest frame) */
  setPreviewStream(index: number, stream: MediaStream | null): void

  /** Set a playback frame for a track slot */
  setFrame(index: number, frame: VideoFrame | null): void

  /** Render current state */
  render(): void

  /** Clean up resources */
  destroy(): void
}

/**
 * Create a compositor that runs WebGL rendering in a Web Worker.
 *
 * @param width - Canvas width
 * @param height - Canvas height
 * @returns WorkerCompositor interface
 */
export async function createCompositorWorkerWrapper(
  width: number,
  height: number
): Promise<WorkerCompositor> {
  log('createCompositorWorkerWrapper', { width, height })

  // Create canvas and transfer to worker
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const offscreen = canvas.transferControlToOffscreen()

  // Create worker and initialize with OffscreenCanvas
  const handle: WorkerHandle<CompositorWorkerMethods> = createCompositorWorker()

  log('initializing worker with OffscreenCanvas')
  await handle.rpc.init(
    transfer(offscreen) as unknown as OffscreenCanvas,
    width,
    height
  )
  log('worker initialized')

  // Track active preview processors so we can clean them up
  const previewProcessors: (MediaStreamTrackProcessor<VideoFrame> | null)[] = [null, null, null, null]

  return {
    get canvas() {
      return canvas
    },

    setPreviewStream(index: number, stream: MediaStream | null) {
      log('setPreviewStream', { index, hasStream: !!stream })

      // Clean up existing processor
      if (previewProcessors[index]) {
        previewProcessors[index] = null
      }

      if (stream) {
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) {
          // Create processor and transfer stream to worker
          const processor = new MediaStreamTrackProcessor({ track: videoTrack })
          previewProcessors[index] = processor

          handle.rpc.setPreviewStream(
            index,
            transfer(processor.readable) as unknown as ReadableStream<VideoFrame>
          )
        }
      } else {
        handle.rpc.setPreviewStream(index, null)
      }
    },

    setFrame(index: number, frame: VideoFrame | null) {
      // Transfer frame to worker (frame ownership moves to worker)
      if (frame) {
        handle.rpc.setFrame(index, transfer(frame) as unknown as VideoFrame)
      } else {
        handle.rpc.setFrame(index, null)
      }
    },

    render() {
      handle.rpc.render()
    },

    destroy() {
      log('destroy')

      // Clean up processors
      for (let i = 0; i < 4; i++) {
        previewProcessors[i] = null
      }

      handle.rpc.destroy()
      handle.terminate()
    },
  }
}
