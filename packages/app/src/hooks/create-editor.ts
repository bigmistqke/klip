import type { Agent } from '@atproto/api'
import { whenEffect, whenMemo } from '@bigmistqke/solid-whenever'
import { getMasterMixer, resumeAudioContext } from '@eddy/mixer'
import { debug } from '@eddy/utils'
import { action, useSubmission } from '@solidjs/router'
import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'
import { publishProject } from '~/lib/atproto/crud'
import { createProjectStore } from '~/lib/project-store'
import { createRecorder, requestMediaAccess } from '~/lib/recorder'
import { createPlayer, type Player } from './create-player'

const log = debug('editor', false)

// Debug interface for E2E tests
interface DebugInfo {
  player: Player
  getPlaybackStates: () => Array<{
    trackIndex: number
    state: string
    currentTime: number
    hasFrame: boolean
  }>
  downloadPreRender: () => void
}

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

  // Preview stream state
  const [previewPending, setPreviewPending] = createSignal(false)
  const [stopRecordingPending, setStopRecordingPending] = createSignal(false)

  const isSelectedTrack = createSelector(selectedTrackIndex)

  // Player signal - set after async initialization
  const [player, setPlayer] = createSignal<Player | null>(null)

  // Publish action using Solid's action/useSubmission
  const publishAction = action(async () => {
    const currentAgent = options.agent()
    if (!currentAgent) {
      throw new Error('Please sign in to publish')
    }

    // Collect clip blobs
    const clipBlobs = new Map<string, { blob: Blob; duration: number }>()
    for (const track of project.store.project.tracks) {
      for (const clip of track.clips) {
        const blob = project.getClipBlob(clip.id)
        const duration = project.getClipDuration(clip.id)
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

  const publishSubmission = useSubmission(publishAction)

  // Create player asynchronously
  createEffect(() => {
    const width = project.store.project.canvas.width
    const height = project.store.project.canvas.height

    createPlayer(width, height).then(p => {
      options.container.appendChild(p.canvas)

      // Expose debug info for E2E tests
      const debugInfo: DebugInfo = {
        player: p,
        getPlaybackStates: () => {
          const states = []
          for (let i = 0; i < 4; i++) {
            const slot = p.getSlot(i)
            if (slot.playback) {
              states.push({
                trackIndex: i,
                state: slot.playback.state,
                currentTime: p.time(),
                hasFrame: slot.playback.getFrameAt(p.time()) !== null,
              })
            }
          }
          return states
        },
        downloadPreRender: () => {
          const blob = p.preRenderer.blob()
          if (!blob) {
            console.log('No pre-rendered video available')
            return
          }
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'prerender.webm'
          link.click()
          URL.revokeObjectURL(url)
          console.log('Downloaded prerender.webm', { size: blob.size })
        },
      }
      ;(window as any).__EDDY_DEBUG__ = debugInfo

      setPlayer(p)

      onCleanup(() => {
        p.destroy()
        stopPreview()
        delete (window as any).__EDDY_DEBUG__
      })
    })
  })

  const [stream, setStream] = createSignal<MediaStream | null>(null)
  const [recorder, setRecorder] = createSignal<ReturnType<typeof createRecorder> | null>(null)

  // Load project if rkey provided
  createEffect((projectLoaded?: boolean) => {
    if (projectLoaded) return

    const currentAgent = options.agent()
    if (!currentAgent || !options.rkey) return

    project.loadProject(currentAgent, options.handle, options.rkey)
    return true
  })

  // Load clips into player when project store changes
  whenEffect(player, player => {
    const tracks = project.store.project.tracks
    log('effect: checking clips to load', { numTracks: tracks.length })

    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`
      const track = tracks.find(t => t.id === trackId)
      const clip = track?.clips[0]

      if (clip) {
        const blob = project.getClipBlob(clip.id)
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

  function setupPreviewStream(mediaStream: MediaStream, trackIndex: number) {
    setStream(mediaStream)
    player()?.setPreviewSource(trackIndex, mediaStream)
  }

  async function startPreview(trackIndex: number) {
    setPreviewPending(true)
    try {
      await resumeAudioContext()
      const result = await requestMediaAccess(true)
      if (result) {
        setupPreviewStream(result, trackIndex)
      }
    } finally {
      setPreviewPending(false)
    }
  }

  function stopPreview() {
    const track = selectedTrackIndex()
    if (track !== null) {
      player()?.setPreviewSource(track, null)
    }
    stream()?.getTracks().forEach(t => t.stop())
    setStream(null)
  }

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

  async function stopRecording(track: number) {
    log('stopRecording', { track })
    const _player = player()
    const _recorder = recorder()
    if (!_recorder) {
      throw new Error('Recording state but no recorder instance')
    }

    setStopRecordingPending(true)

    try {
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
          const playbacks = [0, 1, 2, 3].map(i => _player.getSlot(i).playback)
          _player.preRenderer.render(playbacks, _player.compositor)
        }, 500)
      }
    } finally {
      setStopRecordingPending(false)
    }
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
      !publishSubmission.pending &&
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
    previewPending,
    stopRecordingPending,
    hasAnyRecording,
    canPublish,

    // Pre-render state (from player)
    isPreRendering: () => player()?.preRenderer.isRendering() ?? false,
    preRenderProgress: () => player()?.preRenderer.progress() ?? 0,

    // Publish state (from submission)
    isPublishing: () => publishSubmission.pending,
    publishError: () => publishSubmission.error,

    // Loop state (from player clock)
    loopEnabled: () => player()?.loop() ?? false,

    // Actions
    async stop() {
      await player()?.stop()
    },

    async selectTrack(trackIndex: number) {
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
        await startPreview(trackIndex)
      }
    },

    async toggleRecording() {
      const trackIndex = selectedTrackIndex()
      if (trackIndex === null) return
      if (stopRecordingPending()) return

      if (isRecording()) {
        stopRecording(trackIndex)
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

    publish: publishAction,

    toggleLoop() {
      const _player = player()
      if (_player) {
        _player.setLoop(!_player.loop())
      }
    },
  }
}

export type Editor = ReturnType<typeof createEditor>
