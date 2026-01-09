import { expose, transfer, type Transferred } from '@bigmistqke/rpc/messenger'
import { compile, glsl, uniform } from '@bigmistqke/view.gl/tag'
import { debug } from '@eddy/utils'
import { getActivePlacements } from '~/lib/timeline-compiler'
import type { LayoutTimeline, Viewport } from '~/lib/layout-types'

const log = debug('compositor-worker', false)

export interface CompositorWorkerMethods {
  /** Initialize with OffscreenCanvas */
  init(canvas: OffscreenCanvas, width: number, height: number): Promise<void>

  /** Set the compiled layout timeline */
  setTimeline(timeline: LayoutTimeline): void

  /** Set a preview stream for a track (continuously reads latest frame) */
  setPreviewStream(trackId: string, stream: ReadableStream<VideoFrame> | null): void

  /** Set a playback frame for a clip (for time-synced playback) */
  setFrame(clipId: string, frame: Transferred<VideoFrame> | null): void

  /** Connect a playback worker via MessagePort (for direct worker-to-worker frame transfer) */
  connectPlaybackWorker(clipId: string, port: MessagePort): void

  /** Disconnect a playback worker */
  disconnectPlaybackWorker(clipId: string): void

  /** Render at time T (queries timeline internally) */
  render(time: number): void

  /** Set a frame on capture canvas (for pre-rendering, doesn't affect visible canvas) */
  setCaptureFrame(clipId: string, frame: Transferred<VideoFrame> | null): void

  /** Render to capture canvas at time T */
  renderToCaptureCanvas(time: number): void

  /** Capture frame from capture canvas as VideoFrame */
  captureFrame(timestamp: number): VideoFrame | null

  /** Clean up resources */
  destroy(): void
}

// View type with our specific uniforms
interface CompositorView {
  uniforms: {
    u_video: { set(value: number): void }
  }
  attributes: {
    a_quad: { bind(): void }
  }
}

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

function createVideoTexture(glCtx: WebGL2RenderingContext | WebGLRenderingContext): WebGLTexture {
  const texture = glCtx.createTexture()
  if (!texture) throw new Error('Failed to create texture')

  glCtx.bindTexture(glCtx.TEXTURE_2D, texture)
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE)
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE)
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.LINEAR)
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.LINEAR)

  return texture
}

/** Get or create a texture for a clipId */
function getOrCreateTexture(
  glCtx: WebGL2RenderingContext | WebGLRenderingContext,
  textureMap: Map<string, WebGLTexture>,
  clipId: string,
): WebGLTexture {
  let texture = textureMap.get(clipId)
  if (!texture) {
    texture = createVideoTexture(glCtx)
    textureMap.set(clipId, texture)
  }
  return texture
}

/** Convert viewport from layout coordinates (y=0 at top) to WebGL coordinates (y=0 at bottom) */
function viewportToWebGL(viewport: Viewport, canvasHeight: number): Viewport {
  return {
    x: viewport.x,
    y: canvasHeight - viewport.y - viewport.height,
    width: viewport.width,
    height: viewport.height,
  }
}

// Simple shader - samples a single texture per quad
const fragmentShader = glsl`
  precision mediump float;

  ${uniform.sampler2D('u_video')}

  varying vec2 v_uv;

  void main() {
    vec2 uv = v_uv * 0.5 + 0.5;
    uv.y = 1.0 - uv.y; // Flip Y for video
    gl_FragColor = texture2D(u_video, uv);
  }
`

/**********************************************************************************/
/*                                                                                */
/*                                     Methods                                    */
/*                                                                                */
/**********************************************************************************/

// Worker state - main canvas (visible)
let canvas: OffscreenCanvas | null = null
let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null
let view: CompositorView | null = null
let program: WebGLProgram | null = null

// Capture canvas state (for pre-rendering, not visible)
let captureCanvas: OffscreenCanvas | null = null
let captureGl: WebGL2RenderingContext | WebGLRenderingContext | null = null
let captureView: CompositorView | null = null
let captureProgram: WebGLProgram | null = null

// Current layout timeline
let timeline: LayoutTimeline | null = null

