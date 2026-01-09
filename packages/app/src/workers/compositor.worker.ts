import { expose, transfer, type Transferred } from '@bigmistqke/rpc/messenger'
import { compile, glsl, uniform } from '@bigmistqke/view.gl/tag'
import { debug } from '@eddy/utils'
import { getActiveSegments } from '~/lib/layout-resolver'
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
  connectPlaybackWorker(clipId: string, trackId: string, port: MessagePort): void

  /** Disconnect a playback worker */
  disconnectPlaybackWorker(clipId: string): void

  /** Render at time T (queries timeline internally) */
  render(time: number): void

  /** Set a frame on capture canvas (for pre-rendering, doesn't affect visible canvas) */
  setCaptureFrame(trackId: string, frame: Transferred<VideoFrame> | null): void

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

/** Get or create a texture for a trackId */
function getOrCreateTexture(
  glCtx: WebGL2RenderingContext | WebGLRenderingContext,
  textureMap: Map<string, WebGLTexture>,
  trackId: string,
): WebGLTexture {
  let texture = textureMap.get(trackId)
  if (!texture) {
    texture = createVideoTexture(glCtx)
    textureMap.set(trackId, texture)
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

// Frame sources - keyed by trackId
const previewFrames = new Map<string, VideoFrame>()
const playbackFrames = new Map<string, VideoFrame>()
const previewReaders = new Map<string, ReadableStreamDefaultReader<VideoFrame>>()

// Playback worker connections - keyed by clipId
const playbackWorkerPorts = new Map<string, MessagePort>()

// Mapping from clipId to trackId (for frame routing until layout refactor)
const clipToTrack = new Map<string, string>()

// Dynamic texture pool - keyed by trackId
const textures = new Map<string, WebGLTexture>()
const captureTextures = new Map<string, WebGLTexture>()

function setFrame(clipId: string, frame: VideoFrame | null) {
  // Look up trackId for this clip (fall back to clipId for backwards compatibility)
  const trackId = clipToTrack.get(clipId) ?? clipId

  // Close previous playback frame
  const prevFrame = playbackFrames.get(trackId)
  if (prevFrame) {
    prevFrame.close()
  }

  if (frame) {
    playbackFrames.set(trackId, frame)
  } else {
    playbackFrames.delete(trackId)
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
    canvas.width = width
    canvas.height = height

    gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) throw new Error('WebGL not supported in worker')

    log('WebGL context created', {
      version: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
    })

    // Compile shader for main canvas
    const compiled = compile.toQuad(gl, fragmentShader)
    view = compiled.view as CompositorView
    program = compiled.program

    gl.useProgram(program)

    // Capture canvas (for pre-rendering, not visible)
    captureCanvas = new OffscreenCanvas(width, height)
    captureGl = captureCanvas.getContext('webgl2') || captureCanvas.getContext('webgl')
    if (!captureGl) throw new Error('WebGL not supported for capture canvas')

    // Compile shader for capture canvas
    const captureCompiled = compile.toQuad(captureGl, fragmentShader)
    captureView = captureCompiled.view as CompositorView
    captureProgram = captureCompiled.program

    captureGl.useProgram(captureProgram)

    log('init complete (with capture canvas)')
  },

  setTimeline(newTimeline) {
    log('setTimeline', { duration: newTimeline.duration, slotCount: newTimeline.slots.length })
    timeline = newTimeline
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

  connectPlaybackWorker(clipId, trackId, port) {
    log('connectPlaybackWorker', { clipId, trackId })

    // Disconnect existing port for this clip
    const existingPort = playbackWorkerPorts.get(clipId)
    if (existingPort) {
      existingPort.close()
    }

    // Store the port and mapping
    playbackWorkerPorts.set(clipId, port)
    clipToTrack.set(clipId, trackId)

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

    // Get trackId before removing mapping
    const trackId = clipToTrack.get(clipId)
    clipToTrack.delete(clipId)

    // Close any remaining frame for this track
    if (trackId) {
      const frame = playbackFrames.get(trackId)
      if (frame) {
        frame.close()
        playbackFrames.delete(trackId)
      }
    }
  },

  render(time) {
    if (!gl || !canvas || !view || !program || !timeline) return

    gl.useProgram(program)

    // Clear entire canvas with dark background
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.1, 0.1, 0.1, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Query timeline for active segments at this time
    const activeSegments = getActiveSegments(timeline, time)

    // Draw playback frames for active segments
    for (const { segment } of activeSegments) {
      const trackId = segment.trackId
      const frame = playbackFrames.get(trackId)
      if (!frame) continue

      const texture = getOrCreateTexture(gl, textures, trackId)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

      // Convert viewport to WebGL coordinates (y flipped)
      const vp = viewportToWebGL(segment.viewport, canvas.height)
      gl.viewport(vp.x, vp.y, vp.width, vp.height)

      view.uniforms.u_video.set(0)
      view.attributes.a_quad.bind()
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // Draw preview frames on top (overlay layer) - use slot viewports
    // Preview can render even without clips (for recording)
    for (const slot of timeline.slots) {
      const frame = previewFrames.get(slot.trackId)
      if (!frame) continue

      const texture = getOrCreateTexture(gl, textures, slot.trackId)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

      // Use slot viewport (not segment viewport)
      const vp = viewportToWebGL(slot.viewport, canvas.height)
      gl.viewport(vp.x, vp.y, vp.width, vp.height)

      view.uniforms.u_video.set(0)
      view.attributes.a_quad.bind()
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  },

  // Set a frame on the capture canvas (for pre-rendering)
  setCaptureFrame(trackId, frame) {
    if (!captureGl) return

    const texture = getOrCreateTexture(captureGl, captureTextures, trackId)

    captureGl.activeTexture(captureGl.TEXTURE0)
    captureGl.bindTexture(captureGl.TEXTURE_2D, texture)

    if (frame) {
      captureGl.texImage2D(
        captureGl.TEXTURE_2D,
        0,
        captureGl.RGBA,
        captureGl.RGBA,
        captureGl.UNSIGNED_BYTE,
        frame,
      )
      frame.close() // Close after upload
    }
  },

  // Render to the capture canvas (for pre-rendering)
  renderToCaptureCanvas(time) {
    if (!captureGl || !captureCanvas || !captureView || !captureProgram || !timeline) return

    captureGl.useProgram(captureProgram)

    // Clear entire canvas with dark background
    captureGl.viewport(0, 0, captureCanvas.width, captureCanvas.height)
    captureGl.clearColor(0.1, 0.1, 0.1, 1.0)
    captureGl.clear(captureGl.COLOR_BUFFER_BIT)

    // Query timeline for active segments at this time
    const activeSegments = getActiveSegments(timeline, time)

    // Draw each active segment
    for (const { segment } of activeSegments) {
      const trackId = segment.trackId
      const texture = captureTextures.get(trackId)
      if (!texture) continue

      captureGl.activeTexture(captureGl.TEXTURE0)
      captureGl.bindTexture(captureGl.TEXTURE_2D, texture)

      // Convert viewport to WebGL coordinates (y flipped)
      const vp = viewportToWebGL(segment.viewport, captureCanvas.height)
      captureGl.viewport(vp.x, vp.y, vp.width, vp.height)

      captureView.uniforms.u_video.set(0)
      captureView.attributes.a_quad.bind()
      captureGl.drawArrays(captureGl.TRIANGLES, 0, 6)
    }
  },

  captureFrame(timestamp) {
    if (!captureCanvas) return null

    // Create VideoFrame from capture canvas (not visible canvas)
    try {
      const frame = new VideoFrame(captureCanvas, {
        timestamp, // microseconds
        alpha: 'discard',
      })
      // Transfer back to caller
      return transfer(frame) as unknown as VideoFrame
    } catch (e) {
      log('captureFrame: error', { error: e })
      return null
    }
  },

  destroy() {
    log('destroy')

    // Cancel all preview readers
    for (const reader of previewReaders.values()) {
      reader.cancel()
    }
    previewReaders.clear()

    // Close all preview frames
    for (const frame of previewFrames.values()) {
      frame.close()
    }
    previewFrames.clear()

    // Close all playback frames
    for (const frame of playbackFrames.values()) {
      frame.close()
    }
    playbackFrames.clear()

    // Close all playback worker ports
    for (const port of playbackWorkerPorts.values()) {
      port.close()
    }
    playbackWorkerPorts.clear()

    // Clean up main canvas WebGL resources
    if (gl) {
      for (const texture of textures.values()) {
        gl.deleteTexture(texture)
      }
      textures.clear()
    }

    // Clean up capture canvas WebGL resources
    if (captureGl) {
      for (const texture of captureTextures.values()) {
        captureGl.deleteTexture(texture)
      }
      captureTextures.clear()
    }

    canvas = null
    gl = null
    view = null
    program = null
    captureCanvas = null
    captureGl = null
    captureView = null
    captureProgram = null
    timeline = null
  },
})
