/**
 * Worker-based compositor that handles WebGL rendering in a Web Worker.
 * Uses OffscreenCanvas for off-main-thread rendering.
 */

import { transfer } from '@bigmistqke/rpc/messenger'
import { debug } from '@eddy/utils'
import { createCompositorWorker, type CompositorWorkerMethods, type WorkerHandle } from './index'

const log = debug('compositor-wrapper', false)

export interface WorkerCompositor {
  /** The canvas element (rendered by worker via OffscreenCanvas) */
  readonly canvas: HTMLCanvasElement

  /** Set a preview stream for a track slot (continuously reads latest frame) */
  setPreviewStream(index: number, stream: MediaStream | null): void

  /** Set a playback frame for a track slot */
  setFrame(index: number, frame: VideoFrame | null): void

  /** Set grid layout (1x1 = full-screen single video, 2x2 = quad view) */
  setGrid(cols: number, rows: number): void

  /** Render current state to visible canvas */
  render(): void

  /** Set a frame on capture canvas (for pre-rendering, doesn't affect visible canvas) */
  setCaptureFrame(index: number, frame: VideoFrame | null): Promise<void>

  /** Render to capture canvas (for pre-rendering, doesn't affect visible canvas) */
  renderCapture(activeSlots: [number, number, number, number]): void

  /** Capture frame from capture canvas as VideoFrame */
  captureFrame(timestamp: number): Promise<VideoFrame | null>

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

    setFrame(index: number, frame: VideoFrame | null): void {
      // Transfer frame to worker (worker closes previous frame)
      if (frame) {
        handle.rpc.setFrame(index, transfer(frame) as unknown as VideoFrame)
      } else {
        handle.rpc.setFrame(index, null)
      }
    },

    setGrid(cols: number, rows: number): void {
      handle.rpc.setGrid(cols, rows)
    },

    render() {
      handle.rpc.render()
    },

    setCaptureFrame(index: number, frame: VideoFrame | null): Promise<void> {
      return handle.rpc.setCaptureFrame(index, frame ? transfer(frame) : null)
    },

    renderCapture(activeSlots: [number, number, number, number]): void {
      handle.rpc.renderCapture(activeSlots)
    },

    async captureFrame(timestamp: number): Promise<VideoFrame | null> {
      return handle.rpc.captureFrame(timestamp)
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
