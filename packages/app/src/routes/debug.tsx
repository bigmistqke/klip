/**
 * Debug route for testing video muxing in isolation with worker-based pipeline.
 *
 * Architecture:
 * Main Thread: MediaStreamTrackProcessor.readable → transfer → Capture Worker
 * Capture Worker: VideoFrame → copyTo(buffer) → transfer → Muxer Worker
 * Muxer Worker: queue → recreate VideoFrame → VideoSample → mux
 */

import { createSignal, onCleanup, Show } from 'solid-js'
import CaptureWorker from '../workers/debug-capture.worker?worker'
import MuxerWorker from '../workers/debug-muxer.worker?worker'

export default function Debug() {
  const [status, setStatus] = createSignal<string>('idle')
  const [isRecording, setIsRecording] = createSignal(false)
  const [log, setLog] = createSignal<string[]>([])
  const [artificialDelay, setArtificialDelay] = createSignal(0)

  let stream: MediaStream | null = null
  let captureWorker: Worker | null = null
  let muxerWorker: Worker | null = null

  const addLog = (msg: string) => {
    console.log(`[debug] ${msg}`)
    setLog(prev => [...prev, `${new Date().toISOString().slice(11, 23)} ${msg}`])
  }

  async function startRecording() {
    try {
      setStatus('requesting camera...')
      addLog('requesting camera')

      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 480 },
        audio: false,
      })

      const videoTrack = stream.getVideoTracks()[0]
      const settings = videoTrack?.getSettings()
      addLog(`camera: ${settings?.width}x${settings?.height} @ ${settings?.frameRate}fps`)

      // Create workers
      addLog('creating capture worker...')
      captureWorker = new CaptureWorker()
      addLog('capture worker created')

      addLog('creating muxer worker...')
      muxerWorker = new MuxerWorker()
      addLog('muxer worker created')

      // Create MessageChannel to connect capture → muxer
      const channel = new MessageChannel()

      // Set up muxer worker message handling
      muxerWorker.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'started') {
          addLog(`muxer started (${msg.queued} frames queued during init)`)
        }
        if (msg.type === 'progress') {
          addLog(`muxer progress: encoded=${msg.encoded}, queued=${msg.queued}`)
        }
        if (msg.type === 'draining') {
          addLog(`draining: ${msg.queued} frames queued, ${msg.captured} captured`)
        }
        if (msg.type === 'complete') {
          const blob = new Blob([msg.buffer], { type: 'video/webm' })
          addLog(`complete: ${msg.encodedCount} frames, ${blob.size} bytes`)

          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `debug-${Date.now()}.webm`
          a.click()
          URL.revokeObjectURL(url)

          setStatus(`done! ${msg.encodedCount} frames, ${blob.size} bytes`)
          cleanup()
        }
        if (msg.type === 'error') {
          addLog(`muxer error: ${msg.error}`)
          setStatus(`error: ${msg.error}`)
          cleanup()
        }
        if (msg.type === 'debug') {
          addLog(`muxer: ${msg.message}`)
        }
      }

      // Set up capture worker message handling
      captureWorker.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'ready') {
          // Worker is loaded and ready - NOW create the processor
          addLog('capture worker ready, creating processor...')
          const processor = new MediaStreamTrackProcessor({ track: videoTrack })
          addLog('processor created, starting capture')
          captureWorker.postMessage(
            { type: 'start', readable: processor.readable },
            [processor.readable]
          )
        }
        if (msg.type === 'capturing') {
          addLog(msg.message)
        }
        if (msg.type === 'done') {
          addLog(`capture done: ${msg.frameCount} frames`)
        }
        if (msg.type === 'error') {
          addLog(`capture error: ${msg.error}`)
        }
        if (msg.type === 'debug') {
          addLog(`capture: ${msg.message}`)
        }
      }

      // Give muxer worker its port
      addLog('sending port to muxer worker...')
      muxerWorker.postMessage({ type: 'port', port: channel.port2 }, [channel.port2])
      addLog('port sent')

      // Wait for capture worker to be ready before creating processor
      addLog('waiting for capture worker ready...')
      captureWorker.postMessage({ type: 'ping', muxerPort: channel.port1 }, [channel.port1])

      // The 'ready' handler will create the processor and start capture
      // This ensures no frames are dropped during worker module loading

      setIsRecording(true)
      setStatus('recording...')
    } catch (e) {
      addLog(`error: ${e}`)
      setStatus(`error: ${e}`)
      cleanup()
    }
  }

  function stopRecording() {
    setStatus('stopping...')
    addLog('stopping')

    // Tell capture worker to stop
    captureWorker?.postMessage({ type: 'stop' })

    // Stop camera
    stream?.getTracks().forEach(t => t.stop())
    stream = null

    setIsRecording(false)
  }

  function cleanup() {
    captureWorker?.terminate()
    muxerWorker?.terminate()
    captureWorker = null
    muxerWorker = null
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    setIsRecording(false)
  }

  onCleanup(cleanup)

  return (
    <div style={{ padding: '20px', 'font-family': 'monospace' }}>
      <h1>Video Muxing Debug (Workers)</h1>

      <div style={{ 'margin-bottom': '20px', display: 'flex', gap: '20px', 'align-items': 'center' }}>
        <Show
          when={!isRecording()}
          fallback={
            <button onClick={stopRecording} style={{ padding: '20px 40px', 'font-size': '18px', background: '#c00', color: 'white', border: 'none', cursor: 'pointer' }}>
              Stop
            </button>
          }
        >
          <button onClick={startRecording} style={{ padding: '20px 40px', 'font-size': '18px', background: '#0a0', color: 'white', border: 'none', cursor: 'pointer' }}>
            Record
          </button>
        </Show>

        <label style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          Delay:
          <input type="range" min="0" max="1000" value={artificialDelay()} onInput={e => setArtificialDelay(parseInt(e.currentTarget.value))} disabled={isRecording()} style={{ width: '150px' }} />
          {artificialDelay()}ms
          <span style={{ color: '#666', 'font-size': '11px' }}>(not implemented in workers yet)</span>
        </label>
      </div>

      <div style={{ 'margin-bottom': '10px' }}><strong>Status:</strong> {status()}</div>

      <div style={{ background: '#111', color: '#0f0', padding: '10px', height: '400px', 'overflow-y': 'auto', 'font-size': '11px' }}>
        {log().map(line => <div>{line}</div>)}
      </div>
    </div>
  )
}
