import { FiCircle, FiPause, FiPlay, FiSquare, FiUpload, FiVolume2 } from 'solid-icons/fi'
import { type Component, For, Show } from 'solid-js'
import { useAuth } from '~/lib/atproto/auth-context'
import { createEditor } from '~/lib/create-editor'
import styles from './Editor.module.css'
import { Track } from './Track'

interface EditorProps {
  handle?: string
  rkey?: string
}

const TRACK_IDS = [0, 1, 2, 3] as const

export const Editor: Component<EditorProps> = props => {
  const { agent } = useAuth()

  const container = (<div class={styles.compositorContainer} />) as HTMLDivElement

  const editor = createEditor({
    agent,
    container,
    get handle() {
      return props.handle
    },
    get rkey() {
      return props.rkey
    },
  })

  // Helper to get track volume/pan from project store
  const getTrackVolume = (id: number) => {
    const trackId = `track-${id}`
    const pipeline = editor.project.getTrackPipeline(trackId)
    const gainIndex = pipeline.findIndex(e => e.type === 'audio.gain')
    return gainIndex !== -1 ? editor.project.getEffectValue(trackId, gainIndex) : 1
  }

  const getTrackPan = (id: number) => {
    const trackId = `track-${id}`
    const pipeline = editor.project.getTrackPipeline(trackId)
    const panIndex = pipeline.findIndex(e => e.type === 'audio.pan')
    // Convert 0-1 (store) to -1..1 (display)
    const value = panIndex !== -1 ? editor.project.getEffectValue(trackId, panIndex) : 0.5
    return (value - 0.5) * 2
  }

  return (
    <div class={styles.container}>
      <Show when={editor.project.isLoading()}>
        <div class={styles.loadingOverlay}>Loading project...</div>
      </Show>
      {container}
      <div class={styles.transport}>
        <button
          type="button"
          class={styles.playButton}
          data-playing={editor.player().isPlaying}
          onClick={editor.playPause}
          disabled={editor.isRecording() || editor.selectedTrack() !== null}
        >
          {editor.player().isPlaying ? <FiPause size={24} /> : <FiPlay size={24} />}
        </button>
        <button
          type="button"
          class={styles.recordButton}
          classList={{ [styles.recording]: editor.isRecording() }}
          data-recording={editor.isRecording()}
          onClick={editor.toggleRecording}
          disabled={
            editor.selectedTrack() === null ||
            editor.previewPending() ||
            editor.stopRecordingPending()
          }
        >
          {editor.isRecording() ? <FiSquare size={20} /> : <FiCircle size={20} />}
        </button>
        <button
          type="button"
          class={styles.stopButton}
          onClick={editor.stop}
          disabled={editor.isRecording() || editor.selectedTrack() !== null}
        >
          <FiSquare size={20} />
        </button>
        <label class={styles.masterVolume}>
          <FiVolume2 size={16} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={editor.masterVolume()}
            onInput={e => editor.updateMasterVolume(parseFloat(e.target.value))}
          />
        </label>
        <button
          type="button"
          class={styles.publishButton}
          onClick={editor.publish}
          disabled={
            editor.isRecording() ||
            editor.player().isPlaying ||
            editor.isPublishing() ||
            !editor.hasAnyRecording() ||
            !agent()
          }
        >
          <FiUpload size={16} />
          {editor.isPublishing() ? 'Publishing...' : 'Publish'}
        </button>
      </div>
      <div class={styles.grid}>
        <For each={TRACK_IDS}>
          {id => (
            <Track
              id={id}
              hasClip={editor.player().hasClip(id)}
              isPlaying={editor.player().isPlaying}
              isSelected={editor.selectedTrack() === id}
              isRecording={editor.isRecording() && editor.selectedTrack() === id}
              isLoading={editor.previewPending() && editor.selectedTrack() === id}
              volume={getTrackVolume(id)}
              pan={getTrackPan(id)}
              onSelect={() => editor.selectTrack(id)}
              onVolumeChange={value => editor.setTrackVolume(id, value)}
              onPanChange={value => editor.setTrackPan(id, value)}
              onClear={() => editor.clearRecording(id)}
            />
          )}
        </For>
      </div>
    </div>
  )
}
