/**
 * Shared RPC type definitions for worker communication
 */

import type { Transferred } from '@bigmistqke/rpc/messenger'
import type { DemuxedSample, DemuxerInfo } from '@eddy/codecs'

// ============================================================================
// Demux Worker Types
// ============================================================================

export interface DemuxWorkerMethods {
  /** Initialize demuxer with file data */
  init(buffer: ArrayBuffer): Promise<DemuxerInfo>

  /** Get WebCodecs VideoDecoderConfig */
  getVideoConfig(): Promise<VideoDecoderConfig>

  /** Get WebCodecs AudioDecoderConfig */
  getAudioConfig(): Promise<AudioDecoderConfig>

  /** Get samples in time range */
  getSamples(trackId: number, startTime: number, endTime: number): Promise<DemuxedSample[]>

  /** Get all samples from track */
  getAllSamples(trackId: number): Promise<DemuxedSample[]>

  /** Find keyframe at or before time */
  getKeyframeBefore(trackId: number, time: number): Promise<DemuxedSample | null>

  /** Clean up resources */
  destroy(): void
}

// ============================================================================
// Recording Worker Types
// ============================================================================

export interface RecordingStartConfig {
  /** Video stream from MediaStreamTrackProcessor (use transfer()) */
  videoStream?: ReadableStream<VideoFrame>
  /** Audio stream from MediaStreamTrackProcessor (use transfer()) */
  audioStream?: ReadableStream<AudioData>
  /** Output video width */
  width: number
  /** Output video height */
  height: number
}

export interface RecordingResult {
  /** Encoded video/audio blob (WebM format) */
  blob: Blob
  /** Recording duration in milliseconds */
  duration: number
}

export interface RecordingWorkerMethods {
  /**
   * Start recording with video/audio streams.
   * Streams should be wrapped with transfer() for zero-copy transfer.
   */
  start(config: RecordingStartConfig): Promise<void>

  /**
   * Stop recording and get the result.
   * Returns encoded blob and duration.
   */
  stop(): Promise<RecordingResult>

  /**
   * Get first captured frame for preview.
   * Available shortly after recording starts.
   */
  getFirstFrame(): Promise<VideoFrame | null>
}

// ============================================================================
// Compositor Worker Types
// ============================================================================

export interface CompositorWorkerMethods {
  /** Initialize with OffscreenCanvas */
  init(canvas: OffscreenCanvas, width: number, height: number): Promise<void>

  /** Set a preview stream for a track slot (continuously reads latest frame) */
  setPreviewStream(index: number, stream: ReadableStream<VideoFrame> | null): void

  /** Set a playback frame for a track slot (for time-synced playback) */
  setFrame(index: number, frame: VideoFrame | null): void

  /** Set grid layout (1x1 = full-screen single video, 2x2 = quad view) */
  setGrid(cols: number, rows: number): void

  /** Render current state to visible canvas */
  render(): void

  /** Set a frame on capture canvas (for pre-rendering, doesn't affect visible canvas) */
  setCaptureFrame(index: number, frame: Transferred<VideoFrame> | null): void

  /** Render to capture canvas (for pre-rendering, doesn't affect visible canvas) */
  renderCapture(activeSlots: [number, number, number, number]): void

  /** Capture frame from capture canvas as VideoFrame */
  captureFrame(timestamp: number): VideoFrame | null

  /** Clean up resources */
  destroy(): void
}
