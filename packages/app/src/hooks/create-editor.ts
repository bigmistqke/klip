import type { Agent } from '@atproto/api'
import { $MESSENGER, rpc, transfer } from '@bigmistqke/rpc/messenger'
import { every, whenEffect, whenMemo } from '@bigmistqke/solid-whenever'
import type { AudioEffect, ClipSource, ClipSourceStem, Project, Track } from '@eddy/lexicons'
import { getMasterMixer, resumeAudioContext } from '@eddy/mixer'
import { debug } from '@eddy/utils'
import { createEffect, createSelector, createSignal, mapArray, type Accessor } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { action, defer, hold } from '~/hooks/action'
import { deepResource } from '~/hooks/deep-resource'
import { resource } from '~/hooks/resource'
import { getProjectByRkey, getStemBlob, publishProject } from '~/lib/atproto/crud'
import { createDebugInfo as initDebugInfo } from '~/lib/create-debug-info'
import { createResourceMap } from '~/lib/create-resource-map'
import { assertedNotNullish } from '~/utils'
import type { CaptureWorkerMethods } from '~/workers/capture.worker'
import CaptureWorker from '~/workers/capture.worker?worker'
import type { MuxerWorkerMethods } from '~/workers/muxer.worker'
import MuxerWorker from '~/workers/muxer.worker?worker'
import { createPlayer } from './create-player'

const log = debug('editor', false)

/** Check if a clip source is a stem reference */
function isStemSource(source: ClipSource | undefined): source is ClipSourceStem {
  return source?.type === 'stem'
}

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
  canvas: Accessor<HTMLCanvasElement | undefined>
  handle?: string
  rkey?: string
}

