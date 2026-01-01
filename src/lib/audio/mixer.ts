import { getAudioContext } from './context'

export interface MasterMixer {
  masterGain: GainNode
  getInputNode: () => AudioNode
  setMasterVolume: (value: number) => void
  getMasterVolume: () => number
}

let mixer: MasterMixer | null = null

export function getMasterMixer(): MasterMixer {
  if (mixer) return mixer

  const ctx = getAudioContext()
  const masterGain = ctx.createGain()
  masterGain.connect(ctx.destination)

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
  }

  return mixer
}
