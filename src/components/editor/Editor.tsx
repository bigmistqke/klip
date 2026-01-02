import { action, useAction, useSubmission } from "@solidjs/router";
import {
  FiCircle,
  FiPause,
  FiPlay,
  FiSquare,
  FiUpload,
  FiVolume2,
} from "solid-icons/fi";
import {
  type Component,
  createEffect,
  createSelector,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useAuth } from "~/lib/atproto/AuthContext";
import { publishProject } from "~/lib/atproto/records";
import { resumeAudioContext } from "~/lib/audio/context";
import { getMasterMixer } from "~/lib/audio/mixer";
import { createRecorder, requestMediaAccess } from "~/lib/audio/recorder";
import { ProjectContext } from "~/lib/project/context";
import { createProjectStore } from "~/lib/project/store";
import { type Compositor, createCompositor } from "~/lib/video/compositor";
import styles from "./Editor.module.css";
import { Track } from "./Track";

interface EditorProps {
  handle?: string;
  rkey?: string;
}

const TRACK_IDS = [0, 1, 2, 3] as const;

const startPreviewAction = action(async () => {
  await resumeAudioContext();
  return await requestMediaAccess(true);
});

const stopRecordingAction = action(
  async (recorderInstance: ReturnType<typeof createRecorder>) => {
    return await recorderInstance.stop();
  },
);

