/**
 * Utilities for creating worker RPC clients
 */

import { rpc } from '@bigmistqke/rpc/messenger'
import type {
  CompositorWorkerMethods,
  DemuxWorkerMethods,
  RecordingWorkerMethods,
} from './types'

// Import workers as URLs for Vite
import DemuxWorkerUrl from './demux.worker.ts?worker&url'
import RecordingWorkerUrl from './recording.worker.ts?worker&url'
import CompositorWorkerUrl from './compositor.worker.ts?worker&url'

/** RPC wrapper type - all methods return Promises */
type RpcMethods<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K]
}

export interface WorkerHandle<T extends object> {
  /** RPC proxy to call worker methods */
  rpc: RpcMethods<T>
  /** The underlying Worker instance */
  worker: Worker
  /** Terminate the worker */
  terminate(): void
}

function createWorkerHandle<T extends object>(url: string): WorkerHandle<T> {
  const worker = new Worker(url, { type: 'module' })
  const proxy = rpc<T>(worker)

  return {
    rpc: proxy as RpcMethods<T>,
    worker,
    terminate() {
      worker.terminate()
    },
  }
}

/** Create a demux worker */
export function createDemuxWorker(): WorkerHandle<DemuxWorkerMethods> {
  return createWorkerHandle<DemuxWorkerMethods>(DemuxWorkerUrl)
}

/** Create a recording worker */
export function createRecordingWorker(): WorkerHandle<RecordingWorkerMethods> {
  return createWorkerHandle<RecordingWorkerMethods>(RecordingWorkerUrl)
}

/** Create a compositor worker */
export function createCompositorWorker(): WorkerHandle<CompositorWorkerMethods> {
  return createWorkerHandle<CompositorWorkerMethods>(CompositorWorkerUrl)
}
