/**
 * Player-Compositor Integration
 * Connects Playback instances to the WebGL compositor for rendering
 */

import type { Compositor } from '@klip/compositor'
import type { Playback } from '@klip/playback'

export interface PlaybackSlot {
  /** The player instance */
  playback: Playback
  /** Track index in the compositor (0-3) */
  trackIndex: number
  /** Unsubscribe function for frame callback */
  unsubscribe: () => void
}

export interface PlaybackCompositor {
  /** The compositor being used */
  readonly compositor: Compositor

  /** Currently attached players */
  readonly slots: ReadonlyArray<PlaybackSlot | null>

  /**
   * Attach a player to a compositor track
   * @param trackIndex - Track index (0-3)
   * @param player - Player instance to attach
   */
  attach(trackIndex: number, player: Playback): void

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

export interface PlaybackCompositorOptions {
  /** Whether to start rendering immediately (default: true) */
  autoStart?: boolean
}

/**
 * Create a player-compositor integration
 */
export function createPlaybackCompositor(
  compositor: Compositor,
  options: PlaybackCompositorOptions = {}
): PlaybackCompositor {
  const autoStart = options.autoStart ?? true

  const slots: (PlaybackSlot | null)[] = [null, null, null, null]
  let animationFrameId: number | null = null
  let isRunning = false

  /** Render loop */
  const renderLoop = () => {
    if (!isRunning) return

    // Update compositor with current frames from all players
    for (const slot of slots) {
      if (slot) {
        const frame = slot.playback.getCurrentFrame()
        compositor.setFrame(slot.trackIndex, frame)
      }
    }

    // Render the composited output
    compositor.render()

    // Schedule next frame
    animationFrameId = requestAnimationFrame(renderLoop)
  }

  const instance: PlaybackCompositor = {
    get compositor() {
      return compositor
    },

    get slots() {
      return slots
    },

    attach(trackIndex: number, player: Playback): void {
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
        playback: player,
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
          const frame = slot.playback.getCurrentFrame()
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
