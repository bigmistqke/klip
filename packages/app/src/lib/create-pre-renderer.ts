/**
 * Pre-renderer - Renders composite video to a single file for optimized playback
 *
 * Instead of dynamically compositing 4 tracks during playback, pre-render
 * composites everything into a single video file that can be decoded more efficiently.
 */

import {
  BufferTarget,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny'
import { debug } from '@eddy/utils'
import type { Playback } from '@eddy/playback'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'

const log = debug('pre-renderer', true)

export interface PreRenderOptions {
  /** Target frames per second (default: 30) */
  fps?: number
  /** Video bitrate in bps (default: 4_000_000) */
  bitrate?: number
}

export interface PreRenderResult {
  /** The pre-rendered video as a Blob */
  blob: Blob
  /** Duration in seconds */
  duration: number
  /** Number of frames rendered */
  frameCount: number
}

export interface PreRenderer {
  /** Start pre-rendering. Returns when complete. */
  render(): Promise<PreRenderResult>
  /** Cancel in-progress pre-render */
  cancel(): void
  /** Whether currently rendering */
  readonly isRendering: boolean
  /** Progress (0-1) */
  readonly progress: number
}

/**
 * Create a pre-renderer for the given playbacks and compositor
 */
export function createPreRenderer(
  playbacks: (Playback | null)[],
  compositor: WorkerCompositor,
  options: PreRenderOptions = {},
): PreRenderer {
  const fps = options.fps ?? 30
  const bitrate = options.bitrate ?? 4_000_000
  const frameDuration = 1 / fps // seconds per frame

  let isRendering = false
  let isCancelled = false
  let progress = 0

  // Find the max duration across all playbacks
  function getMaxDuration(): number {
    let max = 0
    for (const playback of playbacks) {
      if (playback) {
        max = Math.max(max, playback.duration)
      }
    }
    return max
  }

  async function render(): Promise<PreRenderResult> {
    if (isRendering) {
      throw new Error('Pre-render already in progress')
    }

    isRendering = true
    isCancelled = false
    progress = 0

    const duration = getMaxDuration()
    if (duration <= 0) {
      throw new Error('No content to pre-render')
    }

    const totalFrames = Math.ceil(duration * fps)
    log('starting pre-render', { duration, fps, totalFrames, bitrate })

    // Setup encoder
    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new WebMOutputFormat(),
      target: bufferTarget,
    })

    const videoSource = new VideoSampleSource({
      codec: 'vp9',
      bitrate,
    })
    output.addVideoTrack(videoSource)

    await output.start()
    log('encoder started')

    let frameCount = 0

    try {
      // Seek all playbacks to start
      const seekPromises = playbacks
        .filter((p): p is Playback => p !== null)
        .map(p => p.seek(0))
      await Promise.all(seekPromises)
      log('all playbacks seeked to 0')

      // Render each frame
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        if (isCancelled) {
          log('pre-render cancelled')
          break
        }

        const time = frameIndex * frameDuration
        const timestampMicros = Math.round(time * 1_000_000)

        // Track which slots are active
        const activeSlots: [number, number, number, number] = [0, 0, 0, 0]

        // Get frames from all playbacks and send to capture canvas (not visible)
        for (let i = 0; i < playbacks.length; i++) {
          const playback = playbacks[i]
          if (playback) {
            const frame = playback.getFrameAt(time)
            if (frame) {
              compositor.setCaptureFrame(i, frame)
              activeSlots[i] = 1
            }
          }
        }

        // Render to capture canvas (doesn't affect visible canvas)
        compositor.renderCapture(activeSlots)

        // Capture the rendered frame
        const capturedFrame = await compositor.captureFrame(timestampMicros)
        if (capturedFrame) {
          // Encode frame
          const sample = new VideoSample(capturedFrame)
          sample.setTimestamp(time) // seconds
          await videoSource.add(sample)
          sample[Symbol.dispose]?.()
          capturedFrame.close()
          frameCount++
        }

        progress = (frameIndex + 1) / totalFrames

        // Log progress periodically
        if (frameCount % 30 === 0 || frameIndex === totalFrames - 1) {
          log('progress', {
            frame: frameIndex + 1,
            totalFrames,
            progress: `${(progress * 100).toFixed(1)}%`,
          })
        }
      }

      // Finalize
      await output.finalize()
      const buffer = bufferTarget.buffer
      const blob = buffer ? new Blob([buffer], { type: 'video/webm' }) : new Blob()

      log('pre-render complete', { frameCount, blobSize: blob.size, duration })

      return { blob, duration, frameCount }
    } finally {
      isRendering = false
      progress = isCancelled ? progress : 1
    }
  }

  function cancel() {
    if (isRendering) {
      isCancelled = true
    }
  }

  return {
    render,
    cancel,
    get isRendering() {
      return isRendering
    },
    get progress() {
      return progress
    },
  }
}
