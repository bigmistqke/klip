/**
 * Compositor Worker
 *
 * Handles WebGL video compositing off the main thread using OffscreenCanvas.
 * Renders video tracks as individual quads in a grid layout.
 */

import { expose, transfer, type Transferred } from '@bigmistqke/rpc/messenger'
import { compile, glsl, uniform } from '@bigmistqke/view.gl/tag'
import { debug } from '@eddy/utils'

export interface CompositorWorkerMethods {
  /** Initialize with OffscreenCanvas */
  init(canvas: OffscreenCanvas, width: number, height: number): Promise<void>

  /** Set a preview stream for a track slot (continuously reads latest frame) */
  setPreviewStream(index: number, stream: ReadableStream<VideoFrame> | null): void

  /** Set a playback frame for a track slot (for time-synced playback) */
  setFrame(index: number, frame: Transferred<VideoFrame> | null): void

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

const log = debug('compositor-worker', false)

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

// View type with our specific uniforms
interface CompositorView {
  uniforms: {
    u_video: { set: (value: number) => void }
  }
  attributes: {
    a_quad: { bind: () => void }
  }
}

// Worker state - main canvas (visible)
let canvas: OffscreenCanvas | null = null
let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null
let view: CompositorView | null = null
let program: WebGLProgram | null = null
let textures: WebGLTexture[] = []

// Capture canvas state (for pre-rendering, not visible)
let captureCanvas: OffscreenCanvas | null = null
let captureGl: WebGL2RenderingContext | WebGLRenderingContext | null = null
let captureView: CompositorView | null = null
let captureProgram: WebGLProgram | null = null
let captureTextures: WebGLTexture[] = []

// Grid configuration
let gridCols = 2
let gridRows = 2

// Helper to calculate viewport for a grid cell
function getCellViewport(
  index: number,
  cols: number,
  rows: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const col = index % cols
  const row = Math.floor(index / cols)
  const cellWidth = canvasWidth / cols
  const cellHeight = canvasHeight / rows
  // Row 0 is top, but WebGL y=0 is bottom, so flip
  const y = (rows - 1 - row) * cellHeight
  return {
    x: col * cellWidth,
    y,
    width: cellWidth,
    height: cellHeight,
  }
}

// Frame sources - either from preview stream or playback
const previewFrames: (VideoFrame | null)[] = [null, null, null, null]
const playbackFrames: (VideoFrame | null)[] = [null, null, null, null]
const previewReaders: (ReadableStreamDefaultReader<VideoFrame> | null)[] = [null, null, null, null]

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

async function readPreviewStream(index: number, stream: ReadableStream<VideoFrame>) {
  log('readPreviewStream: starting', { index })
  const reader = stream.getReader()
  previewReaders[index] = reader

  try {
    while (true) {
      const { done, value: frame } = await reader.read()
      if (done) {
        log('readPreviewStream: stream done', { index })
        break
      }

      // Close previous frame and store new one
      if (previewFrames[index]) {
        previewFrames[index]!.close()
      }
      previewFrames[index] = frame
    }
  } catch (e) {
    log('readPreviewStream: error', { index, error: e })
  }

  previewReaders[index] = null
  log('readPreviewStream: ended', { index })
}

const methods: CompositorWorkerMethods = {
  async init(offscreenCanvas: OffscreenCanvas, width: number, height: number) {
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

    // Create textures for main canvas
    textures = [
      createVideoTexture(gl),
      createVideoTexture(gl),
      createVideoTexture(gl),
      createVideoTexture(gl),
    ]

    gl.useProgram(program)

    // Capture canvas (for pre-rendering, not visible)
    captureCanvas = new OffscreenCanvas(width, height)
    captureGl = captureCanvas.getContext('webgl2') || captureCanvas.getContext('webgl')
    if (!captureGl) throw new Error('WebGL not supported for capture canvas')

    // Compile shader for capture canvas
    const captureCompiled = compile.toQuad(captureGl, fragmentShader)
    captureView = captureCompiled.view as CompositorView
    captureProgram = captureCompiled.program

    // Create textures for capture canvas
    captureTextures = [
      createVideoTexture(captureGl),
      createVideoTexture(captureGl),
      createVideoTexture(captureGl),
      createVideoTexture(captureGl),
    ]

    captureGl.useProgram(captureProgram)

    log('init complete (with capture canvas)')
  },

  setPreviewStream(index: number, stream: ReadableStream<VideoFrame> | null) {
    log('setPreviewStream', { index, hasStream: !!stream })

    // Cancel existing reader
    if (previewReaders[index]) {
      previewReaders[index]!.cancel()
      previewReaders[index] = null
    }

    // Close existing preview frame
    if (previewFrames[index]) {
      previewFrames[index]!.close()
      previewFrames[index] = null
    }

    // Start reading new stream
    if (stream) {
      readPreviewStream(index, stream)
    }
  },

  setFrame(index: number, frame: VideoFrame | null) {
    // Close previous playback frame
    if (playbackFrames[index]) {
      playbackFrames[index]!.close()
    }
    playbackFrames[index] = frame
  },

  setGrid(cols: number, rows: number) {
    gridCols = cols
    gridRows = rows
  },

  render() {
    if (!gl || !canvas || !view || !program) return

    gl.useProgram(program)

    // Clear entire canvas with dark background
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.1, 0.1, 0.1, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // First pass: draw playback frames (background layer)
    for (let i = 0; i < 4; i++) {
      const frame = playbackFrames[i]
      if (!frame) continue

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, textures[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

      const vp = getCellViewport(i, gridCols, gridRows, canvas.width, canvas.height)
      gl.viewport(vp.x, vp.y, vp.width, vp.height)

      view.uniforms.u_video.set(0)
      view.attributes.a_quad.bind()
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // Second pass: draw preview frames on top (overlay layer)
    for (let i = 0; i < 4; i++) {
      const frame = previewFrames[i]
      if (!frame) continue

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, textures[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

      // Preview always uses 2x2 grid positioning
      const vp = getCellViewport(i, 2, 2, canvas.width, canvas.height)
      gl.viewport(vp.x, vp.y, vp.width, vp.height)

      view.uniforms.u_video.set(0)
      view.attributes.a_quad.bind()
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  },

  // Set a frame on the capture canvas (for pre-rendering)
  setCaptureFrame(index: number, frame: VideoFrame | null) {
    if (!captureGl || !captureTextures[index]) return

    captureGl.activeTexture(captureGl.TEXTURE0)
    captureGl.bindTexture(captureGl.TEXTURE_2D, captureTextures[index])

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
  renderCapture(activeSlots: [number, number, number, number]) {
    if (!captureGl || !captureCanvas || !captureView || !captureProgram) return

    captureGl.useProgram(captureProgram)

    // Clear entire canvas with dark background
    captureGl.viewport(0, 0, captureCanvas.width, captureCanvas.height)
    captureGl.clearColor(0.1, 0.1, 0.1, 1.0)
    captureGl.clear(captureGl.COLOR_BUFFER_BIT)

    // Draw each active track as a separate quad (always 2x2 for pre-render)
    for (let i = 0; i < 4; i++) {
      if (activeSlots[i] < 0.5) continue

      // Bind texture
      captureGl.activeTexture(captureGl.TEXTURE0)
      captureGl.bindTexture(captureGl.TEXTURE_2D, captureTextures[i])

      // Set viewport for this cell
      const vp = getCellViewport(i, 2, 2, captureCanvas.width, captureCanvas.height)
      captureGl.viewport(vp.x, vp.y, vp.width, vp.height)

      // Set uniforms and draw
      captureView.uniforms.u_video.set(0)
      captureView.attributes.a_quad.bind()
      captureGl.drawArrays(captureGl.TRIANGLES, 0, 6)
    }
  },

  captureFrame(timestamp: number): VideoFrame | null {
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
    for (let i = 0; i < 4; i++) {
      if (previewReaders[i]) {
        previewReaders[i]!.cancel()
        previewReaders[i] = null
      }
      if (previewFrames[i]) {
        previewFrames[i]!.close()
        previewFrames[i] = null
      }
      if (playbackFrames[i]) {
        playbackFrames[i]!.close()
        playbackFrames[i] = null
      }
    }

    // Clean up main canvas WebGL resources
    if (gl) {
      textures.forEach(t => gl!.deleteTexture(t))
      textures = []
    }

    // Clean up capture canvas WebGL resources
    if (captureGl) {
      captureTextures.forEach(t => captureGl!.deleteTexture(t))
      captureTextures = []
    }

    canvas = null
    gl = null
    view = null
    program = null
    captureCanvas = null
    captureGl = null
    captureView = null
    captureProgram = null
  },
}

expose(methods)
