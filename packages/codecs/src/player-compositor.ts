/**
 * Player-Compositor Integration
 * Connects Player instances to the WebGL compositor for rendering
 */

import type { Player } from './player'
import type { Compositor } from '../video/compositor'

export interface PlayerSlot {
  /** The player instance */
  player: Player
  /** Track index in the compositor (0-3) */
  trackIndex: number
  /** Unsubscribe function for frame callback */
  unsubscribe: () => void
}

export interface PlayerCompositor {
  /** The compositor being used */
  readonly compositor: Compositor

  /** Currently attached players */
  readonly slots: ReadonlyArray<PlayerSlot | null>

  /**
   * Attach a player to a compositor track
   * @param trackIndex - Track index (0-3)
   * @param player - Player instance to attach
   */
  attach(trackIndex: number, player: Player): void

  /**
   * Detach a player from a track
   * @param trackIndex - Track index to detach
   */
  detach(trackIndex: number): void

  /**
   * Start the render loop
   */
  start(): void

  /**
   * Stop the render loop
   */
  stop(): void

  /**
   * Render a single frame (manual rendering)
   */
  renderFrame(): void

  /**
   * Clean up all resources
   */
  destroy(): void
}

export interface PlayerCompositorOptions {
  /** Whether to start rendering immediately (default: true) */
  autoStart?: boolean
}

/**
 * Create a player-compositor integration
 */
export function createPlayerCompositor(
  compositor: Compositor,
  options: PlayerCompositorOptions = {}
): PlayerCompositor {
  const autoStart = options.autoStart ?? true

  const slots: (PlayerSlot | null)[] = [null, null, null, null]
  let animationFrameId: number | null = null
  let isRunning = false

  /** Render loop */
  const renderLoop = () => {
    if (!isRunning) return

    // Update compositor with current frames from all players
    for (const slot of slots) {
      if (slot) {
        const frame = slot.player.getCurrentFrame()
        compositor.setFrame(slot.trackIndex, frame)
      }
    }

    // Render the composited output
    compositor.render()

    // Schedule next frame
    animationFrameId = requestAnimationFrame(renderLoop)
  }

  const instance: PlayerCompositor = {
    get compositor() {
      return compositor
    },

    get slots() {
      return slots
    },

    attach(trackIndex: number, player: Player): void {
      if (trackIndex < 0 || trackIndex > 3) {
        throw new Error(`Track index must be 0-3, got ${trackIndex}`)
      }

      // Detach existing player if any
      if (slots[trackIndex]) {
        this.detach(trackIndex)
      }

      // Subscribe to frame updates from the player
      const unsubscribe = player.onFrame((frame, _time) => {
        // Frame updates are handled in the render loop
        // This callback is mainly for tracking state
      })

      slots[trackIndex] = {
        player,
        trackIndex,
        unsubscribe,
      }
    },

    detach(trackIndex: number): void {
      const slot = slots[trackIndex]
      if (slot) {
        slot.unsubscribe()
        compositor.setFrame(trackIndex, null)
        slots[trackIndex] = null
      }
    },

    start(): void {
      if (isRunning) return
      isRunning = true
      animationFrameId = requestAnimationFrame(renderLoop)
    },

    stop(): void {
      isRunning = false
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }
    },

    renderFrame(): void {
      // Update all frames
      for (const slot of slots) {
        if (slot) {
          const frame = slot.player.getCurrentFrame()
          compositor.setFrame(slot.trackIndex, frame)
        }
      }
      compositor.render()
    },

    destroy(): void {
      this.stop()

      // Detach all players
      for (let i = 0; i < 4; i++) {
        if (slots[i]) {
          this.detach(i)
        }
      }
    },
  }

  // Auto-start if requested
  if (autoStart) {
    instance.start()
  }

  return instance
}

/**
 * Helper to create a multi-track player setup
 * Creates players for multiple tracks and attaches them to a compositor
 */
export interface MultiTrackSetup {
  /** All created players */
  players: Player[]
  /** The player-compositor integration */
  playerCompositor: PlayerCompositor
  /** Play all tracks synchronized */
  playAll(time?: number): Promise<void>
  /** Pause all tracks */
  pauseAll(): void
  /** Stop all tracks */
  stopAll(): void
  /** Seek all tracks to a time */
  seekAll(time: number): Promise<void>
  /** Clean up everything */
  destroy(): void
}

/**
 * Create a multi-track player setup with synchronized playback
 */
export function createMultiTrackSetup(
  players: Player[],
  compositor: Compositor
): MultiTrackSetup {
  const playerCompositor = createPlayerCompositor(compositor)

  // Attach each player to a track
  players.forEach((player, index) => {
    if (index < 4) {
      playerCompositor.attach(index, player)
    }
  })

  return {
    players,
    playerCompositor,

    async playAll(time?: number): Promise<void> {
      await Promise.all(players.map((p) => p.play(time)))
    },

    pauseAll(): void {
      players.forEach((p) => p.pause())
    },

    stopAll(): void {
      players.forEach((p) => p.stop())
    },

    async seekAll(time: number): Promise<void> {
      await Promise.all(players.map((p) => p.seek(time)))
    },

    destroy(): void {
      playerCompositor.destroy()
      players.forEach((p) => p.destroy())
    },
  }
}