export function createEditor(options: CreateEditorOptions) {
  // Project store - synced from remote when rkey provided, editable locally
  const [project, { mutate: setProject }] = deepResource(
    every(
      () => options.agent(),
      () => options.rkey,
    ),
    ([agent, rkey]) =>
      getProjectByRkey(agent, rkey, options.handle).then(projectRecord => projectRecord.value),
    {
      initialValue: createDefaultProject(),
    },
  )

  // Create player as a resource (waits for canvas to be available)
  const [player] = resource(
    every(
      () => options.canvas(),
      () => project().canvas.width,
      () => project().canvas.height,
    ),
    async ([canvas, width, height], { onCleanup }) => {
      const result = await createPlayer({
        canvas,
        width,
        height,
        project,
      })
      initDebugInfo(result)

      onCleanup(() => {
        result.destroy()
        previewAction.clear()
      })

      return result
    },
  )

  // Pre-initialize capture and muxer workers
  const [workers] = resource(async ({ onCleanup }) => {
    log('creating workers...')
    const capture = rpc<CaptureWorkerMethods>(new CaptureWorker())
    const muxer = rpc<MuxerWorkerMethods>(new MuxerWorker())

    onCleanup(() => {
      capture[$MESSENGER].terminate()
      muxer[$MESSENGER].terminate()
    })

    // Create MessageChannel to connect capture → muxer
    const channel = new MessageChannel()

    // Set up ports via RPC
    await Promise.all([
      muxer.setCapturePort(transfer(channel.port2)),
      capture.setMuxerPort(transfer(channel.port1)),
    ])

    // Pre-initialize VP9 encoder (avoids ~2s startup during recording)
    await muxer.preInit()
    log('workers ready')

    return { capture, muxer }
  })

  const [localClips, setLocalClips] = createStore<Record<string, LocalClipState>>({})
  const [selectedTrackId, setSelectedTrackId] = createSignal<string | null>(null)
  const [masterVolume, setMasterVolume] = createSignal(1)

  const isSelectedTrack = createSelector(selectedTrackId)
  const isRecording = () => recordAction.pending()

  // Resource map for stem blobs - fine-grained reactivity per clipId
  const stemBlobs = createResourceMap(
    // Derive clips that have stem sources from project store
    () =>
      project()
        .tracks.flatMap(track => track.clips)
        .filter((clip): clip is typeof clip & { source: ClipSourceStem } =>
          isStemSource(clip.source),
        )
        .map(clip => [clip.id, clip] as const),
    async (clipId, clip) => {
      const agent = options.agent()
      if (!agent) return null

      try {
        return await getStemBlob(agent, clip.source.ref.uri)
      } catch (err) {
        console.error(`Failed to fetch stem for clip ${clipId}:`, err)
        return null
      }
    },
  )

  // Derived state
  const hasAnyRecording = whenMemo(
    player,
    _player => {
      for (const track of project().tracks) {
        if (_player.hasClip(track.id)) return true
      }
      return false
    },
    () => false,
  )

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
    const track = project().tracks.find(t => t.id === trackId)
    const effect = track?.audioPipeline?.[effectIndex]
    if (effect && 'value' in effect && effect.value && 'value' in effect.value) {
      return effect.value.value / 100
    }
    return 1
  }

  function getTrackPipeline(trackId: string): AudioEffect[] {
    const track = project().tracks.find(t => t.id === trackId)
    return track?.audioPipeline ?? []
  }

  function addRecording(trackId: string, blob: Blob, duration: number) {
    const clipId = `clip-${trackId}-${Date.now()}`

    // Set localClips FIRST so the blob is available when the effect runs
    // (Solid doesn't track store keys that don't exist when first accessed)
    setLocalClips(clipId, { blob, duration })

    setProject('tracks', track => track.id === trackId, 'clips', [
      {
        id: clipId,
        offset: 0,
        duration: Math.round(duration),
      },
    ])

    setProject('updatedAt', new Date().toISOString())
  }

  function clearTrack(trackId: string) {
    const track = project().tracks.find(t => t.id === trackId)

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

  // Helper to get blob by clipId (from remote stems or local recordings)
  // Uses fine-grained access - only subscribes to the specific clipId
  function getClipBlob(clipId: string): Blob | undefined {
    return stemBlobs.get(clipId) ?? localClips[clipId]?.blob
  }

  // Preview action - requests media access and sets up preview stream
  const previewAction = action(async (trackId: string, { onCleanup }) => {
    await resumeAudioContext()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: { facingMode: 'user' },
    })
    player()?.setPreviewSource(trackId, stream)

    onCleanup(() => {
      stream.getTracks().forEach(t => t.stop())
      player()?.setPreviewSource(trackId, null)
    })

    return stream
  })

  const recordAction = action(function* (trackId: string, { onCleanup }) {
    log('record', { trackId })

    const _workers = assertedNotNullish(workers(), 'Workers not ready')
    const _player = assertedNotNullish(player(), 'No player available')
    const stream = assertedNotNullish(
      previewAction.latest(),
      'Cannot start recording without media stream',
    )

    // Get video track and create processor
    const videoTrack = assertedNotNullish(stream.getVideoTracks()[0], 'No video track')
    const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack })

    // Get audio track and create processor (if available)
    const [audioTrack] = stream.getAudioTracks()
    const audioProcessor = audioTrack ? new MediaStreamTrackProcessor({ track: audioTrack }) : null

    // Start capture (runs until cancelled)
    const startTime = performance.now()
    const capturePromise = _workers.capture
      .start(
        transfer(videoProcessor.readable),
        audioProcessor ? transfer(audioProcessor.readable) : undefined,
      )
      .catch((err: unknown) => log('capture error:', err))

    onCleanup(async () => {
      log('stopping capture...')
      await capturePromise
      await _workers.capture.stop()
    })

    // Route playback audio through MediaStream output during recording.
    // Avoids Chrome bug where AudioContext.destination interferes with getUserMedia capture.
    const mixer = getMasterMixer()
    mixer.useMediaStreamOutput()
    onCleanup(() => mixer.useDirectOutput())

    yield* defer(_player.play(0))

    log('recording started')

    // Hold until cancelled, then return recording info for finalization
    return hold(() => ({ trackId, startTime }))
  })

  // Finalize recording and add to track
  const finalizeRecordingAction = action(
    async ({ trackId, startTime }: { trackId: string; startTime: number }) => {
      const _workers = assertedNotNullish(workers(), 'Workers not ready')

      log('finalizing recording...')
      const result = await _workers.muxer.finalize()
      const duration = performance.now() - startTime

      if (result.blob.size > 0) {
        log('recording finalized', {
          blobSize: result.blob.size,
          frameCount: result.frameCount,
          duration,
        })

        addRecording(trackId, result.blob, duration)
      }

      // Reset muxer for next recording
      await _workers.muxer.reset()
      await _workers.muxer.preInit()

      await player()?.stop()

      return result
    },
  )

  // Publish action - uploads clips and publishes project
  const publishAction = action(async () => {
    const currentAgent = options.agent()
    if (!currentAgent) {
      throw new Error('Please sign in to publish')
    }

    const clipBlobs = new Map<string, { blob: Blob; duration: number }>()
    for (const track of project().tracks) {
      for (const clip of track.clips) {
        // Skip clips that already have a stem source - they don't need to be re-uploaded
        if (clip.source?.type === 'stem') continue

        const blob = getClipBlob(clip.id)
        const duration = clip.duration
        if (blob && duration) {
          clipBlobs.set(clip.id, { blob, duration })
        }
      }
    }

    // Check if there's anything to publish (either new recordings or existing stems)
    const hasNewRecordings = clipBlobs.size > 0
    const hasExistingStems = project().tracks.some(track =>
      track.clips.some(clip => clip.source?.type === 'stem'),
    )

    if (!hasNewRecordings && !hasExistingStems) {
      throw new Error('No recordings to publish')
    }

    const result = await publishProject(currentAgent, project(), clipBlobs)
    return result.uri.split('/').pop()
  })

  // Load clips into player - each track has its own effect for fine-grained reactivity
  whenEffect(player, _player => {
    createEffect(
      mapArray(
        () => project().tracks.map(t => t.id),
        trackId => {
          // Track the current clip ID to detect changes
          let currentClipId: string | null = null

          // Effect for loading/clearing clips
          createEffect(() => {
            // Access track by ID
            const track = project().tracks.find(t => t.id === trackId)
            const clip = track?.clips[0]
            const newClipId = clip?.id ?? null

            // Clip changed - clear old one first
            if (newClipId !== currentClipId) {
              if (_player.hasClip(trackId)) {
                log('clearing old clip from player', { trackId, oldClipId: currentClipId })
                _player.clearClip(trackId)
              }
              currentClipId = newClipId
            }

            // Load new clip if available
            if (clip) {
              const blob = getClipBlob(clip.id)
              if (blob && !_player.hasClipForTrack(trackId) && !_player.isLoadingForTrack(trackId)) {
                log('loading clip into player', { trackId, clipId: clip.id })
                _player.loadClip(trackId, blob, clip.id).catch(err => {
                  console.error(`Failed to load clip for track ${trackId}:`, err)
                })
              }
            }
          })

          // Effect for volume/pan
          createEffect(() => {
            const pipeline = getTrackPipeline(trackId)

            for (let j = 0; j < pipeline.length; j++) {
              const effect = pipeline[j]
              const value = getEffectValue(trackId, j)

              if (effect.type === 'audio.gain') {
                _player.setVolume(trackId, value)
              } else if (effect.type === 'audio.pan') {
                _player.setPan(trackId, (value - 0.5) * 2)
              }
            }
          })
        },
      ),
    )
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
    isProjectLoading: () => project.loading || stemBlobs.loading(),
    isPublishing: publishAction.pending,
    isRecording,
    isSelectedTrack,
    loopEnabled: () => player()?.loop() ?? false,
    masterVolume,
    player,
    previewPending: previewAction.pending,
    publishError: publishAction.error,
    selectedTrack: selectedTrackId,
    setMasterVolume,
    // Project store actions
    setTitle(title: string) {
      setProject('title', title)
      setProject('updatedAt', new Date().toISOString())
    },
    finalizingRecording: finalizeRecordingAction.pending,
    project: project,

    publish() {
      return publishAction()
    },

    async stop() {
      await player()?.stop()
    },

    selectTrack(trackId: string) {
      log('selectTrack', { trackId })
      const _player = player()

      if (isSelectedTrack(trackId)) {
        previewAction.clear()
        setSelectedTrackId(null)
        return
      }

      if (isRecording()) return

      previewAction.clear()

      if (_player && !_player.hasClip(trackId)) {
        setSelectedTrackId(trackId)
        previewAction.try(trackId)
      }
    },

    async toggleRecording() {
      const trackId = selectedTrackId()
      if (trackId === null) return
      if (finalizeRecordingAction.pending()) return

      if (isRecording()) {
        // Stop recording - cancel triggers hold to resolve
        recordAction.cancel()

        // Await the result
        const result = await recordAction.promise()

        previewAction.clear()
        setSelectedTrackId(null)

        if (result) {
          await finalizeRecordingAction(result)
        }
      } else {
        recordAction.try(trackId)
      }
    },

    async playPause() {
      const _player = player()
      if (!_player) return

      if (selectedTrackId() !== null && !isRecording()) {
        previewAction.clear()
        setSelectedTrackId(null)
      }

      await resumeAudioContext()

      if (_player.isPlaying()) {
        _player.pause()
      } else {
        await _player.play()
      }
    },

    clearRecording(trackId: string) {
      clearTrack(trackId)
      player()?.clearClip(trackId)
    },

    setTrackVolume(trackId: string, value: number) {
      const pipeline = getTrackPipeline(trackId)
      const gainIndex = pipeline.findIndex(e => e.type === 'audio.gain')
      if (gainIndex !== -1) {
        setEffectValue(trackId, gainIndex, value)
      }
      player()?.setVolume(trackId, value)
    },

    setTrackPan(trackId: string, value: number) {
      const pipeline = getTrackPipeline(trackId)
      const panIndex = pipeline.findIndex(e => e.type === 'audio.pan')
      if (panIndex !== -1) {
        setEffectValue(trackId, panIndex, (value + 1) / 2)
      }
      player()?.setPan(trackId, value)
    },

    toggleLoop() {
      const _player = player()
      if (_player) {
        _player.setLoop(!_player.loop())
      }
    },

    downloadClip(trackId: string) {
      const track = project().tracks.find(t => t.id === trackId)
      if (!track || track.clips.length === 0) {
        console.warn('No clip found for track', trackId)
        return
      }
      const clipId = track.clips[0].id
      const blob = getClipBlob(clipId)
      if (!blob) {
        console.warn('No blob found for clip', clipId)
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${trackId}.webm`
      link.click()
      URL.revokeObjectURL(url)
    },

    /** Load a test clip into a track (for perf testing) */
    loadTestClip(trackId: string, blob: Blob, duration: number) {
      addRecording(trackId, blob, duration)
    },
  }
}

export type Editor = ReturnType<typeof createEditor>