export const Editor: Component<EditorProps> = (props) => {
  const { agent } = useAuth();
  const project = createProjectStore();

  const [isPlaying, setIsPlaying] = createSignal(false);
  const [isRecording, setIsRecording] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);
  const [selectedTrack, setSelectedTrack] = createSignal<number | null>(null);
  const [currentTime, setCurrentTime] = createSignal<number | undefined>(
    undefined,
  );
  const [masterVolume, setMasterVolume] = createSignal(1);

  const startPreview$ = useAction(startPreviewAction);
  const stopRecording$ = useAction(stopRecordingAction);
  const previewSubmission = useSubmission(startPreviewAction);
  const stopRecordingSubmission = useSubmission(stopRecordingAction);

  // Load project if rkey provided (handle is optional - defaults to own DID)
  let projectLoaded = false;
  createEffect(() => {
    const currentAgent = agent();
    if (currentAgent && props.rkey && !projectLoaded) {
      projectLoaded = true;
      project.loadProject(currentAgent, props.handle, props.rkey);
    }
  });

  const isSelectedTrack = createSelector(selectedTrack);

  let compositorContainer: HTMLDivElement | undefined;
  let compositor: Compositor | null = null;
  let animationId: number | null = null;
  let previewVideo: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let recorder: ReturnType<typeof createRecorder> | null = null;

  onMount(() => {
    compositor = createCompositor(
      project.store.project.canvas.width,
      project.store.project.canvas.height,
    );
    compositor.canvas.className = styles.compositorCanvas;
    if (compositorContainer) {
      compositorContainer.appendChild(compositor.canvas);
    }
    startRenderLoop();
  });

  onCleanup(() => {
    stopRenderLoop();
    stopPreview();
    compositor?.destroy();
  });

  function startRenderLoop() {
    const loop = () => {
      compositor?.render();
      animationId = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopRenderLoop() {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function setupPreviewStream(mediaStream: MediaStream, trackIndex: number) {
    stream = mediaStream;
    previewVideo = document.createElement("video");
    previewVideo.srcObject = stream;
    previewVideo.muted = true;
    previewVideo.playsInline = true;
    previewVideo.play();
    compositor?.setVideo(trackIndex, previewVideo);
  }

  async function startPreview(trackIndex: number) {
    const result = await startPreview$();
    if (result) {
      setupPreviewStream(result, trackIndex);
    }
  }

  async function stopPreview() {
    if (previewVideo) {
      previewVideo.srcObject = null;
      previewVideo = null;
    }
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = null;
  }

  async function handleSelectTrack(trackIndex: number) {
    // If already selected, deselect
    if (isSelectedTrack(trackIndex)) {
      const prevTrack = selectedTrack();
      if (prevTrack !== null && !project.hasRecording(prevTrack)) {
        compositor?.setVideo(prevTrack, null);
      }
      stopPreview();
      setSelectedTrack(null);
      return;
    }

    // If recording, can't switch tracks
    if (isRecording()) return;

    // Clear previous preview if no recording there
    const prevTrack = selectedTrack();
    if (prevTrack !== null && !project.hasRecording(prevTrack)) {
      compositor?.setVideo(prevTrack, null);
    }
    stopPreview();

    // Start preview for new track (only if no recording exists)
    if (!project.hasRecording(trackIndex)) {
      setSelectedTrack(trackIndex);
      await startPreview(trackIndex);
    }
  }

  async function handleRecord() {
    const track = selectedTrack();
    if (track === null) return;

    if (isRecording()) {
      // Stop recording and playback
      if (!recorder) {
        throw new Error("Recording state but no recorder instance");
      }
      const result = await stopRecording$(recorder);
      if (result) {
        project.addRecording(track, result.blob, result.duration);
      }
      stopPreview();
      setIsRecording(false);
      setIsPlaying(false);
      setSelectedTrack(null);
    } else {
      // Start recording + play all existing clips from beginning
      if (!stream) {
        throw new Error("Cannot start recording without media stream");
      }
      recorder = createRecorder(stream);
      recorder.start();
      // Force seek by setting undefined first, then 0
      setCurrentTime(undefined);
      queueMicrotask(() => {
        setCurrentTime(0); // Reset all clips to start
        setIsRecording(true);
        setIsPlaying(true); // Play existing clips while recording
      });
    }
  }

  async function handlePlayPause() {
    // Stop preview when playing
    if (selectedTrack() !== null && !isRecording()) {
      const track = selectedTrack();
      if (track !== null && !project.hasRecording(track)) {
        compositor?.setVideo(track, null);
      }
      stopPreview();
      setSelectedTrack(null);
    }

    await resumeAudioContext();
    setCurrentTime(undefined);
    setIsPlaying(!isPlaying());
  }

  function handleStop() {
    setIsPlaying(false);
    setCurrentTime(0);
  }

  function handleVideoChange(index: number, video: HTMLVideoElement | null) {
    // Don't override preview video for selected track
    if (selectedTrack() === index && previewVideo) return;
    compositor?.setVideo(index, video);
  }

  function handleClearRecording(index: number) {
    project.clearTrack(index);
    compositor?.setVideo(index, null);
  }

  function handleMasterVolumeChange(e: Event) {
    const value = parseFloat((e.target as HTMLInputElement).value);
    setMasterVolume(value);
    getMasterMixer().setMasterVolume(value);
  }

  async function handlePublish() {
    const currentAgent = agent();
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
        clipBlobs,
      );
      alert(`Published! URI: ${result.uri}`);
    } catch (error) {
      console.error("Publish failed:", error);
      alert(`Publish failed: ${error}`);
    } finally {
      setIsPublishing(false);
    }
  }

  function hasAnyRecording() {
    for (let i = 0; i < 4; i++) {
      if (project.hasRecording(i)) return true;
    }
    return false;
  }

  return (
    <ProjectContext.Provider value={project}>
      <div class={styles.container}>
        <Show when={project.isLoading()}>
          <div class={styles.loadingOverlay}>Loading project...</div>
        </Show>
        <div class={styles.compositorContainer} ref={compositorContainer} />
        <div class={styles.transport}>
          <button
            type="button"
            class={styles.playButton}
            onClick={handlePlayPause}
            disabled={isRecording() || selectedTrack() !== null}
          >
            {isPlaying() ? <FiPause size={24} /> : <FiPlay size={24} />}
          </button>
          <button
            type="button"
            class={styles.recordButton}
            classList={{ [styles.recording]: isRecording() }}
            onClick={handleRecord}
            disabled={
              selectedTrack() === null ||
              previewSubmission.pending ||
              stopRecordingSubmission.pending
            }
          >
            {isRecording() ? <FiSquare size={20} /> : <FiCircle size={20} />}
          </button>
          <button
            type="button"
            class={styles.stopButton}
            onClick={handleStop}
            disabled={isRecording() || selectedTrack() !== null}
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
              value={masterVolume()}
              onInput={handleMasterVolumeChange}
            />
          </label>
          <button
            type="button"
            class={styles.publishButton}
            onClick={handlePublish}
            disabled={
              isRecording() ||
              isPlaying() ||
              isPublishing() ||
              !hasAnyRecording() ||
              !agent()
            }
          >
            <FiUpload size={16} />
            {isPublishing() ? "Publishing..." : "Publish"}
          </button>
        </div>
        <div class={styles.grid}>
          <For each={TRACK_IDS}>
            {(id) => (
              <Track
                id={id}
                isPlaying={isPlaying()}
                isSelected={selectedTrack() === id}
                isRecording={isRecording() && selectedTrack() === id}
                isLoading={previewSubmission.pending && selectedTrack() === id}
                currentTime={currentTime()}
                onSelect={() => handleSelectTrack(id)}
                onVideoChange={handleVideoChange}
                onClear={() => handleClearRecording(id)}
              />
            )}
          </For>
        </div>
      </div>
    </ProjectContext.Provider>
  );
};
