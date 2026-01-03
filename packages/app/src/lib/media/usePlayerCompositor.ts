/**
 * SolidJS hook for PlayerCompositor
 */

import { onCleanup, onMount, type Accessor } from 'solid-js'
import type { Compositor } from '../video/compositor'
import { createPlayerCompositor, type PlayerCompositor, type Player } from '@klip/codecs'

export interface UsePlayerCompositorOptions {
  /** Whether to start rendering immediately (default: true) */
  autoStart?: boolean
}

export interface UsePlayerCompositorReturn {
  /** The compositor being used */
  compositor: Compositor
  /** The player-compositor integration */
  playerCompositor: Accessor<PlayerCompositor | null>
  /** Attach a player to a track */
  attach: (trackIndex: number, player: Player) => void
  /** Detach a player from a track */
  detach: (trackIndex: number) => void
  /** Start the render loop */
  start: () => void
  /** Stop the render loop */
  stop: () => void
  /** Render a single frame */
  renderFrame: () => void
}

/**
 * Create a reactive PlayerCompositor for SolidJS
 */
export function usePlayerCompositor(
  compositor: Compositor,
  options: UsePlayerCompositorOptions = {}
): UsePlayerCompositorReturn {
  let playerCompositor: PlayerCompositor | null = null

  onMount(() => {
    playerCompositor = createPlayerCompositor(compositor, {
      autoStart: options.autoStart ?? true,
    })
  })

  onCleanup(() => {
    playerCompositor?.destroy()
    playerCompositor = null
  })

  return {
    compositor,
    playerCompositor: () => playerCompositor,

    attach(trackIndex: number, player: Player): void {
      playerCompositor?.attach(trackIndex, player)
    },

    detach(trackIndex: number): void {
      playerCompositor?.detach(trackIndex)
    },

    start(): void {
      playerCompositor?.start()
    },

    stop(): void {
      playerCompositor?.stop()
    },

    renderFrame(): void {
      playerCompositor?.renderFrame()
    },
  }
}
