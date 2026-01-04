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
import { createResource, createSignal, onCleanup, type Accessor } from 'solid-js'
import { createDemuxerWorker } from '~/workers'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'

const log = debug('pre-renderer', true)

export interface PreRenderOptions {
  /** Target frames per second (default: 30) */
  fps?: number
  /** Video bitrate in bps (default: 4_000_000) */
  bitrate?: number
}

interface RenderParams {
  playbacks: (Playback | null)[]
  compositor: WorkerCompositor
}

interface RenderResult {
  blob: Blob
  playback: Playback
  demuxer: Demuxer
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
  render: (playbacks: (Playback | null)[], compositor: WorkerCompositor) => void
  /** Cancel in-progress pre-render */
  cancel: () => void
  /** Invalidate and clear pre-rendered content */
  invalidate: () => void
  /** Tick the pre-rendered playback and return frame if new */
  tick: (time: number, playing: boolean) => VideoFrame | null
  /** Reset playback for loop */
  resetForLoop: (time: number) => void
}

export type PreRenderer = PreRendererState & PreRendererActions

/**
 * Creates a pre-renderer hook with signal-based state
 */
export function createPreRenderer(options: PreRenderOptions = {}): PreRenderer {
  const fps = options.fps ?? 30
  const bitrate = options.bitrate ?? 4_000_000
  const frameDuration = 1 / fps

  // Render params signal - setting this triggers the resource
  const [renderParams, setRenderParams] = createSignal<RenderParams | null>(null)

  // Progress needs separate tracking (createResource doesn't support progress)
  const [progress, setProgress] = createSignal(0)

  // Frame tracking for tick()
  let lastSentTimestamp: number | null = null

  // AbortController - stored outside so cancel() can access it
  let abortController: AbortController | null = null

  // The render resource
  const [result, { mutate }] = createResource(renderParams, async (params, { refetching }): Promise<RenderResult | null> => {
    // Abort previous render if refetching
    if (refetching && abortController) {
      abortController.abort()
      log('aborted previous render')
    }

    const { playbacks, compositor } = params

    // Check if there's content to render
    const hasContent = playbacks.some(playback => playback !== null)
    if (!hasContent) {
      log('render: no content')
      return null
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
      return null
    }

    abortController = new AbortController()
    const { signal } = abortController
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
        .filter((playback): playback is Playback => playback !== null)
        .map(playback => playback.seek(0))
      await Promise.all(seekPromises)

      let frameCount = 0

      // Render each frame
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        if (signal.aborted) {
          log('cancelled at frame', frameIndex)
          return null
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

      // Close and finalize
      await videoSource.close()
      await output.finalize()

      const buffer = bufferTarget.buffer
      const renderedBlob = buffer ? new Blob([buffer], { type: 'video/webm' }) : new Blob()

      log('complete', { frameCount, blobSize: renderedBlob.size })

      // Create playback for the pre-rendered video
      const demuxer = await createDemuxerWorker(renderedBlob)
      const renderedPlayback = await createPlayback(demuxer)
      await renderedPlayback.seek(0)

      setProgress(1)
      log('playback ready')

      return { blob: renderedBlob, playback: renderedPlayback, demuxer }
    } catch (err) {
      log('error', { error: err })
      throw err
    } finally {
      abortController = null
    }
  })

  // Derived state from resource
  const isRendering = () => result.loading
  const hasPreRender = () => result() !== null && result() !== undefined
  const playback = () => result()?.playback ?? null
  const blob = () => result()?.blob ?? null

  function invalidate() {
    const _result = result()
    if (_result) {
      _result.playback.destroy()
      _result.demuxer.destroy()
    }
    mutate(null)
    setProgress(0)
    lastSentTimestamp = null
    log('invalidated')
  }

  function cancel() {
    if (abortController) {
      abortController.abort()
      log('cancel requested')
    }
  }

  function render(playbacks: (Playback | null)[], compositor: WorkerCompositor) {
    // Clear any existing pre-render first
    invalidate()
    // Trigger the resource by setting new params
    setRenderParams({ playbacks, compositor })
  }

  function tick(time: number, playing: boolean): VideoFrame | null {
    const _playback = playback()
    if (!_playback) return null

    if (playing) {
      _playback.tick(time)
    }

    const frameTimestamp = _playback.getFrameTimestamp(time)

    if (frameTimestamp === null || frameTimestamp === lastSentTimestamp) {
      return null
    }

    const frame = _playback.getFrameAt(time)
    if (frame) {
      lastSentTimestamp = frameTimestamp
      return frame
    }

    return null
  }

  function resetForLoop(time: number) {
    const _playback = playback()
    if (_playback) {
      _playback.resetForLoop(time)
    }
    lastSentTimestamp = null
  }

  // Cleanup on disposal
  onCleanup(() => {
    cancel()
    invalidate()
  })

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
    tick,
    resetForLoop,
  }
}
