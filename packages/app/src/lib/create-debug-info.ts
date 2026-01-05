import type { Player } from '~/hooks/create-player'

export interface DebugInfo {
  player: Player
  getPlaybackStates: () => Array<{
    trackIndex: number
    state: string
    currentTime: number
    hasFrame: boolean
  }>
}

export function createDebugInfo(player: Player) {
  ;(window as any).__EDDY_DEBUG__ = {
    player,
    getPlaybackStates: () => {
      const states = []
      for (let i = 0; i < 4; i++) {
        const slot = player.getSlot(i)
        const playback = slot.playback()
        if (playback) {
          states.push({
            trackIndex: i,
            state: playback.state,
            currentTime: player.time(),
            hasFrame: playback.getFrameAt(player.time()) !== null,
          })
        }
      }
      return states
    },
  }
}
