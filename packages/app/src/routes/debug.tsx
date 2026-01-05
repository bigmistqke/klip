/**
 * Debug route for testing video muxing in isolation with worker-based pipeline.
 *
 * Architecture:
 * Main Thread: MediaStreamTrackProcessor.readable → transfer → Capture Worker
 * Capture Worker: VideoFrame → copyTo(buffer) → RPC → Muxer Worker
 * Muxer Worker: queue → recreate VideoFrame → VideoSample → mux
 *
 * Workers are pre-initialized on mount to avoid startup delay during recording.
 */

import { $MESSENGER, rpc, transfer } from '@bigmistqke/rpc/messenger'
import { createSignal, Match, Switch } from 'solid-js'
import { action, defer } from '~/hooks/action'
import { resource } from '~/hooks/resource'
import type { CaptureWorkerMethods } from '~/workers/debug-capture.worker'
import DebugCaptureWorker from '~/workers/debug-capture.worker?worker'
import type { MuxerWorkerMethods } from '~/workers/debug-muxer.worker'
import DebugMuxerWorker from '~/workers/debug-muxer.worker?worker'

export default function Debug() {
  const [log, setLog] = createSignal<string[]>([])

  const addLog = (msg: string) => {
    console.log(`[debug] ${msg}`)
    setLog(prev => [...prev, `${new Date().toISOString().slice(11, 23)} ${msg}`])
  }

  // Pre-initialize workers on mount
  const [workers] = resource(async ({ onCleanup }) => {
    addLog('creating workers...')
    const capture = rpc<CaptureWorkerMethods>(new DebugCaptureWorker())
    const muxer = rpc<MuxerWorkerMethods>(new DebugMuxerWorker())

    // Create MessageChannel to connect capture → muxer
    const channel = new MessageChannel()

    // Set up ports via RPC
    addLog('setting up worker ports...')
    await Promise.all([
      muxer.setCapturePort(transfer(channel.port2)),
      capture.setMuxerPort(transfer(channel.port1)),
    ])
    addLog('ports configured')

    // Pre-initialize VP9 encoder (avoids ~2s startup during recording)
    addLog('pre-initializing VP9 encoder...')
    await muxer.preInit()
    addLog('workers ready')

    onCleanup(() => {
      capture[$MESSENGER].terminate()
      muxer[$MESSENGER].terminate()
    })

    return { capture, muxer }
  })

  const getUserMedia = action(async function (_: undefined, { onCleanup }) {
    addLog('requesting camera')
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
      audio: false,
    })
    onCleanup(() => stream.getTracks().forEach(track => track.stop()))
    return stream
  })

  // Recording action - uses yield* to compose with getUserMedia
  const record = action(function* (_: undefined, { onCleanup, cancellation }) {
    const _workers = workers()
    if (!_workers) throw new Error('Workers not ready')

    // Compose with getUserMedia action
    const stream = yield* defer(getUserMedia())

    const videoTrack = stream.getVideoTracks()[0]
    const settings = videoTrack?.getSettings()
    addLog(`camera: ${settings?.width}x${settings?.height} @ ${settings?.frameRate}fps`)

    // Create processor and start capture
    addLog('starting capture...')
    const processor = new MediaStreamTrackProcessor({ track: videoTrack })

    // Start capture (runs until cancelled)
    const capturePromise = _workers.capture
      .start(transfer(processor.readable as ReadableStream<VideoFrame>))
      .then(() => addLog('capture completed'))
      .catch((err: unknown) => addLog(`capture error: ${err}`))

    onCleanup(async () => {
      addLog('stopping capture...')
      await _workers.capture.stop()
      await capturePromise
      addLog('stopping capture completed')
    })

    addLog('recording...')

    // Wait until cancelled
    yield cancellation
  })

  // Finalize and download
  const finalize = action(async () => {
    const _workers = workers()
    if (!_workers) return

    addLog('finalizing...')
    try {
      const result = await _workers.muxer.finalize()
      const { blob, frameCount } = result
      addLog(`finalized: ${frameCount} frames, ${blob.size} bytes`)

      if (blob.size > 0) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `debug-${Date.now()}.webm`
        a.click()
        URL.revokeObjectURL(url)
      }

      // Reset muxer for next recording
      await _workers.muxer.reset()
      await _workers.muxer.preInit()
      addLog('ready for next recording')
    } catch (e) {
      addLog(`finalize error: ${e}`)
    }
  })

  async function handleStop() {
    record.cancel()
    await finalize()
  }

  const status = () => {
    if (workers.loading) return 'initializing workers...'
    if (workers.error) return `error: ${workers.error}`
    if (record.pending()) return 'recording...'
    return 'ready'
  }

  return (
    <div style={{ padding: '20px', 'font-family': 'monospace' }}>
      <h1>Video Muxing Debug (Workers + RPC)</h1>

      <div
        style={{ 'margin-bottom': '20px', display: 'flex', gap: '20px', 'align-items': 'center' }}
      >
        <Switch>
          <Match when={workers.loading}>
            <button
              disabled
              style={{
                padding: '20px 40px',
                'font-size': '18px',
                background: '#666',
                color: 'white',
                border: 'none',
              }}
            >
              Initializing...
            </button>
          </Match>
          <Match when={getUserMedia.pending()}>
            <button
              onClick={handleStop}
              style={{
                padding: '20px 40px',
                'font-size': '18px',
                background: '#c00',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Initialize Camera...
            </button>
          </Match>
          <Match when={record.pending()}>
            <button
              onClick={handleStop}
              style={{
                padding: '20px 40px',
                'font-size': '18px',
                background: '#c00',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Stop
            </button>
          </Match>
          <Match when={workers()}>
            <button
              onClick={() => record.try()}
              style={{
                padding: '20px 40px',
                'font-size': '18px',
                background: '#0a0',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Record
            </button>
          </Match>
        </Switch>
      </div>

      <div style={{ 'margin-bottom': '10px' }}>
        <strong>Status:</strong> {status()}
      </div>

      <div
        style={{
          background: '#111',
          color: '#0f0',
          padding: '10px',
          height: '400px',
          'overflow-y': 'auto',
          'font-size': '11px',
        }}
      >
        {log().map(line => (
          <div>{line}</div>
        ))}
      </div>
    </div>
  )
}
