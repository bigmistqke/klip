/**
 * Pre-renderer hook - Renders composite video to a single file for optimized playback
 *
 * Manages all pre-render state with signals and handles the pre-rendered playback lifecycle.
 */

import type { Demuxer } from '@eddy/codecs'
import type { Playback } from '@eddy/playback'
import { createPlayback } from '@eddy/playback'
import { debug } from '@eddy/utils'
import {
  BufferTarget,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny'
import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { createDemuxerWorker } from '~/workers'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'

const log = debug('pre-renderer', true)

export interface PreRenderOptions {
  /** Target frames per second (default: 30) */
  fps?: number
  /** Video bitrate in bps (default: 4_000_000) */
  bitrate?: number
}

export interface PreRendererState {
  /** Whether currently rendering */
  isRendering: Accessor<boolean>
  /** Render progress (0-1) */
  progress: Accessor<number>
  /** Whether pre-rendered video is ready for playback */
  hasPreRender: Accessor<boolean>
  /** The pre-rendered playback (for video frames) */
  playback: Accessor<Playback | null>
  /** The pre-rendered blob (for download/debug) */
  blob: Accessor<Blob | null>
}

export interface PreRendererActions {
  /** Start pre-rendering from the given playbacks */
  render: (playbacks: (Playback | null)[], compositor: WorkerCompositor) => Promise<void>
  /** Cancel in-progress pre-render */
  cancel: () => void
  /** Invalidate and clear pre-rendered content */
  invalidate: () => void
}

export type PreRenderer = PreRendererState & PreRendererActions

/**
 * Creates a pre-renderer hook with signal-based state
 */
export function createPreRenderer(options: PreRenderOptions = {}): PreRenderer {
  const fps = options.fps ?? 30
  const bitrate = options.bitrate ?? 4_000_000
  const frameDuration = 1 / fps

  // Signals for reactive state
  const [isRendering, setIsRendering] = createSignal(false)
  const [progress, setProgress] = createSignal(0)
  const [blob, setBlob] = createSignal<Blob | null>(null)
  const [playback, setPlayback] = createSignal<Playback | null>(null)

  // Internal state (not reactive)
  let isCancelled = false
  let demuxer: Demuxer | null = null

  // Derived state
  const hasPreRender = () => playback() !== null

  // Cleanup on disposal
  onCleanup(() => {
    invalidate()
  })

  function invalidate() {
    const currentPlayback = playback()
    if (currentPlayback) {
      currentPlayback.destroy()
      setPlayback(null)
    }
    if (demuxer) {
      demuxer.destroy()
      demuxer = null
    }
    setBlob(null)
    setProgress(0)
    log('invalidated')
  }

  function cancel() {
    if (isRendering()) {
      isCancelled = true
      log('cancel requested')
    }
  }

  async function render(
    playbacks: (Playback | null)[],
    compositor: WorkerCompositor,
  ): Promise<void> {
    if (isRendering()) {
      log('render: already in progress')
      return
    }

    // Check if there's content to render
    const hasContent = playbacks.some(p => p !== null)
    if (!hasContent) {
      log('render: no content')
      return
    }

    // Find max duration
    let duration = 0
    for (const playback of playbacks) {
      if (playback) {
        duration = Math.max(duration, playback.duration)
      }
    }

    if (duration <= 0) {
      log('render: no duration')
      return
    }

    // Clear any existing pre-render
    invalidate()

    setIsRendering(true)
    isCancelled = false
    setProgress(0)

    const totalFrames = Math.ceil(duration * fps)
    log('starting', { duration, fps, totalFrames, bitrate })

    // Setup encoder
    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new WebMOutputFormat(),
      target: bufferTarget,
    })

    const videoSource = new VideoSampleSource({
      codec: 'vp8',
      bitrate,
      keyFrameInterval: 30,
    })
    output.addVideoTrack(videoSource)

    try {
      await output.start()
      log('encoder started')

      // Seek all playbacks to start
      const seekPromises = playbacks
        .filter((p): p is Playback => p !== null)
        .map(p => p.seek(0))
      await Promise.all(seekPromises)

      let frameCount = 0

      // Render each frame
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        if (isCancelled) {
          log('cancelled at frame', frameIndex)
          break
        }

        const time = frameIndex * frameDuration
        const timestampMicros = Math.round(time * 1_000_000)

        // Track which slots are active
        const activeSlots: [number, number, number, number] = [0, 0, 0, 0]

        // Get frames from all playbacks
        for (let i = 0; i < playbacks.length; i++) {
          const playback = playbacks[i]
          if (playback) {
            // Ensure frames are buffered
            const frameTimestamp = playback.getFrameTimestamp(time)
            if (frameTimestamp === null) {
              await playback.seek(time)
            }

            const frame = playback.getFrameAt(time)
            if (frame) {
              await compositor.setCaptureFrame(i, frame)
              activeSlots[i] = 1
            }
          }
        }

        // Render to capture canvas
        await compositor.renderCapture(activeSlots)

        // Capture the rendered frame
        const capturedFrame = await compositor.captureFrame(timestampMicros)
        if (capturedFrame) {
          const sample = new VideoSample(capturedFrame)
          sample.setTimestamp(time)
          await videoSource.add(sample)
          sample[Symbol.dispose]?.()
          capturedFrame.close()
          frameCount++
        }

        setProgress((frameIndex + 1) / totalFrames)

        // Log progress periodically
        if (frameCount % 30 === 0) {
          log('progress', { frame: frameIndex + 1, totalFrames })
        }
      }

      if (!isCancelled) {
        // Close and finalize
        await videoSource.close()
        await output.finalize()

        const buffer = bufferTarget.buffer
        const renderedBlob = buffer ? new Blob([buffer], { type: 'video/webm' }) : new Blob()

        log('complete', { frameCount, blobSize: renderedBlob.size })

        // Create playback for the pre-rendered video
        setBlob(renderedBlob)
        demuxer = await createDemuxerWorker(renderedBlob)
        const renderedPlayback = await createPlayback(demuxer)
        await renderedPlayback.seek(0)
        setPlayback(renderedPlayback)

        log('playback ready')
      }
    } catch (err) {
      log('error', { error: err })
      throw err
    } finally {
      setIsRendering(false)
      if (!isCancelled) {
        setProgress(1)
      }
    }
  }

  return {
    // State
    isRendering,
    progress,
    hasPreRender,
    playback,
    blob,
    // Actions
    render,
    cancel,
    invalidate,
  }
}
