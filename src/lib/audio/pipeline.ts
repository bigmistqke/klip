import { getAudioContext } from './context'
import { getMasterMixer } from './mixer'

export interface AudioPipeline {
  gain: GainNode
  pan: StereoPannerNode
  setVolume: (value: number) => void
  setPan: (value: number) => void
  connect: (element: HTMLMediaElement) => void
  disconnect: () => void
}

// Track elements that have been connected (can only create one source per element ever)
const connectedElements = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()

export function createAudioPipeline(): AudioPipeline {
  const ctx = getAudioContext()
  const mixer = getMasterMixer()

  const gain = ctx.createGain()
  const pan = ctx.createStereoPanner()

  // Chain: source -> gain -> pan -> master bus -> destination
  gain.connect(pan)
  pan.connect(mixer.getInputNode())

  let currentSource: MediaElementAudioSourceNode | null = null

  return {
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
      // Disconnect current source from our gain node
      if (currentSource) {
        currentSource.disconnect()
      }

      // Check if element already has a source node (can only create once per element)
      let source = connectedElements.get(element)
      if (!source) {
        source = ctx.createMediaElementSource(element)
        connectedElements.set(element, source)
      }

      source.connect(gain)
      currentSource = source
    },

    disconnect() {
      if (currentSource) {
        currentSource.disconnect()
        currentSource = null
      }
    },
  }
}
