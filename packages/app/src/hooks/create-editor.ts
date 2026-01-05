import type { Agent } from '@atproto/api'
import { every, whenEffect, whenMemo } from '@bigmistqke/solid-whenever'
import type { AudioEffect, Project, Track } from '@eddy/lexicons'
import { getMasterMixer, resumeAudioContext } from '@eddy/mixer'
import { debug } from '@eddy/utils'
import {
  createEffect,
  createMemo,
  createResource,
  createSelector,
  createSignal,
  mapArray,
  onCleanup,
  type Accessor,
} from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { getProjectByRkey, getStemBlob, publishProject } from '~/lib/atproto/crud'
import { createAction } from '~/lib/create-action'
import { createDebugInfo } from '~/lib/create-debug-info'
import { createRecorder, requestMediaAccess } from '~/lib/create-recorder'
import { createPlayer } from './create-player'

const log = debug('editor', false)

// Local state extensions (not persisted to PDS)
interface LocalClipState {
  blob?: Blob
  duration?: number
}

function createDefaultProject(): Project {
  return {
    schemaVersion: 1,
    title: 'Untitled Project',
    canvas: {
      width: 640,
      height: 360,
    },
    groups: [
      {
        id: 'main-grid',
        members: [{ id: 'track-0' }, { id: 'track-1' }, { id: 'track-2' }, { id: 'track-3' }],
        layout: {
          type: 'grid',
          columns: 2,
          rows: 2,
        },
      },
    ],
    tracks: [
      {
        id: 'track-0',
        name: 'Track 1',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
      {
        id: 'track-1',
        name: 'Track 2',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
      {
        id: 'track-2',
        name: 'Track 3',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
      {
        id: 'track-3',
        name: 'Track 4',
        clips: [],
        audioPipeline: [
          { type: 'audio.gain', value: { value: 100 } },
          { type: 'audio.pan', value: { value: 50 } },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
  }
}

export interface CreateEditorOptions {
  agent: Accessor<Agent | null>
  container: HTMLDivElement
  handle?: string
  rkey?: string
}

export function createEditor(options: CreateEditorOptions) {
  // Project store
  const [project, setProject] = createStore<Project>(createDefaultProject())

  // Local state (not persisted)
  const [localClips, setLocalClips] = createStore<Record<string, LocalClipState>>({})
  const [remoteUri, setRemoteUri] = createSignal<string | null>(null)

  // Core UI state
  const [selectedTrackIndex, setSelectedTrack] = createSignal<number | null>(null)
  const [masterVolume, setMasterVolume] = createSignal(1)

  const isSelectedTrack = createSelector(selectedTrackIndex)
  const isRecording = () => !!startRecordingAction.result()

  // Create player as a resource
  const [player] = createResource(
    () => ({
      width: project.canvas.width,
      height: project.canvas.height,
    }),
    async ({ width, height }) => {
      const _player = await createPlayer(width, height)
      options.container.appendChild(_player.canvas)
      ;(window as any).__EDDY_DEBUG__ = createDebugInfo(_player)

      onCleanup(() => {
        _player.destroy()
        previewAction.clear()
        delete (window as any).__EDDY_DEBUG__
      })

      return _player
    },
  )

  // Resource: Load project record when rkey is provided
  const [projectRecord] = createResource(
    every(options.agent, () => options.rkey),
    async ([agent, rkey]) => {
      const record = await getProjectByRkey(agent, rkey, options.handle)
      setProject(record.value)
      setRemoteUri(record.uri)
      return record
    },
  )

  // Derive clips that have stems from project record
  const clipsWithStems = whenMemo(
    projectRecord,
    record =>
      record.value.tracks
        .flatMap(track => track.clips)
        .filter(
          (clip): clip is typeof clip & { stem: NonNullable<typeof clip.stem> } => !!clip.stem,
        ),
    () => [],
  )

  // Derive blob resource for each clip (chained async derivation)
  const stemBlobResources = createMemo(
    mapArray(clipsWithStems, clip => {
      const [blob] = createResource(
        every(options.agent, () => clip.stem.uri),
        ([agent, stemUri]) => {
          try {
            return getStemBlob(agent, stemUri)
          } catch (err) {
            console.error(`Failed to fetch stem for clip ${clip.id}:`, err)
            return null
          }
        },
      )
      return { clipId: clip.id, blob, duration: clip.duration }
    }),
  )

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

  // Project store actions
  function setTitle(title: string) {
    setProject('title', title)
    setProject('updatedAt', new Date().toISOString())
  }

  function setEffectValue(trackId: string, effectIndex: number, value: number) {
    setProject(
      'tracks',
      t => t.id === trackId,
      'audioPipeline',
      effectIndex,
      effect => {
        if ('value' in effect && effect.value && 'value' in effect.value) {
          return { ...effect, value: { ...effect.value, value: Math.round(value * 100) } }
        }
        return effect
      },
    )
  }

  function getEffectValue(trackId: string, effectIndex: number): number {
    const track = project.tracks.find(t => t.id === trackId)
    const effect = track?.audioPipeline?.[effectIndex]
    if (effect && 'value' in effect && effect.value && 'value' in effect.value) {
      return effect.value.value / 100
    }
    return 1
  }

  function getTrackPipeline(trackId: string): AudioEffect[] {
    const track = project.tracks.find(t => t.id === trackId)
    return track?.audioPipeline ?? []
  }

  function addRecording(trackIndex: number, blob: Blob, duration: number) {
    const trackId = `track-${trackIndex}`
    const clipId = `clip-${trackIndex}-${Date.now()}`

    setProject(
      'tracks',
      t => t.id === trackId,
      produce((track: Track) => {
        track.clips = [
          {
            id: clipId,
            offset: 0,
            duration: Math.round(duration),
          },
        ]
      }),
    )

    setLocalClips(clipId, { blob, duration })
    setProject('updatedAt', new Date().toISOString())
  }

  function clearTrack(trackIndex: number) {
    const trackId = `track-${trackIndex}`
    const track = project.tracks.find(t => t.id === trackId)

    if (track) {
      for (const clip of track.clips) {
        setLocalClips(clip.id, undefined!)
      }
    }

    setProject(
      'tracks',
      t => t.id === trackId,
      produce((track: Track) => {
        track.clips = []
      }),
    )

    setProject('updatedAt', new Date().toISOString())
  }

  function getLocalClipBlob(clipId: string): Blob | undefined {
    return localClips[clipId]?.blob
  }

  // Helper to get blob by clipId (from remote stems or local recordings)
  function getClipBlob(clipId: string): Blob | undefined {
    const stemResource = stemBlobResources().find(r => r.clipId === clipId)
    if (stemResource) {
      return stemResource.blob() ?? undefined
    }
    return getLocalClipBlob(clipId)
  }

  // Preview action - requests media access and sets up preview stream
  const previewAction = createAction(async (trackIndex: number, { onCleanup }) => {
    await resumeAudioContext()
    const stream = await requestMediaAccess(true)
    if (stream) {
      player()?.setPreviewSource(trackIndex, stream)

      onCleanup(() => {
        stream.getTracks().forEach(t => t.stop())
        player()?.setPreviewSource(trackIndex, null)
      })
    }
    return stream
  })

  // Start recording action - creates recorder and starts playback
  const startRecordingAction = createAction(async (trackIndex: number) => {
    log('startRecording', { trackIndex })
    const _player = player()
    if (!_player) {
      throw new Error('No player available')
    }

    const stream = previewAction.result()
    if (!stream) {
      throw new Error('Cannot start recording without media stream')
    }

    const recorder = createRecorder(stream)
    recorder.start()

    log('startRecording: calling player.play(0)')
    await _player.play(0)

    return { recorder, trackIndex }
  })

  // Stop recording action - stops recorder, processes result, triggers pre-render
  const stopRecordingAction = createAction(async () => {
    const recordingState = startRecordingAction.result()
    if (!recordingState) {
      throw new Error('No active recording')
    }

    const { recorder, trackIndex } = recordingState
    log('stopRecording', { trackIndex })

    const _player = player()

    const result = await recorder.stop()

    if (result) {
      log('stopRecording: got result', { blobSize: result.blob.size, duration: result.duration })
      result.firstFrame?.close()
      addRecording(trackIndex, result.blob, result.duration)
    }

    startRecordingAction.clear()
    previewAction.clear()
    setSelectedTrack(null)

    await _player?.stop()

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

    const clipBlobs = new Map<string, { blob: Blob; duration: number }>()
    for (const track of project.tracks) {
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

    const result = await publishProject(currentAgent, project, clipBlobs)
    return result.uri.split('/').pop()
  })

  whenEffect(player, player => {
    createEffect(() => {
      // Load clips into player when project store changes
      const tracks = project.tracks
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

      // Initialize volume/pan from project store
      createEffect(() => {
        for (let i = 0; i < 4; i++) {
          const trackId = `track-${i}`
          const pipeline = getTrackPipeline(trackId)

          for (let j = 0; j < pipeline.length; j++) {
            const effect = pipeline[j]
            const value = getEffectValue(trackId, j)

            if (effect.type === 'audio.gain') {
              player.setVolume(i, value)
            } else if (effect.type === 'audio.pan') {
              player.setPan(i, (value - 0.5) * 2)
            }
          }
        }
      })
    })
  })

  createEffect(() => getMasterMixer().setMasterVolume(masterVolume()))

  return {
    canPublish() {
      return (
        !isRecording() &&
        !player()?.isPlaying() &&
        !publishAction.pending() &&
        hasAnyRecording() &&
        !!options.agent()
      )
    },
    getEffectValue,
    getTrackPipeline,
    hasAnyRecording,
    isPlayerLoading: () => player.loading,
    isPreRendering: () => player()?.preRenderer.isRendering() ?? false,
    isProjectLoading: () => projectRecord.loading || stemBlobResources().some(r => r.blob.loading),
    isPublishing: publishAction.pending,
    isRecording,
    isSelectedTrack,
    loopEnabled: () => player()?.loop() ?? false,
    masterVolume,
    player,
    preRenderProgress: () => player()?.preRenderer.progress() ?? 0,
    previewPending: previewAction.pending,
    publishError: publishAction.error,
    selectedTrack: selectedTrackIndex,
    setMasterVolume,
    setTitle,
    stopRecordingPending: stopRecordingAction.pending,
    project,

    publish() {
      return publishAction()
    },

    async stop() {
      await player()?.stop()
    },

    selectTrack(trackIndex: number) {
      log('selectTrack', { trackIndex })
      const _player = player()

      if (isSelectedTrack(trackIndex)) {
        previewAction.clear()
        setSelectedTrack(null)
        return
      }

      if (isRecording()) return

      previewAction.clear()

      if (_player && !_player.hasClip(trackIndex)) {
        setSelectedTrack(trackIndex)
        previewAction.try(trackIndex)
      }
    },

    toggleRecording() {
      const trackIndex = selectedTrackIndex()
      if (trackIndex === null) return
      if (startRecordingAction.pending() || stopRecordingAction.pending()) return

      if (isRecording()) {
        stopRecordingAction.try()
      } else {
        startRecordingAction.try(trackIndex)
      }
    },

    async playPause() {
      const _player = player()
      if (!_player) return

      if (selectedTrackIndex() !== null && !isRecording()) {
        previewAction.clear()
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
      clearTrack(index)
      const _player = player()
      if (_player) {
        _player.clearClip(index)
        _player.preRenderer.invalidate()
      }
    },

    setTrackVolume(index: number, value: number) {
      const trackId = `track-${index}`
      const pipeline = getTrackPipeline(trackId)
      const gainIndex = pipeline.findIndex(e => e.type === 'audio.gain')
      if (gainIndex !== -1) {
        setEffectValue(trackId, gainIndex, value)
      }
      player()?.setVolume(index, value)
    },

    setTrackPan(index: number, value: number) {
      const trackId = `track-${index}`
      const pipeline = getTrackPipeline(trackId)
      const panIndex = pipeline.findIndex(e => e.type === 'audio.pan')
      if (panIndex !== -1) {
        setEffectValue(trackId, panIndex, (value + 1) / 2)
      }
      player()?.setPan(index, value)
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
