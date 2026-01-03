/**
 * Recording Worker
 *
 * Handles video/audio encoding off the main thread.
 * Receives MediaStreamTrackProcessor streams and encodes with WebCodecs.
 */

import { expose } from '@bigmistqke/rpc/messenger'
import type { RecordingWorkerMethods } from './types'

// Worker implementation will be added in Ticket 3
const methods: RecordingWorkerMethods = {
  async start(_config) {
    throw new Error('Not implemented')
  },

  async stop() {
    throw new Error('Not implemented')
  },

  async getFirstFrame() {
    throw new Error('Not implemented')
  },
}

expose(methods)
