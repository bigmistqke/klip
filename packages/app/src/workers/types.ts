/**
 * Shared RPC type definitions for worker communication
 */

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

export interface RecordingWorkerMethods {
  /** Start recording with video/audio streams */
  start(config: {
    videoStream?: ReadableStream<VideoFrame>
    audioStream?: ReadableStream<AudioData>
    width: number
    height: number
  }): Promise<void>

  /** Stop recording and get result */
  stop(): Promise<{
    blob: Blob
    duration: number
  }>

  /** Get first frame for preview (available during recording) */
  getFirstFrame(): Promise<VideoFrame | null>
}

// ============================================================================
// Compositor Worker Types
// ============================================================================

export interface CompositorWorkerMethods {
  /** Initialize with OffscreenCanvas */
  init(canvas: OffscreenCanvas, width: number, height: number): Promise<void>

  /** Set frame for a track slot */
  setFrame(index: number, frame: VideoFrame | null): void

  /** Render current state */
  render(): void

  /** Clean up resources */
  destroy(): void
}
