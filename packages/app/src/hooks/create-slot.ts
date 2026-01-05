import { createAudioPipeline, type AudioPipeline } from '@eddy/mixer'
import { createPlayback, type Playback } from '@eddy/playback'
import type { Accessor } from 'solid-js'
import { createAction } from '~/lib/create-action'
import { createDemuxerWorker } from '~/workers'
import type { WorkerCompositor } from '~/workers/create-compositor-worker'

export interface Slot {
  // State (reactive)
  playback: Accessor<Playback | null>
  audioPipeline: AudioPipeline

  // Clip management
  load(blob: Blob): Promise<void>
  clear(): void
  hasClip(): boolean

  // Preview
  setPreviewSource(stream: MediaStream | null): void

  // Audio controls
  setVolume(value: number): void
  setPan(value: number): void

  // Playback control
  prepareToPlay(time: number): Promise<void>
  startAudio(time: number): void
  tick(time: number, includeVideo?: boolean): void
  pause(): void
  stop(): void
  seek(time: number): Promise<void>
  resetForLoop(time: number): void

  // Frame rendering (returns true if frame was sent)
  renderFrame(time: number, playing: boolean): void

  // Cleanup
  destroy(): void
}

export interface CreateSlotOptions {
  index: number
  compositor: WorkerCompositor
}

export function createSlot(options: CreateSlotOptions): Slot {
  const { index, compositor } = options

  const audioPipeline = createAudioPipeline()
  let lastSentTimestamp: number | null = null

  // Load action - manages demuxer and playback lifecycle
  const loadAction = createAction(async (blob: Blob, { onCleanup }) => {
    const demuxer = await createDemuxerWorker(blob)
    const newPlayback = await createPlayback(demuxer, {
      audioDestination: audioPipeline.gain,
    })
    await newPlayback.seek(0)

    // Cleanup when action is cleared, cancelled, or replaced
    onCleanup(() => {
      newPlayback.destroy()
      demuxer.destroy()
      compositor.setFrame(index, null)
    })

    return newPlayback
  })

  const playback = () => loadAction.result() ?? null

  async function load(blob: Blob): Promise<void> {
    await loadAction(blob)
  }

  function clear(): void {
    loadAction.clear()
    lastSentTimestamp = null
  }

  function hasClip(): boolean {
    return !!loadAction.result()
  }

  function setPreviewSource(stream: MediaStream | null): void {
    compositor.setPreviewStream(index, stream)
  }

  function setVolume(value: number): void {
    audioPipeline.setVolume(value)
  }

  function setPan(value: number): void {
    audioPipeline.setPan(value)
  }

  async function prepareToPlay(time: number): Promise<void> {
    await playback()?.prepareToPlay(time)
  }

  function startAudio(time: number): void {
    playback()?.startAudio(time)
  }

  function tick(time: number, includeVideo = true): void {
    playback()?.tick(time, includeVideo)
  }

  function pause(): void {
    playback()?.pause()
  }

  function stop(): void {
    playback()?.stop()
  }

  async function seek(time: number): Promise<void> {
    lastSentTimestamp = null
    await playback()?.seek(time)
  }

  function resetForLoop(time: number): void {
    lastSentTimestamp = null
    playback()?.resetForLoop(time)
  }

  function renderFrame(time: number, playing: boolean): void {
    const currentPlayback = playback()
    if (!currentPlayback) return

    if (playing) {
      currentPlayback.tick(time)
    }

    const frameTimestamp = currentPlayback.getFrameTimestamp(time)

    // Clip has ended or no frame available
    if (frameTimestamp === null) {
      if (lastSentTimestamp !== null) {
        lastSentTimestamp = null
        compositor.setFrame(index, null)
      }
      return
    }

    // Same frame as last time - skip
    if (frameTimestamp === lastSentTimestamp) {
      return
    }

    const frame = currentPlayback.getFrameAt(time)
    if (frame) {
      lastSentTimestamp = frameTimestamp
      compositor.setFrame(index, frame)
    }
  }

  function destroy(): void {
    loadAction.clear()
    audioPipeline.disconnect()
  }

  return {
    playback,
    audioPipeline,
    load,
    clear,
    hasClip,
    setPreviewSource,
    setVolume,
    setPan,
    prepareToPlay,
    startAudio,
    tick,
    pause,
    stop,
    seek,
    resetForLoop,
    renderFrame,
    destroy,
  }
}
