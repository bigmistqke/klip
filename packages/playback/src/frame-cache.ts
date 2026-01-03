import { debug, getGlobalPerfMonitor } from '@eddy/utils'

const log = debug('frame-cache', false)
const perf = getGlobalPerfMonitor()

/** Unique key for a cached frame */
export type FrameKey = `${number}:${number}` // trackId:pts

/** Entry in the cache */
interface CacheEntry {
  frame: VideoFrame
  trackId: number
  pts: number
}

export interface FrameCache {
  /**
   * Get a frame from cache. Returns a CLONE (original stays cached).
   * Returns null on cache miss.
   */
  get(trackId: number, pts: number): VideoFrame | null

  /**
   * Get the original frame without cloning (for checking if cached).
   * DO NOT close or transfer the returned frame!
   */
  peek(trackId: number, pts: number): VideoFrame | null

  /**
   * Check if a frame is in cache
   */
  has(trackId: number, pts: number): boolean

  /**
   * Store a decoded frame. Cache takes ownership of the frame.
   * If frame at same key exists, old one is closed and replaced.
   */
  put(trackId: number, pts: number, frame: VideoFrame): void

  /**
   * Remove a specific frame from cache
   */
  remove(trackId: number, pts: number): void

  /**
   * Remove all frames for a track
   */
  removeTrack(trackId: number): void

  /**
   * Clear entire cache
   */
  clear(): void

  /** Current number of frames in cache */
  readonly size: number

  /** Maximum frames allowed */
  readonly maxSize: number

  /** Approximate memory usage in bytes */
  readonly memoryUsage: number
}

/**
 * Create an LRU frame cache.
 *
 * @param maxFrames - Maximum number of frames to keep (default: 1024)
 */
export function createFrameCache(maxFrames: number = 1024 * 4): FrameCache {
  // Map preserves insertion order - we use delete+set to move to end (most recent)
  const cache = new Map<FrameKey, CacheEntry>()

  // Track approximate memory usage
  let memoryUsage = 0

  const makeKey = (trackId: number, pts: number): FrameKey =>
    `${trackId}:${pts}` as FrameKey

  const estimateFrameSize = (frame: VideoFrame): number => {
    // Rough estimate: width * height * 4 bytes (RGBA) * 1.5 (YUV overhead)
    return frame.displayWidth * frame.displayHeight * 6
  }

  const evictLRU = () => {
    // First entry in Map is least recently used
    const first = cache.entries().next()
    if (!first.done) {
      const [key, entry] = first.value
      log('evictLRU', { key, pts: entry.pts, trackId: entry.trackId })
      memoryUsage -= estimateFrameSize(entry.frame)
      entry.frame.close()
      cache.delete(key)
    }
  }

  return {
    get(trackId: number, pts: number): VideoFrame | null {
      const key = makeKey(trackId, pts)
      const entry = cache.get(key)

      if (!entry) {
        perf.increment('cache-miss')
        return null
      }

      perf.increment('cache-hit')

      // Move to end (most recently used)
      cache.delete(key)
      cache.set(key, entry)

      // Return a clone so cache keeps original
      try {
        perf.start('frame-clone')
        const clone = entry.frame.clone()
        perf.end('frame-clone')
        return clone
      } catch (e) {
        // Frame might be closed/invalid
        log('get: clone failed', { key, error: e })
        cache.delete(key)
        return null
      }
    },

    peek(trackId: number, pts: number): VideoFrame | null {
      const key = makeKey(trackId, pts)
      const entry = cache.get(key)

      if (!entry) return null

      // Move to end (counts as access for LRU)
      cache.delete(key)
      cache.set(key, entry)

      return entry.frame
    },

    has(trackId: number, pts: number): boolean {
      return cache.has(makeKey(trackId, pts))
    },

    put(trackId: number, pts: number, frame: VideoFrame): void {
      const key = makeKey(trackId, pts)

      // If already exists, close old and remove
      const existing = cache.get(key)
      if (existing) {
        memoryUsage -= estimateFrameSize(existing.frame)
        existing.frame.close()
        cache.delete(key)
      }

      // Add to end (most recently used)
      const entry: CacheEntry = { frame, trackId, pts }
      cache.set(key, entry)
      memoryUsage += estimateFrameSize(frame)

      log('put', { key, size: cache.size, memoryMB: (memoryUsage / 1024 / 1024).toFixed(1) })

      // Evict if over limit
      while (cache.size > maxFrames) {
        evictLRU()
      }
    },

    remove(trackId: number, pts: number): void {
      const key = makeKey(trackId, pts)
      const entry = cache.get(key)
      if (entry) {
        memoryUsage -= estimateFrameSize(entry.frame)
        entry.frame.close()
        cache.delete(key)
        log('remove', { key })
      }
    },

    removeTrack(trackId: number): void {
      const keysToRemove: FrameKey[] = []

      for (const [key, entry] of cache) {
        if (entry.trackId === trackId) {
          keysToRemove.push(key)
        }
      }

      for (const key of keysToRemove) {
        const entry = cache.get(key)
        if (entry) {
          memoryUsage -= estimateFrameSize(entry.frame)
          entry.frame.close()
          cache.delete(key)
        }
      }

      log('removeTrack', { trackId, removed: keysToRemove.length })
    },

    clear(): void {
      log('clear', { size: cache.size })
      for (const entry of cache.values()) {
        entry.frame.close()
      }
      cache.clear()
      memoryUsage = 0
    },

    get size() {
      return cache.size
    },

    get maxSize() {
      return maxFrames
    },

    get memoryUsage() {
      return memoryUsage
    },
  }
}

// Singleton cache shared across all playbacks
let sharedCache: FrameCache | null = null

/**
 * Get the shared frame cache instance.
 * Creates one if it doesn't exist.
 */
export function getSharedFrameCache(maxFrames: number = 512): FrameCache {
  if (!sharedCache) {
    sharedCache = createFrameCache(maxFrames)
  }
  return sharedCache
}

/**
 * Destroy the shared cache (for cleanup)
 */
export function destroySharedFrameCache(): void {
  if (sharedCache) {
    sharedCache.clear()
    sharedCache = null
  }
}
