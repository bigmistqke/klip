import clsx from "clsx";
import { FiTrash2 } from "solid-icons/fi";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { type AudioPipeline, createAudioPipeline } from "~/lib/audio/pipeline";
import type { AudioEffect } from "~/lib/lexicons";
import { useProject } from "~/lib/project/context";
import styles from "./Track.module.css";

interface TrackProps {
  id: number;
  isPlaying?: boolean;
  isSelected?: boolean;
  isRecording?: boolean;
  isLoading?: boolean;
  currentTime?: number;
  onSelect?: () => void;
  onVideoChange?: (index: number, video: HTMLVideoElement | null) => void;
  onClear?: () => void;
}

export const Track: Component<TrackProps> = (props) => {
  const project = useProject();
  const trackId = `track-${props.id}`;

  const [playbackEl, setPlaybackEl] = createSignal<HTMLVideoElement | null>(
    null,
  );

  let pipeline: AudioPipeline | null = null;

  // Derived state from project store
  const hasRecording = createMemo(() => project.hasRecording(props.id));
  const track = createMemo(() =>
    project.store.project.tracks.find((t) => t.id === trackId),
  );
  const firstClip = createMemo(() => track()?.clips[0]);
  const clipBlob = createMemo(() => {
    const clip = firstClip();
    return clip ? project.getClipBlob(clip.id) : undefined;
  });
  const audioPipeline = createMemo(() => project.getTrackPipeline(trackId));

  // Helper to get effect value by index
  const getEffectValue = (index: number) =>
    project.getEffectValue(trackId, index);

  onMount(() => {
    pipeline = createAudioPipeline();
    // Initialize pipeline with store values
    const effects = audioPipeline();
    effects.forEach((effect, i) => {
      applyEffectToAudioPipeline(effect.type, getEffectValue(i));
    });
  });

  // Apply effect value to the Web Audio pipeline
  function applyEffectToAudioPipeline(effectType: string, value: number) {
    if (!pipeline) return;
    switch (effectType) {
      case "audio.gain":
        pipeline.setVolume(value);
        break;
      case "audio.pan":
        // Convert 0-1 (lexicon) to -1..1 (Web Audio)
        pipeline.setPan((value - 0.5) * 2);
        break;
    }
  }

  onCleanup(() => {
    pipeline?.disconnect();
    props.onVideoChange?.(props.id, null);
  });

  // React to global play/pause and seek
  createEffect(() => {
    const el = playbackEl();
    if (!el || !hasRecording()) return;

    // Seek if currentTime is specified
    if (props.currentTime !== undefined) {
      el.currentTime = props.currentTime;
    }

    if (props.isPlaying) {
      el.play().catch(() => {
        // Ignore AbortError when play is interrupted by pause
      });
    } else {
      el.pause();
    }
  });

  function handleClear() {
    const el = playbackEl();
    if (el) {
      el.pause();
      el.src = "";
    }
    setPlaybackEl(null);
    pipeline?.disconnect();
    props.onClear?.();
  }

  // Generic effect change handler
  function handleEffectChange(
    effect: AudioEffect,
    index: number,
    value: number,
  ) {
    project.setEffectValue(trackId, index, value);
    applyEffectToAudioPipeline(effect.type, value);
  }

  function setupPlayback(el: HTMLVideoElement) {
    el.onloadeddata = () => {
      setPlaybackEl(el);
      if (pipeline) {
        pipeline.connect(el);
      }
      props.onVideoChange?.(props.id, el);
    };
  }

  const recordingUrl = createMemo(() => {
    const blob = clipBlob();
    return blob ? URL.createObjectURL(blob) : undefined;
  });

  function getStatus() {
    if (props.isLoading) return "Loading...";
    if (props.isRecording) return "Recording";
    if (props.isSelected) return "Preview";
    if (props.isPlaying && hasRecording()) return "Playing";
    if (hasRecording()) return "Ready";
    return "Empty";
  }

  // Get display value for an effect (handles pan conversion for UI)
  function getDisplayValue(effect: AudioEffect, index: number): number {
    const value = getEffectValue(index);
    // Pan uses -1..1 for display but 0..1 for storage
    if (effect.type === "audio.pan") {
      return (value - 0.5) * 2;
    }
    return value;
  }

  // Convert display value back for storage
  function parseDisplayValue(
    effect: AudioEffect,
    displayValue: number,
  ): number {
    if (effect.type === "audio.pan") {
      return (displayValue + 1) / 2;
    }
    return displayValue;
  }

  // Get slider config for each effect type
  function getSliderConfig(effect: AudioEffect) {
    switch (effect.type) {
      case "audio.gain":
        return { min: 0, max: 1, step: 0.01, label: "Vol" };
      case "audio.pan":
        return { min: -1, max: 1, step: 0.01, label: "Pan" };
      default:
        return { min: 0, max: 1, step: 0.01, label: "Custom" };
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      class={clsx(
        styles.track,
        props.isSelected && styles.selected,
        props.isRecording && styles.recording,
        hasRecording() && styles.hasRecording,
      )}
      onClick={props.onSelect}
      onKeyDown={(event) => event.code === "Enter" && props.onSelect?.()}
    >
      <div class={styles.trackHeader}>
        <span class={styles.trackLabel}>Track {props.id + 1}</span>
        <span class={styles.status}>{getStatus()}</span>
      </div>

      {/* Hidden video element for playback */}
      <Show when={hasRecording() && recordingUrl()}>
        {(url) => (
          <video
            ref={setupPlayback}
            src={url()}
            class={styles.hiddenVideo}
            playsinline
          >
            <track kind="captions"></track>
          </video>
        )}
      </Show>

      <div class={styles.sliders}>
        <For each={audioPipeline()}>
          {(effect, index) => {
            const config = getSliderConfig(effect);
            return (
              <label class={styles.slider}>
                <span>{config.label}</span>
                <input
                  type="range"
                  min={config.min}
                  max={config.max}
                  step={config.step}
                  value={getDisplayValue(effect, index())}
                  onInput={(e) => {
                    const displayValue = parseFloat(
                      (e.target as HTMLInputElement).value,
                    );
                    const storeValue = parseDisplayValue(effect, displayValue);
                    handleEffectChange(effect, index(), storeValue);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </label>
            );
          }}
        </For>
      </div>

      <Show when={hasRecording()}>
        <div class={styles.controls}>
          <button
            type="button"
            class={styles.clearButton}
            onClick={(e) => {
              e.stopPropagation();
              handleClear();
            }}
          >
            <FiTrash2 size={14} />
          </button>
        </div>
      </Show>
    </div>
  );
};
