import { debug } from '@eddy/utils'
import { getAudioContext } from './context'

const log = debug('mixer', false)

export interface MasterMixer {
  masterGain: GainNode
  getInputNode: () => AudioNode
  setMasterVolume: (value: number) => void
  getMasterVolume: () => number
  /**
   * Route audio through MediaStream → HTMLAudioElement instead of AudioContext.destination.
   * Use during recording to avoid Chrome bug where destination output interferes with getUserMedia.
   * See: https://groups.google.com/a/chromium.org/g/chromium-discuss/c/6s2EnqdBERE
   */
  useMediaStreamOutput: () => void
  /** Switch back to direct AudioContext.destination output */
  useDirectOutput: () => void
}

let mixer: MasterMixer | null = null

// Audio element for MediaStream output mode
let audioElement: HTMLAudioElement | null = null
let mediaStreamDest: MediaStreamAudioDestinationNode | null = null

export function getMasterMixer(): MasterMixer {
  if (mixer) return mixer

  log('creating master mixer')

  const ctx = getAudioContext()
  const masterGain = ctx.createGain()
  masterGain.connect(ctx.destination)

  log('master mixer created', { sampleRate: ctx.sampleRate })

  mixer = {
    masterGain,

    getInputNode() {
      return masterGain
    },

    setMasterVolume(value: number) {
      masterGain.gain.value = value
    },

    getMasterVolume() {
      return masterGain.gain.value
    },

    useMediaStreamOutput() {
      // Disconnect from direct destination
      masterGain.disconnect()

      // Create MediaStream destination if needed
      if (!mediaStreamDest) {
        mediaStreamDest = ctx.createMediaStreamDestination()
      }

      // Connect to MediaStream destination
      masterGain.connect(mediaStreamDest)

      // Create audio element if needed
      if (!audioElement) {
        audioElement = document.createElement('audio')
        audioElement.autoplay = true
      }

      // Route MediaStream to audio element
      audioElement.srcObject = mediaStreamDest.stream
      audioElement.play().catch(err => log('audio element play error:', err))

      log('switched to MediaStream output')
    },

    useDirectOutput() {
      // Stop audio element
      if (audioElement) {
        audioElement.pause()
        audioElement.srcObject = null
      }

      // Disconnect from MediaStream destination
      masterGain.disconnect()

      // Connect directly to AudioContext destination
      masterGain.connect(ctx.destination)

      log('switched to direct output')
    },
  }

  return mixer
}
