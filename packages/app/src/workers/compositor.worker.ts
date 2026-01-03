/**
 * Compositor Worker
 *
 * Handles WebGL video compositing off the main thread using OffscreenCanvas.
 * Renders a 2x2 grid of video tracks.
 */

import { expose, transfer } from '@bigmistqke/rpc/messenger'
import { compile, glsl, uniform } from '@bigmistqke/view.gl/tag'
import { debug } from '@eddy/utils'
import type { CompositorWorkerMethods } from './types'

const log = debug('compositor-worker', false)

// Configurable grid shader - supports 1x1 (bypass) up to 2x2 layouts
const fragmentShader = glsl`
  precision mediump float;

  ${uniform.sampler2D('u_video0')}
  ${uniform.sampler2D('u_video1')}
  ${uniform.sampler2D('u_video2')}
  ${uniform.sampler2D('u_video3')}
  ${uniform.vec4('u_active')}
  ${uniform.vec2('u_grid')} // (cols, rows)

  varying vec2 v_uv;

  void main() {
    vec2 coord = v_uv * 0.5 + 0.5;

    float cols = u_grid.x;
    float rows = u_grid.y;

    // Calculate which cell we're in (row 0 = top, col 0 = left)
    float colF = min(floor(coord.x * cols), cols - 1.0);
    float rowF = min(floor((1.0 - coord.y) * rows), rows - 1.0);

    int col = int(colF);
    int row = int(rowF);
    int cellIndex = row * int(cols) + col;

    // Calculate local UV within cell
    // Row starts at y = (rows - 1 - rowF) / rows
    float rowStartY = (rows - 1.0 - rowF) / rows;
    float cellX = coord.x * cols - colF;
    float cellY = (coord.y - rowStartY) * rows;

    // Flip Y for video texture sampling
    vec2 localUv = vec2(cellX, 1.0 - cellY);

    vec4 color = vec4(0.1, 0.1, 0.1, 1.0);

    if (cellIndex == 0 && u_active.x > 0.5) {
      color = texture2D(u_video0, localUv);
    } else if (cellIndex == 1 && u_active.y > 0.5) {
      color = texture2D(u_video1, localUv);
    } else if (cellIndex == 2 && u_active.z > 0.5) {
      color = texture2D(u_video2, localUv);
    } else if (cellIndex == 3 && u_active.w > 0.5) {
      color = texture2D(u_video3, localUv);
    }

    gl_FragColor = color;
  }
`

// View type with our specific uniforms
interface CompositorView {
  uniforms: {
    u_video0: { set: (value: number) => void }
    u_video1: { set: (value: number) => void }
    u_video2: { set: (value: number) => void }
    u_video3: { set: (value: number) => void }
    u_active: { set: (x: number, y: number, z: number, w: number) => void }
    u_grid: { set: (cols: number, rows: number) => void }
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

// Grid configuration (1x1 = bypass, 2x2 = normal grid)
let gridCols = 2
let gridRows = 2

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
    gl.viewport(0, 0, canvas.width, canvas.height)

    const active = [0, 0, 0, 0]

    // Update textures from frames (prefer playback over preview)
    for (let i = 0; i < 4; i++) {
      const frame = playbackFrames[i] || previewFrames[i]

      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, textures[i])

      if (frame) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
        active[i] = 1
      }
    }

    // Set uniforms
    view.uniforms.u_video0.set(0)
    view.uniforms.u_video1.set(1)
    view.uniforms.u_video2.set(2)
    view.uniforms.u_video3.set(3)
    view.uniforms.u_active.set(active[0], active[1], active[2], active[3])
    view.uniforms.u_grid.set(gridCols, gridRows)

    // Bind quad attribute
    view.attributes.a_quad.bind()

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  },

  // Set a frame on the capture canvas (for pre-rendering)
  setCaptureFrame(index: number, frame: VideoFrame | null) {
    if (!captureGl || !captureTextures[index]) return

    captureGl.activeTexture(captureGl.TEXTURE0 + index)
    captureGl.bindTexture(captureGl.TEXTURE_2D, captureTextures[index])

    if (frame) {
      captureGl.texImage2D(captureGl.TEXTURE_2D, 0, captureGl.RGBA, captureGl.RGBA, captureGl.UNSIGNED_BYTE, frame)
      frame.close() // Close after upload
    }
  },

  // Render to the capture canvas (for pre-rendering)
  renderCapture(activeSlots: [number, number, number, number]) {
    if (!captureGl || !captureCanvas || !captureView || !captureProgram) return

    captureGl.useProgram(captureProgram)
    captureGl.viewport(0, 0, captureCanvas.width, captureCanvas.height)

    // Set uniforms
    captureView.uniforms.u_video0.set(0)
    captureView.uniforms.u_video1.set(1)
    captureView.uniforms.u_video2.set(2)
    captureView.uniforms.u_video3.set(3)
    captureView.uniforms.u_active.set(activeSlots[0], activeSlots[1], activeSlots[2], activeSlots[3])
    captureView.uniforms.u_grid.set(2, 2) // Always 2x2 for pre-render

    // Bind quad attribute
    captureView.attributes.a_quad.bind()

    // Draw
    captureGl.drawArrays(captureGl.TRIANGLES, 0, 6)
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
