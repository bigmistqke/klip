import type { Agent } from '@atproto/api'
import { every, whenEffect, whenMemo } from '@bigmistqke/solid-whenever'
import { getMasterMixer, resumeAudioContext } from '@eddy/mixer'
import { debug } from '@eddy/utils'
import {
  createMemo,
  createResource,
  createSelector,
  createSignal,
  mapArray,
  onCleanup,
  type Accessor,
} from 'solid-js'
import { createAction } from '~/lib/create-action'
import { getProjectByRkey, getStemBlob, publishProject } from '~/lib/atproto/crud'
import { createDebugInfo } from '~/lib/create-debug-info'
import { createProjectStore } from '~/lib/project-store'
import { createRecorder, requestMediaAccess } from '~/lib/recorder'
import { createPlayer } from './create-player'

const log = debug('editor', false)

export interface CreateEditorOptions {
  agent: Accessor<Agent | null>
  container: HTMLDivElement
  handle?: string
  rkey?: string
}

export function createEditor(options: CreateEditorOptions) {
  const project = createProjectStore()

  // Core UI state
  const [isRecording, setIsRecording] = createSignal(false)
  const [selectedTrackIndex, setSelectedTrack] = createSignal<number | null>(null)
  const [masterVolume, setMasterVolume] = createSignal(1)

  const isSelectedTrack = createSelector(selectedTrackIndex)

  // Create player as a resource (cleanup via onCleanup inside fetcher)
  const [player] = createResource(
    () => ({ width: project.store.project.canvas.width, height: project.store.project.canvas.height }),
    async ({ width, height }) => {
      const _player = await createPlayer(width, height)
      options.container.appendChild(_player.canvas)
      ;(window as any).__EDDY_DEBUG__ = createDebugInfo(_player)

      onCleanup(() => {
        _player.destroy()
        stopPreview()
        delete (window as any).__EDDY_DEBUG__
      })

      return _player
    }
  )

  const [stream, setStream] = createSignal<MediaStream | null>(null)
  const [recorder, setRecorder] = createSignal<ReturnType<typeof createRecorder> | null>(null)

  // Resource: Load project record when rkey is provided
  const [projectRecord] = createResource(
    every(options.agent, () => options.rkey),
    async ([agent, rkey]) => {
      const record = await getProjectByRkey(agent, rkey, options.handle)
      project.setProject(record.value)
      project.setRemoteUri(record.uri)
      return record
    }
  )

  // Derive clips that have stems from project record
  const clipsWithStems = whenMemo(
    projectRecord,
    record =>
      record.value.tracks
        .flatMap(track => track.clips)
        .filter(
          (clip): clip is typeof clip & { stem: NonNullable<typeof clip.stem> } => !!clip.stem
        ),
    () => []
  )

  // Derive blob resource for each clip (chained async derivation)
  const stemBlobResources = mapArray(clipsWithStems, clip => {
    const [blob] = createResource(
      every(options.agent, () => clip.stem.uri),
      async ([agent, stemUri]) => {
        try {
          return await getStemBlob(agent, stemUri)
        } catch (err) {
          console.error(`Failed to fetch stem for clip ${clip.id}:`, err)
          return null
        }
      }
    )
    return { clipId: clip.id, blob, duration: clip.duration }
  })

  // Helper to get blob by clipId (from remote stems or local recordings)
  const getClipBlob = (clipId: string): Blob | undefined => {
    // Check remote stems first
    const stemResource = stemBlobResources().find(r => r.clipId === clipId)
    if (stemResource) {
      return stemResource.blob() ?? undefined
    }
    // Fall back to local recordings
    return project.getClipBlob(clipId)
  }

  // Load clips into player when project store changes
  whenEffect(player, player => {
    const tracks = project.store.project.tracks
    log('effect: checking clips to load', { numTracks: tracks.length })

    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`
      const track = tracks.find(t => t.id === trackId)
      const clip = track?.clips[0]

      if (clip) {
        const blob = getClipBlob(clip.id)
        if (blob && !player.hasClip(i)) {
          log('effect: loading clip into player', { trackIndex: i, clipId: clip.id })
          player.loadClip(i, blob).catch(err => {
            console.error(`Failed to load clip for track ${i}:`, err)
          })
        }
      } else if (player.hasClip(i)) {
        log('effect: clearing clip from player', { trackIndex: i })
        player.clearClip(i)
      }
    }
  })

  // Initialize volume/pan from project store
  whenEffect(player, player => {
    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`
      const pipeline = project.getTrackPipeline(trackId)

      for (let j = 0; j < pipeline.length; j++) {
        const effect = pipeline[j]
        const value = project.getEffectValue(trackId, j)

        if (effect.type === 'audio.gain') {
          player.setVolume(i, value)
        } else if (effect.type === 'audio.pan') {
          player.setPan(i, (value - 0.5) * 2)
        }
      }
    }
  })

  function stopPreview() {
    const track = selectedTrackIndex()
    if (track !== null) {
      player()?.setPreviewSource(track, null)
    }
    stream()?.getTracks().forEach(t => t.stop())
    setStream(null)
  }

  // Preview action - requests media access and sets up preview stream
  const previewAction = createAction(async (trackIndex: number) => {
    await resumeAudioContext()
    const result = await requestMediaAccess(true)
    if (result) {
      setStream(result)
      player()?.setPreviewSource(trackIndex, result)
    }
    return result
  })

  // Stop recording action - stops recorder, processes result, triggers pre-render
  const stopRecordingAction = createAction(async (track: number) => {
    log('stopRecording', { track })
    const _player = player()
    const _recorder = recorder()
    if (!_recorder) {
      throw new Error('Recording state but no recorder instance')
    }

    const result = await _recorder.stop()
    setRecorder(null)

    if (result) {
      log('stopRecording: got result', { blobSize: result.blob.size, duration: result.duration })
      result.firstFrame?.close()
      project.addRecording(track, result.blob, result.duration)
    }

    stopPreview()
    setIsRecording(false)
    setSelectedTrack(null)

    await _player?.stop()

    // Trigger pre-render after clip loads
    if (_player) {
      _player.preRenderer.invalidate()

      setTimeout(() => {
        const playbacks = [0, 1, 2, 3].map(i => _player.getSlot(i).playback())
        _player.preRenderer.render(playbacks, _player.compositor)
      }, 500)
    }

    return result
  })

  // Publish action - uploads clips and publishes project
  const publishAction = createAction(async () => {
    const currentAgent = options.agent()
    if (!currentAgent) {
      throw new Error('Please sign in to publish')
    }

    // Collect clip blobs
    const clipBlobs = new Map<string, { blob: Blob; duration: number }>()
    for (const track of project.store.project.tracks) {
      for (const clip of track.clips) {
        const blob = getClipBlob(clip.id)
        const duration = clip.duration
        if (blob && duration) {
          clipBlobs.set(clip.id, { blob, duration })
        }
      }
    }

    if (clipBlobs.size === 0) {
      throw new Error('No recordings to publish')
    }

    const result = await publishProject(currentAgent, project.store.project, clipBlobs)
    // Extract rkey from AT URI: at://did/collection/rkey
    return result.uri.split('/').pop()
  })

  async function startRecording() {
    log('startRecording')
    const _player = player()
    if (!_player) return

    const _stream = stream()
    if (!_stream) {
      throw new Error('Cannot start recording without media stream')
    }

    const _recorder = createRecorder(_stream)
    _recorder.start()
    setRecorder(_recorder)

    setIsRecording(true)

    log('startRecording: calling player.play(0)')
    await _player.play(0)
  }

  // Derived state
  const hasAnyRecording = whenMemo(
    player,
    player => {
      for (let i = 0; i < 4; i++) {
        if (player.hasClip(i)) return true
      }
      return false
    },
    () => false,
  )

  const canPublish = createMemo(() => {
    const _player = player()
    return (
      !isRecording() &&
      !(_player?.isPlaying() ?? false) &&
      !publishAction.pending() &&
      hasAnyRecording() &&
      !!options.agent()
    )
  })

  return {
    // Project store
    project,

    // Player
    player,

    // State (all reactive)
    isRecording,
    selectedTrack: selectedTrackIndex,
    masterVolume,
    isSelectedTrack,
    hasAnyRecording,
    canPublish,

    // Loading states (from resources)
    isPlayerLoading: () => player.loading,
    isProjectLoading: () =>
      projectRecord.loading || stemBlobResources().some(r => r.blob.loading),

    // Action states
    previewPending: previewAction.pending,
    stopRecordingPending: stopRecordingAction.pending,
    isPublishing: publishAction.pending,
    publishError: publishAction.error,

    // Pre-render state (from player)
    isPreRendering: () => player()?.preRenderer.isRendering() ?? false,
    preRenderProgress: () => player()?.preRenderer.progress() ?? 0,

    // Loop state (from player clock)
    loopEnabled: () => player()?.loop() ?? false,

    // Actions
    async stop() {
      await player()?.stop()
    },

    selectTrack(trackIndex: number) {
      log('selectTrack', { trackIndex })
      const _player = player()

      if (isSelectedTrack(trackIndex)) {
        stopPreview()
        setSelectedTrack(null)
        return
      }

      if (isRecording()) return

      stopPreview()

      if (_player && !_player.hasClip(trackIndex)) {
        setSelectedTrack(trackIndex)
        previewAction(trackIndex).catch(() => {})
      }
    },

    toggleRecording() {
      const trackIndex = selectedTrackIndex()
      if (trackIndex === null) return
      if (stopRecordingAction.pending()) return

      if (isRecording()) {
        stopRecordingAction(trackIndex).catch(() => {})
      } else {
        startRecording()
      }
    },

    async playPause() {
      const _player = player()
      if (!_player) return

      if (selectedTrackIndex() !== null && !isRecording()) {
        stopPreview()
        setSelectedTrack(null)
      }

      await resumeAudioContext()

      if (_player.isPlaying()) {
        _player.pause()
      } else {
        await _player.play()
      }
    },

    clearRecording(index: number) {
      project.clearTrack(index)
      const _player = player()
      if (_player) {
        _player.clearClip(index)
        _player.preRenderer.invalidate()
      }
    },

    setTrackVolume(index: number, value: number) {
      const trackId = `track-${index}`
      const pipeline = project.getTrackPipeline(trackId)
      const gainIndex = pipeline.findIndex(e => e.type === 'audio.gain')
      if (gainIndex !== -1) {
        project.setEffectValue(trackId, gainIndex, value)
      }
      player()?.setVolume(index, value)
    },

    setTrackPan(index: number, value: number) {
      const trackId = `track-${index}`
      const pipeline = project.getTrackPipeline(trackId)
      const panIndex = pipeline.findIndex(e => e.type === 'audio.pan')
      if (panIndex !== -1) {
        project.setEffectValue(trackId, panIndex, (value + 1) / 2)
      }
      player()?.setPan(index, value)
    },

    updateMasterVolume(value: number) {
      setMasterVolume(value)
      getMasterMixer().setMasterVolume(value)
    },

    publish() {
      return publishAction()
    },

    toggleLoop() {
      const _player = player()
      if (_player) {
        _player.setLoop(!_player.loop())
      }
    },
  }
}

export type Editor = ReturnType<typeof createEditor>
