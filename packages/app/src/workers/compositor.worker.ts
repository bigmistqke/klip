/**
 * Compositor Worker
 *
 * Handles WebGL video compositing off the main thread using OffscreenCanvas.
 * Renders a 2x2 grid of video tracks.
 */

import { expose } from '@bigmistqke/rpc/messenger'
import { compile, glsl, uniform } from '@bigmistqke/view.gl/tag'
import { debug } from '@eddy/utils'
import type { CompositorWorkerMethods } from './types'

const log = debug('compositor-worker', true)

const fragmentShader = glsl`
  precision mediump float;

  ${uniform.sampler2D('u_video0')}
  ${uniform.sampler2D('u_video1')}
  ${uniform.sampler2D('u_video2')}
  ${uniform.sampler2D('u_video3')}
  ${uniform.vec4('u_active')}

  varying vec2 v_uv;

  void main() {
    vec2 coord = v_uv * 0.5 + 0.5;

    // Determine which quadrant we're in (2x2 grid)
    int quadrant = 0;
    vec2 localUv = coord;

    if (coord.x < 0.5 && coord.y >= 0.5) {
      // Top-left = track 0
      quadrant = 0;
      localUv = vec2(coord.x * 2.0, (coord.y - 0.5) * 2.0);
    } else if (coord.x >= 0.5 && coord.y >= 0.5) {
      // Top-right = track 1
      quadrant = 1;
      localUv = vec2((coord.x - 0.5) * 2.0, (coord.y - 0.5) * 2.0);
    } else if (coord.x < 0.5 && coord.y < 0.5) {
      // Bottom-left = track 2
      quadrant = 2;
      localUv = vec2(coord.x * 2.0, coord.y * 2.0);
    } else {
      // Bottom-right = track 3
      quadrant = 3;
      localUv = vec2((coord.x - 0.5) * 2.0, coord.y * 2.0);
    }

    // Flip Y for video texture
    localUv.y = 1.0 - localUv.y;

    vec4 color = vec4(0.1, 0.1, 0.1, 1.0);

    if (quadrant == 0 && u_active.x > 0.5) {
      color = texture2D(u_video0, localUv);
    } else if (quadrant == 1 && u_active.y > 0.5) {
      color = texture2D(u_video1, localUv);
    } else if (quadrant == 2 && u_active.z > 0.5) {
      color = texture2D(u_video2, localUv);
    } else if (quadrant == 3 && u_active.w > 0.5) {
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
  }
  attributes: {
    a_quad: { bind: () => void }
  }
}

// Worker state
let canvas: OffscreenCanvas | null = null
let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null
let view: CompositorView | null = null
let program: WebGLProgram | null = null
let textures: WebGLTexture[] = []

// Frame sources - either from preview stream or playback
const previewFrames: (VideoFrame | null)[] = [null, null, null, null]
const playbackFrames: (VideoFrame | null)[] = [null, null, null, null]
const previewReaders: (ReadableStreamDefaultReader<VideoFrame> | null)[] = [null, null, null, null]

function createVideoTexture(gl: WebGL2RenderingContext | WebGLRenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('Failed to create texture')

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

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

    canvas = offscreenCanvas
    canvas.width = width
    canvas.height = height

    gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) throw new Error('WebGL not supported in worker')

    log('WebGL context created', {
      version: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
    })

    const compiled = compile.toQuad(gl, fragmentShader)
    view = compiled.view as CompositorView
    program = compiled.program

    textures = [
      createVideoTexture(gl),
      createVideoTexture(gl),
      createVideoTexture(gl),
      createVideoTexture(gl),
    ]

    gl.useProgram(program)
    log('init complete')
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

  render() {
    if (!gl || !view || !program || !canvas) return

    gl.useProgram(program)

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

    // Bind quad attribute
    view.attributes.a_quad.bind()

    // Draw
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
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

    // Clean up WebGL resources
    if (gl) {
      textures.forEach(t => gl!.deleteTexture(t))
      textures = []
    }

    canvas = null
    gl = null
    view = null
    program = null
  },
}

expose(methods)
