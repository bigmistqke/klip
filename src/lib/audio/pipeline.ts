import { getAudioContext } from './context'

export interface AudioPipeline {
  source: MediaElementAudioSourceNode | null
  gain: GainNode
  pan: StereoPannerNode
  setVolume: (value: number) => void
  setPan: (value: number) => void
  connect: (element: HTMLMediaElement) => void
  disconnect: () => void
}

export function createAudioPipeline(): AudioPipeline {
  const ctx = getAudioContext()

  const gain = ctx.createGain()
  const pan = ctx.createStereoPanner()

  // Chain: source -> gain -> pan -> destination
  gain.connect(pan)
  pan.connect(ctx.destination)

  let source: MediaElementAudioSourceNode | null = null

  return {
    source,
    gain,
    pan,

    setVolume(value: number) {
      // value: 0-1
      gain.gain.value = value
    },

    setPan(value: number) {
      // value: -1 (left) to 1 (right)
      pan.pan.value = value
    },

    connect(element: HTMLMediaElement) {
      if (source) {
        source.disconnect()
      }
      source = ctx.createMediaElementSource(element)
      source.connect(gain)
    },

    disconnect() {
      if (source) {
        source.disconnect()
        source = null
      }
    },
  }
}
