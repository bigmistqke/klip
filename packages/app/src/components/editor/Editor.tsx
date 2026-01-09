import { FiCircle, FiPause, FiPlay, FiRepeat, FiSquare, FiUpload, FiVolume2 } from 'solid-icons/fi'
import { type Component, createEffect, createMemo, createSignal, Index, onMount, Show } from 'solid-js'
import { createEditor } from '~/hooks/create-editor'
import { useAuth } from '~/lib/atproto/auth-context'
import styles from './Editor.module.css'
import { Track } from './Track'

interface EditorProps {
  handle?: string
  rkey?: string
}

export const Editor: Component<EditorProps> = props => {
  const { agent } = useAuth()

  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>()

  const editor = createEditor({
    agent,
    canvas,
    get handle() {
      return props.handle
    },
    get rkey() {
      return props.rkey
    },
  })

  // Expose editor for debugging and perf testing
  // Use createEffect to wait for player initialization (which creates __EDDY_DEBUG__)
  createEffect(() => {
    const _player = editor.player()
    if (_player) {
      const debug = (window as any).__EDDY_DEBUG__
      if (debug) {
        debug.editor = editor
      }
    }
  })

  // Derive layout from first group (MVP: single grid layout)
  const layout = createMemo(() => editor.project().groups[0]?.layout)

  // Helper to get track volume/pan from project store
  const getTrackVolume = (trackId: string) => {
    const pipeline = editor.getTrackPipeline(trackId)
    const gainIndex = pipeline.findIndex((e: { type: string }) => e.type === 'audio.gain')
    return gainIndex !== -1 ? editor.getEffectValue(trackId, gainIndex) : 1
  }

  const getTrackPan = (trackId: string) => {
    const pipeline = editor.getTrackPipeline(trackId)
    const panIndex = pipeline.findIndex((e: { type: string }) => e.type === 'audio.pan')
    // Convert 0-1 (store) to -1..1 (display)
    const value = panIndex !== -1 ? editor.getEffectValue(trackId, panIndex) : 0.5
    return (value - 0.5) * 2
  }

  return (
    <div class={styles.container}>
      <Show when={editor.isProjectLoading()}>
        <div class={styles.loadingOverlay}>Loading project...</div>
      </Show>
      <div class={styles.compositorContainer}>
        <canvas
          ref={element => onMount(() => setCanvas(element))}
          class={styles.compositorCanvas}
        />
      </div>
      <div class={styles.transport}>
        <button
          type="button"
          class={styles.playButton}
          data-playing={editor.player()?.isPlaying() ?? false}
          onClick={editor.playPause}
          disabled={editor.isRecording() || editor.selectedTrack() !== null}
        >
          {editor.player()?.isPlaying() ? <FiPause size={20} /> : <FiPlay size={20} />}
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
            editor.finalizingRecording()
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
        <button
          type="button"
          class={styles.loopButton}
          classList={{ [styles.active]: editor.loopEnabled() }}
          onClick={editor.toggleLoop}
          disabled={editor.isRecording()}
          title={editor.loopEnabled() ? 'Disable loop' : 'Enable loop'}
        >
          <FiRepeat size={20} />
        </button>
        <label class={styles.masterVolume}>
          <FiVolume2 size={16} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={editor.masterVolume()}
            onInput={e => editor.setMasterVolume(parseFloat(e.target.value))}
          />
        </label>
        <button
          type="button"
          class={styles.publishButton}
          onClick={editor.publish}
          disabled={
            editor.isRecording() ||
            (editor.player()?.isPlaying() ?? false) ||
            editor.isPublishing() ||
            !editor.hasAnyRecording() ||
            !agent()
          }
        >
          <FiUpload size={16} />
          {editor.isPublishing() ? 'Publishing...' : 'Publish'}
        </button>
      </div>
      <div
        class={styles.grid}
        style={{
          'grid-template-columns': `repeat(${layout()?.columns ?? 1}, 1fr)`,
          'grid-template-rows': `repeat(${layout()?.rows ?? 1}, 1fr)`,
        }}
      >
        <Index each={editor.project().tracks}>
          {(track, index) => (
            <Track
              trackId={track().id}
              displayIndex={index}
              hasClip={editor.player()?.hasClip(track().id) ?? false}
              isPlaying={editor.player()?.isPlaying() ?? false}
              isSelected={editor.isSelectedTrack(track().id)}
              isRecording={editor.isRecording() && editor.isSelectedTrack(track().id)}
              isLoading={editor.previewPending() && editor.isSelectedTrack(track().id)}
              volume={getTrackVolume(track().id)}
              pan={getTrackPan(track().id)}
              onSelect={() => editor.selectTrack(track().id)}
              onVolumeChange={value => editor.setTrackVolume(track().id, value)}
              onPanChange={value => editor.setTrackPan(track().id, value)}
              onClear={() => editor.clearRecording(track().id)}
              onDownload={() => editor.downloadClip(track().id)}
            />
          )}
        </Index>
      </div>
    </div>
  )
}
