import { compile, glsl, uniform } from '@bigmistqke/view.gl/tag'
import { debug } from '@klip/utils'

const log = debug('compositor', true)

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

function createVideoTexture(gl: WebGLRenderingContext | WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('Failed to create texture')

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  return texture
}

/** Video source - can be HTMLVideoElement or VideoFrame */
export type VideoSource = HTMLVideoElement | VideoFrame | null

export interface Compositor {
  canvas: HTMLCanvasElement
  /** Set a video source (HTMLVideoElement or VideoFrame) for a track */
  setSource: (index: number, source: VideoSource) => void
  /** @deprecated Use setSource instead */
  setVideo: (index: number, video: HTMLVideoElement | null) => void
  /** Set a VideoFrame for a track */
  setFrame: (index: number, frame: VideoFrame | null) => void
  render: () => void
  destroy: () => void
}

export function createCompositor(width: number, height: number): Compositor {
  log('createCompositor', { width, height })

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  if (!gl) throw new Error('WebGL not supported')

  log('WebGL context created', { version: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl' })

  const { view, program } = compile.toQuad(gl, fragmentShader)
  const textures = [
    createVideoTexture(gl),
    createVideoTexture(gl),
    createVideoTexture(gl),
    createVideoTexture(gl),
  ]

  const sources: VideoSource[] = [null, null, null, null]

  gl.useProgram(program)

  /** Check if a source is ready for rendering */
  const isSourceReady = (source: VideoSource): boolean => {
    if (!source) return false
    if (source instanceof VideoFrame) return true
    // HTMLVideoElement
    return source.readyState >= 2
  }

  /** Upload source to texture */
  const uploadSource = (source: VideoSource) => {
    if (!source) return

    if (source instanceof VideoFrame) {
      // VideoFrame can be used directly with texImage2D
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source
      )
    } else {
      // HTMLVideoElement
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source
      )
    }
  }

  return {
    canvas,

    setSource(index: number, source: VideoSource) {
      if (index >= 0 && index < 4) {
        sources[index] = source
      }
    },

    setVideo(index: number, video: HTMLVideoElement | null) {
      this.setSource(index, video)
    },

    setFrame(index: number, frame: VideoFrame | null) {
      this.setSource(index, frame)
    },

    render() {
      gl.useProgram(program)

      const active = [0, 0, 0, 0]

      // Update textures from sources
      for (let i = 0; i < 4; i++) {
        const source = sources[i]
        gl.activeTexture(gl.TEXTURE0 + i)
        gl.bindTexture(gl.TEXTURE_2D, textures[i])

        if (isSourceReady(source)) {
          uploadSource(source)
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
      textures.forEach((t) => gl.deleteTexture(t))
    },
  }
}
