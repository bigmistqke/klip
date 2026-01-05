import { $MESSENGER, rpc, transfer } from '@bigmistqke/rpc/messenger'
import type { Demuxer } from '@eddy/codecs'
import { createAudioPipeline, type AudioPipeline } from '@eddy/mixer'
import { createPlayback, type Playback } from '@eddy/playback'
import type { Accessor } from 'solid-js'
import { action } from '~/hooks/action'
import type { Compositor } from '~/hooks/create-player'
import type { DemuxWorkerMethods } from '~/workers/demux.worker'
import DemuxWorker from '~/workers/demux.worker?worker'

export interface Slot {
  // State (reactive)
  playback: Accessor<Playback | null>
  audioPipeline: AudioPipeline

  // Clip management
  load(blob: Blob): Promise<void>
  clear(): void
  hasClip(): boolean
  isLoading(): boolean

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
  compositor: Compositor
}

export function createSlot(options: CreateSlotOptions): Slot {
  const { index, compositor } = options

  const audioPipeline = createAudioPipeline()
  let lastSentTimestamp: number | null = null

  // Load action - manages demuxer and playback lifecycle
  const loadAction = action(async (blob: Blob, { onCleanup }) => {
    // Create demuxer worker
    const worker = rpc<DemuxWorkerMethods>(new DemuxWorker())
    const buffer = await blob.arrayBuffer()
    const info = await worker.init(buffer)

    // Create demuxer wrapper - don't use Object.assign with proxy
    // as the proxy's get trap intercepts all property access
    const demuxer: Demuxer = {
      info,
      getVideoConfig: () => worker.getVideoConfig(),
      getAudioConfig: () => worker.getAudioConfig(),
      getSamples: (trackId, startTime, endTime) => worker.getSamples(trackId, startTime, endTime),
      getAllSamples: trackId => worker.getAllSamples(trackId),
      getKeyframeBefore: (trackId, time) => worker.getKeyframeBefore(trackId, time),
      destroy() {
        worker.destroy()
        worker[$MESSENGER].terminate()
      },
    }

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

  function isLoading(): boolean {
    return loadAction.pending()
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
      compositor.setFrame(index, transfer(frame))
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
    isLoading,
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
