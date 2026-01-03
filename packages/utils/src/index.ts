const ENABLED = false

/**
 * Create a debug logger that can be toggled on/off
 *
 * Usage:
 *   const log = debug("player", true);
 *   log("loading clip", { trackIndex, blob });
 */
export function debug(title: string, enabled: boolean) {
  return (...args: unknown[]) => {
    if (ENABLED && enabled) {
      console.log(`[${title}]`, ...args)
    }
  }
}
