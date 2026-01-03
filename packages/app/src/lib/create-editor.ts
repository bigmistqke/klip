import type { Agent } from "@atproto/api";
import { getMasterMixer, resumeAudioContext } from "@klip/mixer";
import { debug } from "@klip/utils";
import { createEffect, createMemo, createSelector, createSignal, onCleanup, type Accessor } from "solid-js";
import { publishProject } from "~/lib/atproto/crud";
import { createPlayer, type Player } from "~/lib/create-player";
import { createProjectStore } from "~/lib/project-store";
import { createRecorder, requestMediaAccess } from "~/lib/recorder";

const log = debug("editor", true);

// Debug interface for E2E tests
export interface EditorDebugInfo {
  player: Player;
  getPlaybackStates: () => Array<{
    trackIndex: number;
    state: string;
    currentTime: number;
    hasFrame: boolean;
  }>;
}

declare global {
  interface Window {
    __KLIP_DEBUG__?: EditorDebugInfo;
  }
}

export interface CreateEditorOptions {
  agent: Accessor<Agent | null>;
  container: HTMLDivElement;
  handle?: string;
  rkey?: string;
}

export function createEditor(options: CreateEditorOptions) {
  const project = createProjectStore();

  // Recording/UI state (playback state is managed by player)
  const [isRecording, setIsRecording] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);
  const [selectedTrackIndex, setSelectedTrack] = createSignal<number | null>(null);
  const [masterVolume, setMasterVolume] = createSignal(1);
  const [previewPending, setPreviewPending] = createSignal(false);
  const [stopRecordingPending, setStopRecordingPending] = createSignal(false);

  const isSelectedTrack = createSelector(selectedTrackIndex);

  // Create player
  const player = createMemo(() => {
    const p = createPlayer(
      project.store.project.canvas.width,
      project.store.project.canvas.height
    );

    options.container.appendChild(p.canvas);

    // Expose debug info for E2E tests
    window.__KLIP_DEBUG__ = {
      player: p,
      getPlaybackStates: () => {
        const states = [];
        for (let i = 0; i < 4; i++) {
          const slot = p.getSlot(i);
          if (slot.playback) {
            states.push({
              trackIndex: i,
              state: slot.playback.state,
              currentTime: p.currentTime,
              hasFrame: slot.playback.getFrameAt(p.currentTime) !== null,
            });
          }
        }
        return states;
      },
    };

    onCleanup(() => {
      p.destroy();
      stopPreview();
      delete window.__KLIP_DEBUG__;
    });

    return p;
  });

  let previewVideo: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let recorder: ReturnType<typeof createRecorder> | null = null;

  // Load project if rkey provided
  createEffect((projectLoaded?: boolean) => {
    if (projectLoaded) return;

    const currentAgent = options.agent();
    if (!currentAgent || !options.rkey) return;

    project.loadProject(currentAgent, options.handle, options.rkey);
    return true;
  });

  // Load clips into player when project store changes
  createEffect(() => {
    const p = player();
    const tracks = project.store.project.tracks;
    log("effect: checking clips to load", { numTracks: tracks.length });

    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`;
      const track = tracks.find((t) => t.id === trackId);
      const clip = track?.clips[0];

      if (clip) {
        const blob = project.getClipBlob(clip.id);
        if (blob && !p.hasClip(i)) {
          // Load clip into player
          log("effect: loading clip into player", { trackIndex: i, clipId: clip.id });
          p.loadClip(i, blob).catch((err) => {
            console.error(`Failed to load clip for track ${i}:`, err);
          });
        }
      } else if (p.hasClip(i)) {
        // Clear clip from player
        log("effect: clearing clip from player", { trackIndex: i });
        p.clearClip(i);
      }
    }
  });

  // Initialize volume/pan from project store
  createEffect(() => {
    const p = player();
    const tracks = project.store.project.tracks;

    for (let i = 0; i < 4; i++) {
      const trackId = `track-${i}`;
      const pipeline = project.getTrackPipeline(trackId);

      for (let j = 0; j < pipeline.length; j++) {
        const effect = pipeline[j];
        const value = project.getEffectValue(trackId, j);

        if (effect.type === "audio.gain") {
          p.setVolume(i, value);
        } else if (effect.type === "audio.pan") {
          // Convert 0-1 (lexicon) to -1..1 (Web Audio)
          p.setPan(i, (value - 0.5) * 2);
        }
      }
    }
  });

  function setupPreviewStream(mediaStream: MediaStream, trackIndex: number) {
    stream = mediaStream;
    previewVideo = document.createElement("video");
    previewVideo.srcObject = stream;
    previewVideo.muted = true;
    previewVideo.playsInline = true;
    previewVideo.play();
    player().setPreviewSource(trackIndex, previewVideo);
  }

  async function startPreview(trackIndex: number) {
    setPreviewPending(true);
    try {
      await resumeAudioContext();
      const result = await requestMediaAccess(true);
      if (result) {
        setupPreviewStream(result, trackIndex);
      }
    } finally {
      setPreviewPending(false);
    }
  }

  function stopPreview() {
    const track = selectedTrackIndex();
    if (track !== null) {
      player().setPreviewSource(track, null);
    }
    if (previewVideo) {
      previewVideo.srcObject = null;
      previewVideo = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function startRecording() {
    log("startRecording");
    // Start recording
    if (!stream) {
      throw new Error("Cannot start recording without media stream");
    }

    recorder = createRecorder(stream);
    recorder.start();

    setIsRecording(true);

    // Start playback from 0 (plays all existing clips in sync)
    log("startRecording: calling player.play(0)");
    await player().play(0);
    log("startRecording complete");
  }

  async function stopRecording(track: number) {
    log("stopRecording", { track });
    if (!recorder) {
      throw new Error("Recording state but no recorder instance");
    }

    setStopRecordingPending(true);

    try {
      log("stopRecording: waiting for recorder.stop()");
      const result = await recorder.stop();

      if (result) {
        log("stopRecording: got result", { blobSize: result.blob.size, duration: result.duration });
        result.firstFrame?.close(); // We don't need it
        project.addRecording(track, result.blob, result.duration);
      }

      stopPreview();
      setIsRecording(false);
      setSelectedTrack(null);

      // Stop playback and show first frames of all clips
      log("stopRecording: calling player.stop()");
      await player().stop();
      log("stopRecording complete");
    } finally {
      setStopRecordingPending(false);
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

    // Actions
    async stop() {
      log("stop (editor)");
      await player().stop();
    },

    async selectTrack(trackIndex: number) {
      log("selectTrack", { trackIndex, currentlySelected: selectedTrackIndex() });
      // If already selected, deselect
      if (isSelectedTrack(trackIndex)) {
        log("selectTrack: deselecting");
        stopPreview();
        setSelectedTrack(null);
        return;
      }

      // If recording, can't switch tracks
      if (isRecording()) {
        log("selectTrack: blocked - currently recording");
        return;
      }

      // Clear previous preview
      stopPreview();

      // Start preview for new track (only if no recording exists)
      if (!player().hasClip(trackIndex)) {
        log("selectTrack: starting preview", { trackIndex });
        setSelectedTrack(trackIndex);
        await startPreview(trackIndex);
      } else {
        log("selectTrack: blocked - track has clip", { trackIndex });
      }
    },

    async toggleRecording() {
      const trackIndex = selectedTrackIndex();
      log("toggleRecording", { trackIndex, isRecording: isRecording(), stopRecordingPending: stopRecordingPending() });
      if (trackIndex === null) return;

      if (stopRecordingPending()) return;

      // Stop recording
      if (isRecording()) {
        log("toggleRecording: stopping recording");
        stopRecording(trackIndex)
        return;
      }

      log("toggleRecording: starting recording");
      startRecording()
    },

    async playPause() {
      log("playPause", { isPlaying: player().isPlaying, selectedTrack: selectedTrackIndex() });
      // Stop preview when playing
      if (selectedTrackIndex() !== null && !isRecording()) {
        log("playPause: stopping preview");
        stopPreview();
        setSelectedTrack(null);
      }

      await resumeAudioContext();

      if (player().isPlaying) {
        log("playPause: pausing");
        player().pause();
      } else {
        log("playPause: playing");
        await player().play();
      }
    },

    clearRecording(index: number) {
      project.clearTrack(index);
      player().clearClip(index);
    },

    setTrackVolume(index: number, value: number) {
      const trackId = `track-${index}`;
      // Find the gain effect index
      const pipeline = project.getTrackPipeline(trackId);
      const gainIndex = pipeline.findIndex((e) => e.type === "audio.gain");
      if (gainIndex !== -1) {
        project.setEffectValue(trackId, gainIndex, value);
      }
      player().setVolume(index, value);
    },

    setTrackPan(index: number, value: number) {
      const trackId = `track-${index}`;
      // Find the pan effect index, convert -1..1 to 0..1 for store
      const pipeline = project.getTrackPipeline(trackId);
      const panIndex = pipeline.findIndex((e) => e.type === "audio.pan");
      if (panIndex !== -1) {
        project.setEffectValue(trackId, panIndex, (value + 1) / 2);
      }
      player().setPan(index, value);
    },

    updateMasterVolume(value: number) {
      setMasterVolume(value);
      getMasterMixer().setMasterVolume(value);
    },

    async publish() {
      const currentAgent = options.agent();
      if (!currentAgent) {
        alert("Please sign in to publish");
        return;
      }

      // Collect clip blobs
      const clipBlobs = new Map<string, { blob: Blob; duration: number }>();
      for (const track of project.store.project.tracks) {
        for (const clip of track.clips) {
          const blob = project.getClipBlob(clip.id);
          const duration = project.getClipDuration(clip.id);
          if (blob && duration) {
            clipBlobs.set(clip.id, { blob, duration });
          }
        }
      }

      if (clipBlobs.size === 0) {
        alert("No recordings to publish");
        return;
      }

      setIsPublishing(true);
      try {
        const result = await publishProject(
          currentAgent,
          project.store.project,
          clipBlobs
        );
        // Extract rkey from AT URI: at://did/collection/rkey
        const rkey = result.uri.split("/").pop();
        return rkey;
      } catch (error) {
        console.error("Publish failed:", error);
        alert(`Publish failed: ${error}`);
      } finally {
        setIsPublishing(false);
      }
    },

    hasAnyRecording() {
      const p = player();
      for (let i = 0; i < 4; i++) {
        if (p.hasClip(i)) return true;
      }
      return false;
    },
  };
}

export type Editor = ReturnType<typeof createEditor>;
