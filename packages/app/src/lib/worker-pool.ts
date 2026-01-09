/**
 * Worker Pool
 *
 * Manages a pool of reusable Web Workers to avoid initialization overhead.
 * Workers are acquired for clip playback and returned when done.
 */

import { rpc, type RPC } from '@bigmistqke/rpc/messenger'
import { debug } from '@eddy/utils'
import type { PlaybackWorkerMethods } from '~/workers/playback.worker'
import PlaybackWorker from '~/workers/playback.worker?worker'

const log = debug('worker-pool', false)

type PlaybackRPC = RPC<PlaybackWorkerMethods>

export interface PooledWorker {
  worker: Worker
  rpc: PlaybackRPC
  inUse: boolean
}

export interface WorkerPool {
  /** Acquire a worker from the pool (creates new if none available) */
  acquire(): PooledWorker

  /** Release a worker back to the pool */
  release(worker: PooledWorker): void

  /** Get current pool stats */
  stats(): { total: number; inUse: number; idle: number }

  /** Destroy all workers in the pool */
  destroy(): void
}

export interface WorkerPoolOptions {
  /** Maximum number of workers to keep in pool (default: 8) */
  maxSize?: number
}

/**
 * Create a worker pool for playback workers
 */
export function createWorkerPool(options: WorkerPoolOptions = {}): WorkerPool {
  const { maxSize = 8 } = options

  const pool: PooledWorker[] = []

  function createWorker(): PooledWorker {
    log('creating new worker')
    const worker = new PlaybackWorker()
    const workerRpc = rpc<PlaybackWorkerMethods>(worker)

    return {
      worker,
      rpc: workerRpc,
      inUse: false,
    }
  }

  function acquire(): PooledWorker {
    // Find an idle worker
    const idle = pool.find(w => !w.inUse)

    if (idle) {
      log('acquiring idle worker', { poolSize: pool.length })
      idle.inUse = true
      return idle
    }

    // Create new worker if under limit
    if (pool.length < maxSize) {
      const newWorker = createWorker()
      newWorker.inUse = true
      pool.push(newWorker)
      log('created new worker', { poolSize: pool.length })
      return newWorker
    }

    // Pool exhausted - create anyway but don't add to pool
    // This worker will be terminated on release
    log('pool exhausted, creating temporary worker')
    const tempWorker = createWorker()
    tempWorker.inUse = true
    return tempWorker
  }

  async function release(pooledWorker: PooledWorker): Promise<void> {
    const inPool = pool.includes(pooledWorker)

    if (inPool) {
      // Reset worker state - cleans up decoder, input, buffers
      // Worker remains alive and ready for new clip
      await pooledWorker.rpc.destroy()
      pooledWorker.inUse = false
      log('released worker to pool', { poolSize: pool.length })
    } else {
      // Temporary worker (pool was full) - fully terminate
      await pooledWorker.rpc.destroy()
      pooledWorker.worker.terminate()
      log('terminated temporary worker')
    }
  }

  function stats() {
    const inUse = pool.filter(w => w.inUse).length
    return {
      total: pool.length,
      inUse,
      idle: pool.length - inUse,
    }
  }

  function destroy(): void {
    log('destroying pool', { size: pool.length })
    for (const pooledWorker of pool) {
      pooledWorker.rpc.destroy()
      pooledWorker.worker.terminate()
    }
    pool.length = 0
  }

  return {
    acquire,
    release,
    stats,
    destroy,
  }
}
