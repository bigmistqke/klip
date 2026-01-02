import { describe, it, expect } from 'vitest'
import { createDemuxer } from '../demuxer'
import { createVideoDecoder } from '../video-decoder'
import { createPlayer } from '../player'

/**
 * Creates a canvas with animated content for recording
 */
function createAnimatedCanvas(width = 320, height = 240): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * Animates the canvas for a given duration
 */
function animateCanvas(
  canvas: HTMLCanvasElement,
  durationMs: number
): Promise<void> {
  return new Promise((resolve) => {
    const ctx = canvas.getContext('2d')!
    const startTime = performance.now()
    let frame = 0

    function draw() {
      const elapsed = performance.now() - startTime

      // Clear and draw animated content
      ctx.fillStyle = `hsl(${(frame * 10) % 360}, 70%, 50%)`
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Draw frame number for debugging
      ctx.fillStyle = 'white'
      ctx.font = '24px monospace'
      ctx.fillText(`Frame ${frame}`, 20, 40)

      frame++

      if (elapsed < durationMs) {
        requestAnimationFrame(draw)
      } else {
        resolve()
      }
    }

    draw()
  })
}

/**
 * Records a canvas stream using MediaRecorder
 */
async function recordCanvas(
  canvas: HTMLCanvasElement,
  durationMs: number
): Promise<Blob> {
  const stream = canvas.captureStream(30) // 30 FPS

  // Try VP9 first (what we're testing), fall back to VP8
  let mimeType = 'video/webm;codecs=vp9'
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm;codecs=vp8'
  }
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm'
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 1_000_000, // 1 Mbps
  })

  const chunks: Blob[] = []

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data)
    }
  }

  return new Promise((resolve, reject) => {
    recorder.onerror = (event) => {
      reject(new Error(`MediaRecorder error: ${event}`))
    }

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType })
      resolve(blob)
    }

    // Start recording
    recorder.start(100) // Collect data every 100ms

    // Animate the canvas during recording
    animateCanvas(canvas, durationMs).then(() => {
      recorder.stop()
    })
  })
}

describe('MediaRecorder Pipeline - Recording', () => {
  it('should record a canvas to WebM', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500) // 0.5 second recording

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
    expect(blob.type).toContain('video/webm')
  }, 10000)
})

describe('MediaRecorder Pipeline - Demuxing', () => {
  it('should demux MediaRecorder WebM output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)

    expect(demuxer.info.videoTracks.length).toBeGreaterThan(0)

    const videoTrack = demuxer.info.videoTracks[0]
    expect(videoTrack.width).toBe(320)
    expect(videoTrack.height).toBe(240)
    // MediaRecorder WebM may not have duration metadata (live recording)
    expect(videoTrack.duration).toBeGreaterThanOrEqual(0)

    demuxer.destroy()
  }, 15000)

  it('should get video decoder config from MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const config = await demuxer.getVideoConfig()

    expect(config.codec).toBeDefined()
    expect(config.codec.length).toBeGreaterThan(0)
    // Should be VP9 or VP8
    expect(config.codec).toMatch(/^vp(09|8)/)
    expect(config.codedWidth).toBe(320)
    expect(config.codedHeight).toBe(240)

    demuxer.destroy()
  }, 15000)

  it('should extract samples from MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const videoTrack = demuxer.info.videoTracks[0]

    const samples = await demuxer.getSamples(videoTrack.id, 0, 1)

    expect(samples.length).toBeGreaterThan(0)

    // First sample should be a keyframe
    const firstSample = samples[0]
    expect(firstSample.isKeyframe).toBe(true)
    expect(firstSample.data.byteLength).toBeGreaterThan(0)

    demuxer.destroy()
  }, 15000)
})

describe('MediaRecorder Pipeline - Decoding', () => {
  it('should decode frames from MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const videoTrack = demuxer.info.videoTracks[0]
    const decoder = await createVideoDecoder(demuxer, videoTrack)

    // Get samples
    const samples = await demuxer.getSamples(videoTrack.id, 0, 0.5)
    expect(samples.length).toBeGreaterThan(0)

    // Decode first keyframe
    const keyframe = samples.find((s) => s.isKeyframe)
    expect(keyframe).toBeDefined()

    const frame = await decoder.decode(keyframe!)

    expect(frame).toBeInstanceOf(VideoFrame)
    expect(frame.displayWidth).toBe(320)
    expect(frame.displayHeight).toBe(240)

    frame.close()
    decoder.close()
    demuxer.destroy()
  }, 15000)

  it('should decode multiple frames from MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const videoTrack = demuxer.info.videoTracks[0]
    const decoder = await createVideoDecoder(demuxer, videoTrack)

    // Get samples
    const samples = await demuxer.getSamples(videoTrack.id, 0, 0.5)
    expect(samples.length).toBeGreaterThan(0)

    // Decode all samples
    const frames = await decoder.decodeAll(samples)

    expect(frames.length).toBeGreaterThan(0)

    for (const frame of frames) {
      expect(frame).toBeInstanceOf(VideoFrame)
      frame.close()
    }

    decoder.close()
    demuxer.destroy()
  }, 15000)
})

describe('MediaRecorder Pipeline - Full Player', () => {
  it('should create player from MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const player = await createPlayer(demuxer)

    expect(player).toBeDefined()
    expect(player.state).toBe('ready')
    // MediaRecorder WebM may not have duration metadata
    expect(player.duration).toBeGreaterThanOrEqual(0)

    player.destroy()
    demuxer.destroy()
  }, 15000)

  it('should seek and get frame from MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const player = await createPlayer(demuxer)

    await player.seek(0)

    const frame = player.getCurrentFrame()
    expect(frame).toBeInstanceOf(VideoFrame)

    player.destroy()
    demuxer.destroy()
  }, 15000)

  it('should play MediaRecorder output', async () => {
    const canvas = createAnimatedCanvas()
    const blob = await recordCanvas(canvas, 500)
    const buffer = await blob.arrayBuffer()

    const demuxer = await createDemuxer(buffer)
    const player = await createPlayer(demuxer)

    let frameCount = 0
    const unsubscribe = player.onFrame(() => {
      frameCount++
    })

    await player.play()

    // Let it play for a bit
    await new Promise((resolve) => setTimeout(resolve, 200))

    player.pause()
    unsubscribe()

    expect(frameCount).toBeGreaterThan(0)

    player.destroy()
    demuxer.destroy()
  }, 15000)
})