// Frame sources - keyed by clipId
const playbackFrames = new Map<string, VideoFrame>()

// Preview frames - keyed by trackId (for camera preview during recording)
const previewFrames = new Map<string, VideoFrame>()
const previewReaders = new Map<string, ReadableStreamDefaultReader<VideoFrame>>()

// Playback worker connections - keyed by clipId
const playbackWorkerPorts = new Map<string, MessagePort>()

// Dynamic texture pool - keyed by clipId
const textures = new Map<string, WebGLTexture>()
const captureTextures = new Map<string, WebGLTexture>()

function setFrame(clipId: string, frame: VideoFrame | null) {
  // Close previous playback frame
  const prevFrame = playbackFrames.get(clipId)
  if (prevFrame) {
    prevFrame.close()
  }

  if (frame) {
    playbackFrames.set(clipId, frame)
  } else {
    playbackFrames.delete(clipId)
  }
}

async function readPreviewStream(trackId: string, stream: ReadableStream<VideoFrame>) {
  log('readPreviewStream: starting', { trackId })
  const reader = stream.getReader()
  previewReaders.set(trackId, reader)

  try {
    while (true) {
      const { done, value: frame } = await reader.read()
      if (done) {
        log('readPreviewStream: stream done', { trackId })
        break
      }

      // Close previous frame and store new one
      const prevFrame = previewFrames.get(trackId)
      if (prevFrame) {
        prevFrame.close()
      }
      previewFrames.set(trackId, frame)
    }
  } catch (e) {
    log('readPreviewStream: error', { trackId, error: e })
  }

  previewReaders.delete(trackId)
  log('readPreviewStream: ended', { trackId })
}

