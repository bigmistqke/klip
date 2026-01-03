/**
 * Compositor Worker
 *
 * Handles WebGL compositing off the main thread using OffscreenCanvas.
 */

import { expose } from '@bigmistqke/rpc/messenger'
import type { CompositorWorkerMethods } from './types'

// Worker implementation will be added in Ticket 4
const methods: CompositorWorkerMethods = {
  async init(_canvas: OffscreenCanvas, _width: number, _height: number) {
    throw new Error('Not implemented')
  },

  setFrame(_index: number, _frame: VideoFrame | null) {
    throw new Error('Not implemented')
  },

  render() {
    throw new Error('Not implemented')
  },

  destroy() {
    // No-op for now
  },
}

expose(methods)
