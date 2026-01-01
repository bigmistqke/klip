import { type Component, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { action, useAction, useSubmission } from '@solidjs/router'
import { requestMediaAccess, createRecorder, type RecordingResult } from '~/lib/audio/recorder'
import { createAudioPipeline, type AudioPipeline } from '~/lib/audio/pipeline'
import { resumeAudioContext } from '~/lib/audio/context'
import styles from './Track.module.css'

let stream: MediaStream | null = null
let recorder: ReturnType<typeof createRecorder> | null = null

const startRecording = action(async () => {
  stream = await requestMediaAccess(true)
  recorder = createRecorder(stream)
  recorder.start()
  return { started: true, stream }
})

const stopRecording = action(async () => {
  if (!recorder) throw new Error('No active recorder')
  const result = await recorder.stop()
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  return result
})

export const Track: Component = () => {
  const [isRecording, setIsRecording] = createSignal(false)
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [volume, setVolume] = createSignal(1)
  const [pan, setPan] = createSignal(0)

  let videoRef: HTMLVideoElement | undefined
  let playbackRef: HTMLVideoElement | undefined
  let pipeline: AudioPipeline | null = null

  const doStartRecording = useAction(startRecording)
  const doStopRecording = useAction(stopRecording)
  const startSubmission = useSubmission(startRecording)
  const stopSubmission = useSubmission(stopRecording)

  onMount(() => {
    pipeline = createAudioPipeline()
  })

  onCleanup(() => {
    stream?.getTracks().forEach((track) => track.stop())
    pipeline?.disconnect()
  })

  const handleRecord = async () => {
    if (isRecording()) {
      await doStopRecording()
      if (videoRef) videoRef.srcObject = null
      setIsRecording(false)
    } else {
      await resumeAudioContext()
      const result = await doStartRecording()
      if (result && videoRef && stream) {
        videoRef.srcObject = stream
        videoRef.play()
      }
      setIsRecording(true)
    }
  }

  const handlePlayPause = async () => {
    if (!playbackRef || !recording()) return
    await resumeAudioContext()

    if (isPlaying()) {
      playbackRef.pause()
      setIsPlaying(false)
    } else {
      playbackRef.play()
      setIsPlaying(true)
    }
  }

  const handleClear = () => {
    if (playbackRef) {
      playbackRef.pause()
      playbackRef.src = ''
    }
    pipeline?.disconnect()
    setIsPlaying(false)
    stopSubmission.clear()
    startSubmission.clear()
  }

  const handleVolumeChange = (e: Event) => {
    const value = parseFloat((e.target as HTMLInputElement).value)
    setVolume(value)
    pipeline?.setVolume(value)
  }

  const handlePanChange = (e: Event) => {
    const value = parseFloat((e.target as HTMLInputElement).value)
    setPan(value)
    pipeline?.setPan(value)
  }

  const setupPlayback = (el: HTMLVideoElement) => {
    playbackRef = el
    el.onended = () => setIsPlaying(false)
    el.onloadeddata = () => {
      if (pipeline) {
        pipeline.connect(el)
      }
    }
  }

  const recording = () => stopSubmission.result as RecordingResult | undefined
  const recordingUrl = () => {
    const rec = recording()
    return rec ? URL.createObjectURL(rec.blob) : undefined
  }
  const error = () => startSubmission.error || stopSubmission.error

  return (
    <div class={styles.track}>
      <div class={styles.preview}>
        <Show when={isRecording()}>
          <video ref={videoRef} class={styles.video} muted playsinline />
        </Show>
        <Show when={!isRecording() && recording()}>
          <video
            ref={setupPlayback}
            src={recordingUrl()}
            class={styles.video}
            playsinline
          />
        </Show>
        <Show when={!isRecording() && !recording()}>
          <span>No video</span>
        </Show>
      </div>

      <Show when={recording() && !isRecording()}>
        <div class={styles.sliders}>
          <label class={styles.slider}>
            <span>Vol</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume()}
              onInput={handleVolumeChange}
            />
          </label>
          <label class={styles.slider}>
            <span>Pan</span>
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={pan()}
              onInput={handlePanChange}
            />
          </label>
        </div>
      </Show>

      <div class={styles.controls}>
        <Show when={recording() && !isRecording()}>
          <button class={styles.playButton} onClick={handlePlayPause}>
            {isPlaying() ? 'Pause' : 'Play'}
          </button>
        </Show>
        <button
          class={styles.recordButton}
          classList={{ [styles.recording]: isRecording() }}
          onClick={handleRecord}
          disabled={startSubmission.pending || !!recording()}
        >
          {startSubmission.pending ? '...' : isRecording() ? 'Stop' : 'Record'}
        </button>
        <Show when={recording()}>
          <button class={styles.clearButton} onClick={handleClear}>
            Clear
          </button>
        </Show>
      </div>
      <Show when={error()}>
        <div class={styles.error}>{String(error())}</div>
      </Show>
    </div>
  )
}