expose<CompositorWorkerMethods>({
  setFrame,

  async init(offscreenCanvas, width, height) {
    log('init', { width, height })

    // Main canvas (visible)
    canvas = offscreenCanvas
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl')

    if (!gl) {
      throw new Error('WebGL not supported')
    }

    // Compile shader for main canvas
    const compiled = compile.toQuad(gl, fragmentShader)
    view = compiled.view as CompositorView
    program = compiled.program

    gl.useProgram(program)

    // Capture canvas (for pre-rendering, same size)
    captureCanvas = new OffscreenCanvas(width, height)
    captureGl = captureCanvas.getContext('webgl2') || captureCanvas.getContext('webgl')

    if (captureGl) {
      const captureCompiled = compile.toQuad(captureGl, fragmentShader)
      captureView = captureCompiled.view as CompositorView
      captureProgram = captureCompiled.program

      captureGl.useProgram(captureProgram)
    }
  },

  setTimeline(newTimeline) {
    timeline = newTimeline
    log('setTimeline', { duration: timeline.duration, segments: timeline.segments.length })
  },

  setPreviewStream(trackId, stream) {
    log('setPreviewStream', { trackId, hasStream: !!stream })

    // Cancel existing reader
    const existingReader = previewReaders.get(trackId)
    if (existingReader) {
      existingReader.cancel()
      previewReaders.delete(trackId)
    }

    // Close existing preview frame
    const existingFrame = previewFrames.get(trackId)
    if (existingFrame) {
      existingFrame.close()
      previewFrames.delete(trackId)
    }

    // Start reading new stream
    if (stream) {
      readPreviewStream(trackId, stream)
    }
  },

  connectPlaybackWorker(clipId, port) {
    log('connectPlaybackWorker', { clipId })

    // Disconnect existing port for this clip
    const existingPort = playbackWorkerPorts.get(clipId)
    if (existingPort) {
      existingPort.close()
    }

    // Store the port
    playbackWorkerPorts.set(clipId, port)

    // Expose setFrame method on this port for playback worker to call
    expose(
      {
        setFrame,
      },
      { to: port },
    )
  },

  disconnectPlaybackWorker(clipId) {
    log('disconnectPlaybackWorker', { clipId })

    const port = playbackWorkerPorts.get(clipId)
    if (port) {
      port.close()
      playbackWorkerPorts.delete(clipId)
    }

    // Close any remaining frame for this clip
    const frame = playbackFrames.get(clipId)
    if (frame) {
      frame.close()
      playbackFrames.delete(clipId)
    }
  },

  render(time) {
    if (!gl || !canvas || !view || !program || !timeline) return

    gl.useProgram(program)

    // Clear entire canvas with dark background
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.1, 0.1, 0.1, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Query timeline for active placements at this time
    const activePlacements = getActivePlacements(timeline, time)

    // Draw playback frames for active placements
    for (const { placement } of activePlacements) {
      const frame = playbackFrames.get(placement.clipId)
      if (!frame) continue

      const texture = getOrCreateTexture(gl, textures, placement.clipId)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

      // Convert viewport to WebGL coordinates (y flipped)
      const vp = viewportToWebGL(placement.viewport, canvas.height)
      gl.viewport(vp.x, vp.y, vp.width, vp.height)

      view.uniforms.u_video.set(0)
      view.attributes.a_quad.bind()
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // Draw preview frames on top (overlay layer)
    // Preview uses trackId since it's for camera preview during recording
    for (const [trackId, frame] of previewFrames) {
      // Find viewport for this track from active placements
      const placement = activePlacements.find(p => p.placement.trackId === trackId)
      if (!placement) continue

      const texture = getOrCreateTexture(gl, textures, `preview-${trackId}`)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

      const vp = viewportToWebGL(placement.placement.viewport, canvas.height)
      gl.viewport(vp.x, vp.y, vp.width, vp.height)

      view.uniforms.u_video.set(0)
      view.attributes.a_quad.bind()
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  },

  // Set a frame on the capture canvas (for pre-rendering)
  setCaptureFrame(clipId, frame) {
    if (!captureGl) return

    const texture = getOrCreateTexture(captureGl, captureTextures, clipId)

    captureGl.activeTexture(captureGl.TEXTURE0)
    captureGl.bindTexture(captureGl.TEXTURE_2D, texture)

    if (frame) {
      captureGl.texImage2D(captureGl.TEXTURE_2D, 0, captureGl.RGBA, captureGl.RGBA, captureGl.UNSIGNED_BYTE, frame)
      frame.close()
    }
  },

  renderToCaptureCanvas(time) {
    if (!captureGl || !captureCanvas || !captureView || !captureProgram || !timeline) return

    captureGl.useProgram(captureProgram)

    // Clear
    captureGl.viewport(0, 0, captureCanvas.width, captureCanvas.height)
    captureGl.clearColor(0.1, 0.1, 0.1, 1.0)
    captureGl.clear(captureGl.COLOR_BUFFER_BIT)

    // Query timeline for active placements
    const activePlacements = getActivePlacements(timeline, time)

    // Draw each active placement
    for (const { placement } of activePlacements) {
      const texture = captureTextures.get(placement.clipId)
      if (!texture) continue

      captureGl.activeTexture(captureGl.TEXTURE0)
      captureGl.bindTexture(captureGl.TEXTURE_2D, texture)

      const vp = viewportToWebGL(placement.viewport, captureCanvas.height)
      captureGl.viewport(vp.x, vp.y, vp.width, vp.height)

      captureView.uniforms.u_video.set(0)
      captureView.attributes.a_quad.bind()
      captureGl.drawArrays(captureGl.TRIANGLES, 0, 6)
    }
  },

  captureFrame(timestamp) {
    if (!captureCanvas) return null

    return new VideoFrame(captureCanvas, {
      timestamp,
      alpha: 'discard',
    })
  },

  destroy() {
    log('destroy')

    // Close all frames
    for (const frame of playbackFrames.values()) {
      frame.close()
    }
    playbackFrames.clear()

    for (const frame of previewFrames.values()) {
      frame.close()
    }
    previewFrames.clear()

    // Cancel all preview readers
    for (const reader of previewReaders.values()) {
      reader.cancel()
    }
    previewReaders.clear()

    // Close all ports
    for (const port of playbackWorkerPorts.values()) {
      port.close()
    }
    playbackWorkerPorts.clear()

    // Clear textures
    textures.clear()
    captureTextures.clear()
  },
})
