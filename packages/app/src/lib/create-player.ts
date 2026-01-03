import { createDemuxer, type Demuxer } from "@klip/codecs";
import { createCompositor, type VideoSource } from "@klip/compositor";
import { createAudioPipeline, type AudioPipeline } from "@klip/mixer";
import { createPlayback, type Playback } from "@klip/playback";

export interface TrackSlot {
  playback: Playback | null;
  demuxer: Demuxer | null;
  audioPipeline: AudioPipeline;
}

export interface Player {
  /** The canvas element for rendering */
  readonly canvas: HTMLCanvasElement;

  /** Get track slot info */
  getSlot(trackIndex: number): TrackSlot;

  /** Check if a track has a clip loaded */
  hasClip(trackIndex: number): boolean;

  /** Load a clip from blob into a track */
  loadClip(trackIndex: number, blob: Blob): Promise<void>;

  /** Clear a clip from a track */
  clearClip(trackIndex: number): void;

  /** Set a video source for a track (for camera preview) */
  setPreviewSource(trackIndex: number, source: VideoSource | null): void;

  /** Start playback from time (affects all tracks with clips) */
  play(time?: number): Promise<void>;

  /** Pause playback */
  pause(): void;

  /** Stop and seek to beginning (shows first frames) */
  stop(): Promise<void>;

  /** Seek all tracks to time */
  seek(time: number): Promise<void>;

  /** Set volume for a track (0-1) */
  setVolume(trackIndex: number, value: number): void;

  /** Set pan for a track (-1 to 1) */
  setPan(trackIndex: number, value: number): void;

  /** Whether currently playing */
  readonly isPlaying: boolean;

  /** Current playback time */
  readonly currentTime: number;

  /** Clean up all resources */
  destroy(): void;
}

const NUM_TRACKS = 4;

/**
 * Create a player that manages compositor, playbacks, and audio pipelines
 */
export function createPlayer(width: number, height: number): Player {
  const compositor = createCompositor(width, height);

  // Create slots with audio pipelines (pipelines are created once, playbacks are per-clip)
  const slots: TrackSlot[] = Array.from({ length: NUM_TRACKS }, () => ({
    playback: null,
    demuxer: null,
    audioPipeline: createAudioPipeline(),
  }));

  let animationFrameId: number | null = null;
  let isPlaying = false;
  let currentTime = 0;

  // Render loop - polls frames from all playbacks
  function renderLoop() {
    // Update compositor with current frames from all playbacks
    for (let i = 0; i < NUM_TRACKS; i++) {
      const { playback } = slots[i];
      if (playback) {
        const frame = playback.getCurrentFrame();
        compositor.setFrame(i, frame);
      }
    }

    compositor.render();
    animationFrameId = requestAnimationFrame(renderLoop);
  }

  function startRenderLoop() {
    if (animationFrameId !== null) return;
    animationFrameId = requestAnimationFrame(renderLoop);
  }

  function stopRenderLoop() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  // Start render loop immediately
  startRenderLoop();

  return {
    get canvas() {
      return compositor.canvas;
    },

    get isPlaying() {
      return isPlaying;
    },

    get currentTime() {
      // Return time from first playing playback, or stored currentTime
      for (const slot of slots) {
        if (slot.playback?.state === "playing") {
          return slot.playback.currentTime;
        }
      }
      return currentTime;
    },

    getSlot(trackIndex: number): TrackSlot {
      return slots[trackIndex];
    },

    hasClip(trackIndex: number): boolean {
      return slots[trackIndex].playback !== null;
    },

    async loadClip(trackIndex: number, blob: Blob): Promise<void> {
      const slot = slots[trackIndex];

      // Clean up existing playback
      if (slot.playback) {
        slot.playback.destroy();
        slot.playback = null;
      }
      if (slot.demuxer) {
        slot.demuxer.destroy();
        slot.demuxer = null;
      }

      // Create new demuxer and playback
      const buffer = await blob.arrayBuffer();
      const demuxer = await createDemuxer(buffer);
      const playback = await createPlayback(demuxer, {
        audioDestination: slot.audioPipeline.gain,
      });

      slot.demuxer = demuxer;
      slot.playback = playback;

      // Seek to 0 to buffer first frame
      await playback.seek(0);
    },

    clearClip(trackIndex: number): void {
      const slot = slots[trackIndex];

      if (slot.playback) {
        slot.playback.destroy();
        slot.playback = null;
      }
      if (slot.demuxer) {
        slot.demuxer.destroy();
        slot.demuxer = null;
      }

      // Clear compositor source
      compositor.setFrame(trackIndex, null);
    },

    setPreviewSource(trackIndex: number, source: VideoSource | null): void {
      compositor.setSource(trackIndex, source);
    },

    async play(time?: number): Promise<void> {
      const startTime = time ?? currentTime;
      isPlaying = true;
      currentTime = startTime;

      // Start all playbacks
      const promises: Promise<void>[] = [];
      for (const slot of slots) {
        if (slot.playback) {
          promises.push(slot.playback.play(startTime));
        }
      }
      await Promise.all(promises);
    },

    pause(): void {
      isPlaying = false;

      // Update currentTime from first active playback
      for (const slot of slots) {
        if (slot.playback && slot.playback.state === "playing") {
          currentTime = slot.playback.currentTime;
          break;
        }
      }

      // Pause all playbacks
      for (const slot of slots) {
        if (slot.playback) {
          slot.playback.pause();
        }
      }
    },

    async stop(): Promise<void> {
      isPlaying = false;
      currentTime = 0;

      // Seek all playbacks to 0 (this keeps frames buffered for display)
      const promises: Promise<void>[] = [];
      for (const slot of slots) {
        if (slot.playback) {
          promises.push(slot.playback.seek(0));
        }
      }
      await Promise.all(promises);
    },

    async seek(time: number): Promise<void> {
      currentTime = time;

      // Seek all playbacks
      const promises: Promise<void>[] = [];
      for (const slot of slots) {
        if (slot.playback) {
          promises.push(slot.playback.seek(time));
        }
      }
      await Promise.all(promises);
    },

    setVolume(trackIndex: number, value: number): void {
      slots[trackIndex].audioPipeline.setVolume(value);
    },

    setPan(trackIndex: number, value: number): void {
      slots[trackIndex].audioPipeline.setPan(value);
    },

    destroy(): void {
      stopRenderLoop();

      for (let i = 0; i < NUM_TRACKS; i++) {
        const slot = slots[i];
        if (slot.playback) {
          slot.playback.destroy();
        }
        if (slot.demuxer) {
          slot.demuxer.destroy();
        }
        slot.audioPipeline.disconnect();
      }

      compositor.destroy();
    },
  };
}
