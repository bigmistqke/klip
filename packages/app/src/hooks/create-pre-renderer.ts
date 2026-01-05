/**
 * Pre-renderer hook - Renders composite video to a single file for optimized playback
 *
 * Manages all pre-render state with signals and handles the pre-rendered playback lifecycle.
 */

import type { Demuxer } from '@eddy/codecs'
import type { Playback } from '@eddy/playback'
import { createPlayback } from '@eddy/playback'
import { debug } from '@eddy/utils'
import { BufferTarget, Output, VideoSample, VideoSampleSource, WebMOutputFormat } from 'mediabunny'
import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { createAction } from '~/lib/create-action'
import { createDemuxerWorker } from '~/workers'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'

const log = debug('pre-renderer', true)

export interface PreRenderOptions {
  /** Target frames per second (default: 30) */
  fps?: number
  /** Video bitrate in bps (default: 4_000_000) */
  bitrate?: number
  /** External duration accessor (reactive) */
  duration?: Accessor<number>
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
  const duration = options.duration ?? (() => 0)

  // Progress tracking
  const [progress, setProgress] = createSignal(0)

  // Frame tracking for tick()
  let lastSentTimestamp: number | null = null

  // The render action
  const renderAction = createAction<RenderParams, RenderResult | null>(
    async ({ playbacks, compositor }, { signal }) => {
      // Check preconditions
      const hasContent = playbacks.some(playback => playback !== null)
      if (!hasContent) {
        log('render: no content')
        return null
      }

      const currentDuration = duration()
      if (currentDuration <= 0) {
        log('render: no duration')
        return null
      }

      setProgress(0)

      const totalFrames = Math.ceil(currentDuration * fps)
      log('starting', { duration: currentDuration, fps, totalFrames, bitrate })

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
        await Promise.all(
          playbacks
            .filter((playback): playback is Playback => playback !== null)
            .map(playback => playback.seek(0)),
        )

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

          // Get frames from all playbacks in parallel
          await Promise.all(
            playbacks.map(async (playback, i) => {
              if (!playback) return

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
            })
          )

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
      }
    }
  )

  // Derived state from action
  const isRendering = renderAction.pending
  const hasPreRender = () => renderAction.result() !== null
  const playback = () => renderAction.result()?.playback ?? null
  const blob = () => renderAction.result()?.blob ?? null

  function invalidate() {
    const result = renderAction.result()
    if (result) {
      result.playback.destroy()
      result.demuxer.destroy()
    }
    renderAction.clear()
    setProgress(0)
    lastSentTimestamp = null
    log('invalidated')
  }

  function render(playbacks: (Playback | null)[], compositor: WorkerCompositor) {
    // Clear any existing pre-render first
    invalidate()
    // Call the action
    renderAction({ playbacks, compositor }).catch(() => {})
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
    renderAction.cancel()
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
    cancel: renderAction.cancel,
    invalidate,
    tick,
    resetForLoop,
  }
}
