import type { Agent } from '@atproto/api'
import { getMasterMixer, resumeAudioContext } from '@eddy/mixer'
import { debug } from '@eddy/utils'
import {
  createEffect,
  createSelector,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'
import { publishProject } from '~/lib/atproto/crud'
import { createPlayer, type Player } from '~/lib/create-player'
import { createProjectStore } from '~/lib/project-store'
import { requestMediaAccess } from '~/lib/recorder'
import { createRecorderWorker, type WorkerRecorder } from '~/workers'

const log = debug('editor', false)

// Debug interface for E2E tests
export interface EditorDebugInfo {
  player: Player
  getPlaybackStates: () => Array<{
    trackIndex: number
    state: string
    currentTime: number
    hasFrame: boolean
  }>
}

declare global {
  interface Window {
    __KLIP_DEBUG__?: EditorDebugInfo
  }
}

export interface CreateEditorOptions {
  agent: Accessor<Agent | null>
  container: HTMLDivElement
  handle?: string
  rkey?: string
}

export function createEditor(options: CreateEditorOptions) {
  const project = createProjectStore()

  // Recording/UI state (playback state is managed by player)
  const [isRecording, setIsRecording] = createSignal(false)
  const [isPublishing, setIsPublishing] = createSignal(false)
  const [selectedTrackIndex, setSelectedTrack] = createSignal<number | null>(null)
  const [masterVolume, setMasterVolume] = createSignal(1)
  const [previewPending, setPreviewPending] = createSignal(false)
  const [stopRecordingPending, setStopRecordingPending] = createSignal(false)
  const [loopEnabled, setLoopEnabled] = createSignal(false)

  const isSelectedTrack = createSelector(selectedTrackIndex)

  // Player signal - set after async initialization
  const [player, setPlayer] = createSignal<Player | null>(null)

  // Create player asynchronously
  createEffect(() => {
    const width = project.store.project.canvas.width
    const height = project.store.project.canvas.height

    createPlayer(width, height).then(p => {
      options.container.appendChild(p.canvas)

      // Expose debug info for E2E tests
      window.__KLIP_DEBUG__ = {
        player: p,
        getPlaybackStates: () => {
          const states = []
          for (let i = 0; i < 4; i++) {
            const slot = p.getSlot(i)
            if (slot.playback) {
              states.push({
                trackIndex: i,
                state: slot.playback.state,
                currentTime: p.currentTime,
                hasFrame: slot.playback.getFrameAt(p.currentTime) !== null,
              })
            }
          }
          return states
        },
      }

      setPlayer(p)

      onCleanup(() => {
        p.destroy()
        stopPreview()
        delete window.__KLIP_DEBUG__
      })
    })
  })

  let stream: MediaStream | null = null
  let recorder: WorkerRecorder | null = null

  // Load project if rkey provided
  createEffect((projectLoaded?: boolean) => {
    if (projectLoaded) return

    const currentAgent = options.agent()
    if (!currentAgent || !options.rkey) return

    project.loadProject(currentAgent, options.handle, options.rkey)
    return true
  })

  // Load clips into player when project store changes
  createEffect(() => {
    const p = player()
    if (!p) return

    const tracks = project.store.project.tracks
    log('effect: checking clips to load', { numTracks: tracks.length })

    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`
      const track = tracks.find(t => t.id === trackId)
      const clip = track?.clips[0]

      if (clip) {
        const blob = project.getClipBlob(clip.id)
        if (blob && !p.hasClip(i)) {
          // Load clip into player
          log('effect: loading clip into player', { trackIndex: i, clipId: clip.id })
          p.loadClip(i, blob).catch(err => {
            console.error(`Failed to load clip for track ${i}:`, err)
          })
        }
      } else if (p.hasClip(i)) {
        // Clear clip from player
        log('effect: clearing clip from player', { trackIndex: i })
        p.clearClip(i)
      }
    }
  })

  // Initialize volume/pan from project store
  createEffect(() => {
    const p = player()
    if (!p) return

    const tracks = project.store.project.tracks

    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`
      const pipeline = project.getTrackPipeline(trackId)

      for (let j = 0; j < pipeline.length; j++) {
        const effect = pipeline[j]
        const value = project.getEffectValue(trackId, j)

        if (effect.type === 'audio.gain') {
          p.setVolume(i, value)
        } else if (effect.type === 'audio.pan') {
          // Convert 0-1 (lexicon) to -1..1 (Web Audio)
          p.setPan(i, (value - 0.5) * 2)
        }
      }
    }
  })

  function setupPreviewStream(mediaStream: MediaStream, trackIndex: number) {
    stream = mediaStream
    // Pass MediaStream directly to compositor worker
    player()?.setPreviewSource(trackIndex, stream)
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
    stream?.getTracks().forEach(t => t.stop())
    stream = null
  }

  async function startRecording() {
    log('startRecording')
    const p = player()
    if (!p) return

    // Start recording
    if (!stream) {
      throw new Error('Cannot start recording without media stream')
    }

    recorder = createRecorderWorker(stream)
    recorder.start()

    setIsRecording(true)

    // Start playback from 0 (plays all existing clips in sync)
    log('startRecording: calling player.play(0)')
    await p.play(0)
    log('startRecording complete')
  }

  async function stopRecording(track: number) {
    log('stopRecording', { track })
    const p = player()
    if (!recorder) {
      throw new Error('Recording state but no recorder instance')
    }

    setStopRecordingPending(true)

    try {
      log('stopRecording: waiting for recorder.stop()')
      const result = await recorder.stop()

      if (result) {
        log('stopRecording: got result', { blobSize: result.blob.size, duration: result.duration })
        result.firstFrame?.close() // We don't need it

        project.addRecording(track, result.blob, result.duration)
      }

      stopPreview()
      setIsRecording(false)
      setSelectedTrack(null)

      // Stop playback and show first frames of all clips
      log('stopRecording: calling player.stop()')
      await p?.stop()
      log('stopRecording complete')
    } finally {
      setStopRecordingPending(false)
    }
  }

  return {
    // Project store
    project,

    // Player (for reactive access to isPlaying, currentTime, hasClip)
    player,

    // State accessors
    isRecording,
    isPublishing,
    selectedTrack: selectedTrackIndex,
    masterVolume,
    isSelectedTrack,
    previewPending,
    stopRecordingPending,
    loopEnabled,

    // Actions
    async stop() {
      log('stop (editor)')
      await player()?.stop()
    },

    async selectTrack(trackIndex: number) {
      log('selectTrack', { trackIndex, currentlySelected: selectedTrackIndex() })
      const p = player()

      // If already selected, deselect
      if (isSelectedTrack(trackIndex)) {
        log('selectTrack: deselecting')
        stopPreview()
        setSelectedTrack(null)
        return
      }

      // If recording, can't switch tracks
      if (isRecording()) {
        log('selectTrack: blocked - currently recording')
        return
      }

      // Clear previous preview
      stopPreview()

      // Start preview for new track (only if no recording exists)
      if (p && !p.hasClip(trackIndex)) {
        log('selectTrack: starting preview', { trackIndex })
        setSelectedTrack(trackIndex)
        await startPreview(trackIndex)
      } else {
        log('selectTrack: blocked - track has clip or player not ready', { trackIndex })
      }
    },

    async toggleRecording() {
      const trackIndex = selectedTrackIndex()
      log('toggleRecording', {
        trackIndex,
        isRecording: isRecording(),
        stopRecordingPending: stopRecordingPending(),
      })
      if (trackIndex === null) return

      if (stopRecordingPending()) return

      // Stop recording
      if (isRecording()) {
        log('toggleRecording: stopping recording')
        stopRecording(trackIndex)
        return
      }

      log('toggleRecording: starting recording')
      startRecording()
    },

    async playPause() {
      const p = player()
      log('playPause', { isPlaying: p?.isPlaying, selectedTrack: selectedTrackIndex() })
      if (!p) return

      // Stop preview when playing
      if (selectedTrackIndex() !== null && !isRecording()) {
        log('playPause: stopping preview')
        stopPreview()
        setSelectedTrack(null)
      }

      await resumeAudioContext()

      if (p.isPlaying) {
        log('playPause: pausing')
        p.pause()
      } else {
        log('playPause: playing')
        await p.play()
      }
    },

    clearRecording(index: number) {
      project.clearTrack(index)
      player()?.clearClip(index)
    },

    setTrackVolume(index: number, value: number) {
      const trackId = `track-${index}`
      // Find the gain effect index
      const pipeline = project.getTrackPipeline(trackId)
      const gainIndex = pipeline.findIndex(e => e.type === 'audio.gain')
      if (gainIndex !== -1) {
        project.setEffectValue(trackId, gainIndex, value)
      }
      player()?.setVolume(index, value)
    },

    setTrackPan(index: number, value: number) {
      const trackId = `track-${index}`
      // Find the pan effect index, convert -1..1 to 0..1 for store
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

    async publish() {
      const currentAgent = options.agent()
      if (!currentAgent) {
        alert('Please sign in to publish')
        return
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
        alert('No recordings to publish')
        return
      }

      setIsPublishing(true)
      try {
        const result = await publishProject(currentAgent, project.store.project, clipBlobs)
        // Extract rkey from AT URI: at://did/collection/rkey
        const rkey = result.uri.split('/').pop()
        return rkey
      } catch (error) {
        console.error('Publish failed:', error)
        alert(`Publish failed: ${error}`)
      } finally {
        setIsPublishing(false)
      }
    },

    toggleLoop() {
      setLoopEnabled(loop => {
        const newValue = !loop
        const _player = player()
        if (_player) {
          _player.loop = newValue
        }
        log('toggleLoop', { loop: newValue })
        return newValue
      })
    },

    hasAnyRecording() {
      const p = player()
      if (!p) return false
      for (let i = 0; i < 4; i++) {
        if (p.hasClip(i)) return true
      }
      return false
    },
  }
}

export type Editor = ReturnType<typeof createEditor>
