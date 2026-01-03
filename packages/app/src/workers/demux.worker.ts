/**
 * Demux Worker
 *
 * Handles video/audio demuxing off the main thread using mediabunny.
 * Exposes RPC methods for the main thread to call.
 */

import { expose } from '@bigmistqke/rpc/messenger'
import type { DemuxWorkerMethods } from './types'

// Worker implementation will be added in Ticket 2
const methods: DemuxWorkerMethods = {
  async init(_buffer: ArrayBuffer) {
    throw new Error('Not implemented')
  },

  async getVideoConfig() {
    throw new Error('Not implemented')
  },

  async getAudioConfig() {
    throw new Error('Not implemented')
  },

  async getSamples(_trackId: number, _startTime: number, _endTime: number) {
    throw new Error('Not implemented')
  },

  async getAllSamples(_trackId: number) {
    throw new Error('Not implemented')
  },

  async getKeyframeBefore(_trackId: number, _time: number) {
    throw new Error('Not implemented')
  },

  destroy() {
    // No-op for now
  },
}

expose(methods)
