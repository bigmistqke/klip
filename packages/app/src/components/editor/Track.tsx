import clsx from 'clsx'
import { FiDownload, FiTrash2 } from 'solid-icons/fi'
import type { Component } from 'solid-js'
import styles from './Track.module.css'

interface TrackProps {
  trackId: string
  displayIndex: number
  hasClip: boolean
  isPlaying: boolean
  isSelected: boolean
  isRecording: boolean
  isLoading: boolean
  volume: number
  pan: number
  onSelect: () => void
  onVolumeChange: (value: number) => void
  onPanChange: (value: number) => void
  onClear: () => void
  onDownload: () => void
}

export const Track: Component<TrackProps> = props => {
  function getStatus() {
    if (props.isLoading) return 'Loading...'
    if (props.isRecording) return 'Recording'
    if (props.isSelected) return 'Preview'
    if (props.isPlaying && props.hasClip) return 'Playing'
    if (props.hasClip) return 'Ready'
    return 'Empty'
  }

  return (
    <div
      role="button"
      tabIndex={0}
      class={clsx(
        styles.track,
        props.isSelected && styles.selected,
        props.isRecording && styles.recording,
        props.hasClip && styles.hasRecording,
      )}
      onClick={props.onSelect}
      onKeyDown={event => event.code === 'Enter' && props.onSelect()}
    >
      <div class={styles.trackHeader}>
        <span class={styles.trackLabel}>Track {props.displayIndex + 1}</span>
        <span class={styles.status}>{getStatus()}</span>
      </div>

      <div class={styles.body}>
        <div class={styles.sliders}>
          <label class={styles.slider}>
            <span>Vol</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={props.volume}
              onInput={e => props.onVolumeChange(parseFloat(e.target.value))}
              onClick={e => e.stopPropagation()}
            />
          </label>
          <label class={styles.slider}>
            <span>Pan</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={props.pan}
              onInput={e => props.onPanChange(parseFloat(e.target.value))}
              onClick={e => e.stopPropagation()}
            />
          </label>
        </div>

        <div class={styles.controls}>
          <button
            type="button"
            class={styles.downloadButton}
            classList={{ [styles.hidden]: !props.hasClip }}
            onClick={e => {
              e.stopPropagation()
              props.onDownload()
            }}
            title="Download clip"
          >
            <FiDownload size={14} />
          </button>
          <button
            type="button"
            class={styles.clearButton}
            classList={{ [styles.hidden]: !props.hasClip }}
            onClick={e => {
              e.stopPropagation()
              props.onClear()
            }}
            title="Clear clip"
          >
            <FiTrash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
