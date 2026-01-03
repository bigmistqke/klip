import clsx from "clsx";
import { FiTrash2 } from "solid-icons/fi";
import { type Component, Show } from "solid-js";
import styles from "./Track.module.css";

interface TrackProps {
  id: number;
  hasClip: boolean;
  isPlaying: boolean;
  isSelected: boolean;
  isRecording: boolean;
  isLoading: boolean;
  volume: number;
  pan: number;
  onSelect: () => void;
  onVolumeChange: (value: number) => void;
  onPanChange: (value: number) => void;
  onClear: () => void;
}

export const Track: Component<TrackProps> = (props) => {
  function getStatus() {
    if (props.isLoading) return "Loading...";
    if (props.isRecording) return "Recording";
    if (props.isSelected) return "Preview";
    if (props.isPlaying && props.hasClip) return "Playing";
    if (props.hasClip) return "Ready";
    return "Empty";
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
      onKeyDown={(event) => event.code === "Enter" && props.onSelect()}
    >
      <div class={styles.trackHeader}>
        <span class={styles.trackLabel}>Track {props.id + 1}</span>
        <span class={styles.status}>{getStatus()}</span>
      </div>

      <div class={styles.sliders}>
        <label class={styles.slider}>
          <span>Vol</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={props.volume}
            onInput={(e) => props.onVolumeChange(parseFloat(e.target.value))}
            onClick={(e) => e.stopPropagation()}
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
            onInput={(e) => props.onPanChange(parseFloat(e.target.value))}
            onClick={(e) => e.stopPropagation()}
          />
        </label>
      </div>

      <Show when={props.hasClip}>
        <div class={styles.controls}>
          <button
            type="button"
            class={styles.clearButton}
            onClick={(e) => {
              e.stopPropagation();
              props.onClear();
            }}
          >
            <FiTrash2 size={14} />
          </button>
        </div>
      </Show>
    </div>
  );
};
