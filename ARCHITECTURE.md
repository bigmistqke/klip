# Eddy Architecture

This document provides an exhaustive overview of the Eddy video editor architecture.

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Editor (create-editor.ts)                       │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Project    │  │    Player    │  │   Workers    │  │    Actions   │     │
│  │    Store     │  │              │  │              │  │              │     │
│  │              │  │  - Slots     │  │  - Capture   │  │  - Preview   │     │
│  │  - Tracks    │  │  - Clock     │  │  - Muxer     │  │  - Record    │     │
│  │  - Clips     │  │  - Compositor│  │              │  │  - Publish   │     │
│  │  - Effects   │  │              │  │              │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  @eddy/playback  │    │   @eddy/mixer    │    │   @eddy/codecs   │
│                  │    │                  │    │                  │
│  - FrameBuffer   │    │  - AudioPipeline │    │  - Demuxer       │
│  - AudioScheduler│    │  - MasterMixer   │    │  - Muxer         │
│  - Playback      │    │  - AudioContext  │    │  - Decoders      │
│  - RingBuffer    │    │                  │    │  - Encoders      │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

## Package Structure

```
packages/
├── app/                    # SolidJS application
│   └── src/
│       ├── components/     # UI components (Editor, Track)
│       ├── hooks/          # Core hooks (create-editor, create-player, create-slot)
│       ├── workers/        # Web workers (compositor, capture, muxer, demux)
│       ├── routes/         # Page routes
│       └── lib/            # Utilities and AT Protocol integration
├── playback/               # Video/audio playback engine
│   └── src/
│       ├── playback.ts           # Main playback controller
│       ├── frame-buffer.ts       # Video frame buffering
│       ├── audio-scheduler.ts    # Ring buffer audio playback
│       ├── audio-ring-buffer.ts  # SharedArrayBuffer ring buffer
│       └── audio-ring-buffer-processor.ts  # AudioWorklet processor
├── mixer/                  # Audio mixing and routing
│   └── src/
│       ├── index.ts        # AudioPipeline (per-track gain/pan)
│       ├── mixer.ts        # MasterMixer singleton
│       └── context.ts      # Shared AudioContext
├── codecs/                 # Media encoding/decoding
│   └── src/
│       ├── demux/          # mediabunny WebM demuxer
│       ├── decode/         # WebCodecs video/audio decoders
│       └── muxer.ts        # mediabunny WebM muxer
├── lexicons/               # AT Protocol schema definitions
└── utils/                  # Shared utilities (debug logging)
```

## Playback Flow

### Video Playback Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            MAIN THREAD                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────────────┐
│ Blob                                                                        │
│   │                                                                         │
│   ▼                                                                         │
│ ┌──────────────────┐                                                        │
│ │   Demux Worker   │   (demux.worker.ts)                                    │
│ │                  │                                                        │
│ │  mediabunny      │──────▶ DemuxedSamples (pts, data, isKeyframe)          │
│ │  parses WebM     │                                                        │
│ └──────────────────┘                                                        │
│           │                                                                 │
│           ▼                                                                 │
│ ┌──────────────────┐                                                        │
│ │   FrameBuffer    │   (frame-buffer.ts)                                    │
│ │                  │                                                        │
│ │  - VideoDecoder  │──────▶ VideoFrame ──▶ copyTo(ArrayBuffer)              │
│ │  - Stores raw    │                       ──▶ frame.close()                │
│ │    ArrayBuffers  │                                                        │
│ │  - 10 frames max │                                                        │
│ └──────────────────┘                                                        │
│           │                                                                 │
│           │  getFrame(time)                                                 │
│           │  (creates VideoFrame from ArrayBuffer)                          │
│           ▼                                                                 │
│ ┌──────────────────┐                                                        │
│ │      Slot        │   (create-slot.ts)                                     │
│ │                  │                                                        │
│ │  - Per-track     │──────▶ transfer(VideoFrame) ──────────────────────┐    │
│ │  - AudioPipeline │                                                   │    │
│ │  - Playback      │                                                   │    │
│ └──────────────────┘                                                   │    │
│                                                                        │    │
└────────────────────────────────────────────────────────────────────────│────┘
                                                                         │
┌────────────────────────────────────────────────────────────────────────│────┐
│                         COMPOSITOR WORKER                              │    │
│                                                                        │    │
│ ┌──────────────────────────────────────────────────────────────────────▼──┐ │
│ │                     compositor.worker.ts                                │ │
│ │                                                                         │ │
│ │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐  │ │
│ │  │ Slot 0 Tex  │   │ Slot 1 Tex  │   │ Slot 2 Tex  │   │ Slot 3 Tex  │  │ │
│ │  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘  │ │
│ │         │                 │                 │                 │         │ │
│ │         └────────────┬────┴─────────────────┴────┬────────────┘         │ │
│ │                      │                           │                      │ │
│ │                      ▼                           ▼                      │ │
│ │              ┌───────────────┐          ┌───────────────┐               │ │
│ │              │ Main Canvas   │          │ Capture Canvas│               │ │
│ │              │ (visible)     │          │ (pre-render)  │               │ │
│ │              │               │          │               │               │ │
│ │              │  2x2 Grid     │          │  2x2 Grid     │               │ │
│ │              │  WebGL        │          │  WebGL        │               │ │
│ │              └───────────────┘          └───────────────┘               │ │
│ │                                                                         │ │
│ │  Features:                                                              │ │
│ │  - setFrame(index, VideoFrame) - playback frames                        │ │
│ │  - setPreviewStream(index, ReadableStream) - camera preview             │ │
│ │  - render() - composites to visible canvas                              │ │
│ │  - captureFrame() - captures from capture canvas                        │ │
│ │                                                                         │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Render Loop (60fps)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Player.renderLoop()    (create-player.ts:172)                               │
│                                                                             │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │  clock.tick()  ──▶  currentTime                                     │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │  for each slot:                                                     │  │
│    │                                                                     │  │
│    │    1. slot.renderFrame(time, playing)                               │  │
│    │         │                                                           │  │
│    │         ├── if playing: playback.tick(time)                         │  │
│    │         │                  └── buffer more video/audio              │  │
│    │         │                                                           │  │
│    │         ├── getFrameTimestamp(time) ──▶ skip if same as last        │  │
│    │         │                                                           │  │
│    │         └── getFrameAt(time) ──▶ VideoFrame                         │  │
│    │               │                                                     │  │
│    │               └── compositor.setFrame(index, transfer(frame))       │  │
│    │                                                                     │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │  compositor.render()                                                │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │  requestAnimationFrame(renderLoop)                                  │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frame Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Video Frame Lifecycle - No Caching, Single-Use                              │
│                                                                             │
│  1. DECODE:   VideoDecoder ──▶ VideoFrame                                   │
│                                    │                                        │
│  2. STORE:    frame.copyTo(ArrayBuffer) ──▶ raw buffer (in FrameBuffer)     │
│               frame.close()                                                 │
│                                    │                                        │
│  3. RETRIEVE: new VideoFrame(buffer, {...}) ──▶ fresh VideoFrame            │
│               (caller takes ownership)                                      │
│                                    │                                        │
│  4. TRANSFER: transfer(frame) ──▶ to compositor worker                      │
│               (ownership moves to worker)                                   │
│                                    │                                        │
│  5. RENDER:   gl.texImage2D(frame) ──▶ GPU texture upload                   │
│               frame.close()                                                 │
│                                                                             │
│  Key Insight: VideoFrames are hardware-backed and can become stale.         │
│               By storing raw ArrayBuffer data and recreating VideoFrames    │
│               on-demand, frames are always fresh.                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Audio Playback Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     AUDIO PLAYBACK FLOW                                     │
│                                                                             │
│  Demuxer                                                                    │
│     │                                                                       │
│     │  getSamples(trackId, startTime, endTime)                              │
│     ▼                                                                       │
│  ┌──────────────────┐                                                       │
│  │  AudioDecoder    │   (WebCodecs)                                         │
│  │                  │                                                       │
│  │  decode(sample)  │──────▶ AudioData                                      │
│  └──────────────────┘                                                       │
│           │                                                                 │
│           │  extractAudioSamples()                                          │
│           │  (converts to Float32Array[] per channel)                       │
│           ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     AudioScheduler                                      ││
│  │                                                                         ││
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────┐  ││
│  │  │  Pending    │    │  Resample   │    │  SharedArrayBuffer          │  ││
│  │  │  Samples    │───▶│  (if needed)│───▶│  Ring Buffer                │  ││
│  │  │  Queue      │    │             │    │                             │  ││
│  │  │             │    │  48kHz →    │    │  write() ──▶ interleaved    │  ││
│  │  │  sorted by  │    │  context    │    │             samples         │  ││
│  │  │  mediaTime  │    │  sampleRate │    │                             │  ││
│  │  └─────────────┘    └─────────────┘    └──────────────┬──────────────┘  ││
│  │                                                       │                 ││
│  └───────────────────────────────────────────────────────│─────────────────┘│
│                                                          │                  │
│  ────────────────────────────────────────────────────────────────────────── │
│                          AUDIO THREAD                    │                  │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                          │                  │
│  ┌───────────────────────────────────────────────────────▼─────────────────┐│
│  │                AudioWorkletProcessor                                    ││
│  │                (audio-ring-buffer-processor.ts)                         ││
│  │                                                                         ││
│  │  process(inputs, outputs):                                              ││
│  │    1. read() from SharedArrayBuffer (128 frames per quantum)            ││
│  │    2. deinterleave to output channels                                   ││
│  │    3. return true (keep processor alive)                                ││
│  │                                                                         ││
│  │  Atomics for lock-free sync:                                            ││
│  │    - WRITE_PTR: main thread updates after write                         ││
│  │    - READ_PTR: worklet updates after read                               ││
│  │    - PLAYING: controls whether to output samples                        ││
│  │                                                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        Audio Pipeline                                   ││
│  │                        (per-track)                                      ││
│  │                                                                         ││
│  │  AudioWorkletNode ──▶ GainNode ──▶ StereoPannerNode ──▶ MasterMixer     ││
│  │                         │              │                    │           ││
│  │                       volume         pan              masterGain        ││
│  │                      (0-1)       (-1 to 1)             (0-1)            ││
│  │                                                            │            ││
│  │                                                            ▼            ││
│  │                                              AudioContext.destination   ││
│  │                                                      (speakers)         ││
│  │                                                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Ring Buffer Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SharedArrayBuffer Ring Buffer Structure                                     │
│                                                                             │
│ Control Buffer (Int32Array, 4 elements):                                    │
│   [0] WRITE_PTR  - Main thread write position                               │
│   [1] READ_PTR   - Worklet read position                                    │
│   [2] CHANNELS   - Number of audio channels                                 │
│   [3] PLAYING    - 0 or 1, controls output                                  │
│                                                                             │
│ Sample Buffer (Float32Array, capacity * channels):                          │
│   Interleaved samples: [L0, R0, L1, R1, L2, R2, ...]                        │
│                                                                             │
│ ┌────────────────────────────────────────────────────────────────────────┐  │
│ │                                                                        │  │
│ │     WRITE_PTR                                READ_PTR                  │  │
│ │         ▼                                        ▼                     │  │
│ │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│ │  │  ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │  │
│ │  │                                                                  │  │  │
│ │  │  ▲ data written by main thread        ▲ available for writing    │  │  │
│ │  │  (ready to read by worklet)           (empty space)              │  │  │
│ │  │                                                                  │  │  │
│ │  └──────────────────────────────────────────────────────────────────┘  │  │
│ │                                                                        │  │
│ │  availableRead = WRITE_PTR - READ_PTR (wrapping)                       │  │
│ │  availableWrite = capacity - availableRead - 1                         │  │
│ │                                                                        │  │
│ └────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│ Lock-Free Protocol:                                                         │
│   - Main thread writes samples, then Atomics.store(WRITE_PTR)               │
│   - Worklet reads samples, then Atomics.store(READ_PTR)                     │
│   - No locks needed - single producer, single consumer                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Recording Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RECORDING ARCHITECTURE                            │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                           create-editor.ts                             │ │
│  │                                                                        │ │
│  │  previewAction(trackIndex):                                            │ │
│  │    1. getUserMedia({ video, audio })                                   │ │
│  │    2. player.setPreviewSource(trackIndex, stream)                      │ │
│  │         └── compositor.setPreviewStream(index, stream)                 │ │
│  │                                                                        │ │
│  │  recordAction(trackIndex):                                             │ │
│  │    1. Get previewAction.result() (MediaStream)                         │ │
│  │    2. Create MediaStreamTrackProcessor for video                       │ │
│  │    3. Create MediaStreamTrackProcessor for audio (if available)        │ │
│  │    4. capture.start(videoReadable, audioReadable)                      │ │
│  │    5. player.play(0) - start playback of other tracks                  │ │
│  │    6. hold() - wait for cancel                                         │ │
│  │                                                                        │ │
│  │  finalizeRecordingAction():                                            │ │
│  │    1. muxer.finalize() ──▶ { blob, frameCount }                        │ │
│  │    2. addRecording(trackIndex, blob, duration)                         │ │
│  │    3. muxer.reset() and preInit() for next recording                   │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          WORKER COMMUNICATION                               │
│                                                                             │
│  ┌─────────────────┐         MessageChannel          ┌─────────────────┐    │
│  │  CaptureWorker  │◀───────────────────────────────▶│  MuxerWorker    │    │
│  │                 │         port1 ◀──▶ port2        │                 │    │
│  │                 │                                 │                 │    │
│  │  Receives:      │         Methods exposed:        │  Receives:      │    │
│  │  - videoStream  │         - addVideoFrame()       │  - video frames │    │
│  │  - audioStream  │         - addAudioFrame()       │  - audio frames │    │
│  │                 │         - captureEnded()        │                 │    │
│  │  Processes:     │                                 │  Produces:      │    │
│  │  - VideoFrame   │                                 │  - WebM blob    │    │
│  │    → copyTo()   │                                 │  - VP9 video    │    │
│  │    → raw buffer │                                 │  - Opus audio   │    │
│  │  - AudioData    │                                 │                 │    │
│  │    → Float32[]  │                                 │                 │    │
│  │                 │                                 │                 │    │
│  └─────────────────┘                                 └─────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Capture Worker Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ capture.worker.ts                                                           │
│                                                                             │
│  start(videoStream, audioStream?):                                          │
│                                                                             │
│    ┌───────────────────────────────────────────────────────────────────┐    │
│    │  VIDEO CAPTURE (main loop)                                        │    │
│    │                                                                   │    │
│    │  while (capturing) {                                              │    │
│    │    const { value: frame } = await videoReader.read()              │    │
│    │                                                                   │    │
│    │    // Copy to raw buffer immediately                              │    │
│    │    const buffer = new ArrayBuffer(frame.allocationSize())         │    │
│    │    await frame.copyTo(buffer)                                     │    │
│    │    frame.close()                                                  │    │
│    │                                                                   │    │
│    │    // Send to muxer via MessagePort RPC                           │    │
│    │    muxer.addVideoFrame({                                          │    │
│    │      buffer,                                                      │    │
│    │      format,                                                      │    │
│    │      codedWidth, codedHeight,                                     │    │
│    │      timestamp: (frame.timestamp - firstTimestamp) / 1_000_000    │    │
│    │    })                                                             │    │
│    │  }                                                                │    │
│    │                                                                   │    │
│    └───────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│    ┌───────────────────────────────────────────────────────────────────┐    │
│    │  AUDIO CAPTURE (parallel async)                                   │    │
│    │                                                                   │    │
│    │  while (capturing) {                                              │    │
│    │    const { value: audioData } = await audioReader.read()          │    │
│    │                                                                   │    │
│    │    // Handle both planar and interleaved formats                  │    │
│    │    if (format.endsWith('-planar')) {                              │    │
│    │      // Copy each channel separately                              │    │
│    │      for (ch = 0; ch < channels; ch++) {                          │    │
│    │        audioData.copyTo(channelData, { planeIndex: ch })          │    │
│    │      }                                                            │    │
│    │    } else {                                                       │    │
│    │      // Deinterleave from plane 0                                 │    │
│    │      audioData.copyTo(tempBuffer, { planeIndex: 0 })              │    │
│    │      // Split interleaved → per-channel Float32Array              │    │
│    │    }                                                              │    │
│    │    audioData.close()                                              │    │
│    │                                                                   │    │
│    │    muxer.addAudioFrame({ data, sampleRate, timestamp })           │    │
│    │  }                                                                │    │
│    │                                                                   │    │
│    └───────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Muxer Worker Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ muxer.worker.ts + muxer.ts (mediabunny)                                     │
│                                                                             │
│  preInit():                                                                 │
│    - Creates VP9 VideoSampleSource (2 Mbps)                                 │
│    - Creates Opus AudioSampleSource (128 kbps)                              │
│    - Initializes WebM output format                                         │
│                                                                             │
│  addVideoFrame({ buffer, format, width, height, timestamp }):               │
│    1. Queue frame data                                                      │
│    2. processVideoQueue():                                                  │
│         - new VideoFrame(buffer, { format, width, height, timestamp })      │
│         - new VideoSample(frame)                                            │
│         - await videoSource.add(sample)                                     │
│         - frame.close()                                                     │
│                                                                             │
│  addAudioFrame({ data, sampleRate, timestamp }):                            │
│    1. Queue audio data                                                      │
│    2. processAudioQueue():                                                  │
│         - Concatenate channels (planar format)                              │
│         - new AudioData({ format: 'f32-planar', ... })                      │
│         - new AudioSample(audioData)                                        │
│         - await audioSource.add(sample)                                     │
│         - audioData.close()                                                 │
│                                                                             │
│  finalize():                                                                │
│    1. Drain video and audio queues                                          │
│    2. await videoSource.close()                                             │
│    3. await audioSource.close()                                             │
│    4. await output.finalize()                                               │
│    5. return { blob: bufferTarget.buffer, frameCount }                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Compositor Worker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ compositor.worker.ts                                                        │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Two Canvas Architecture                                            │    │
│  │                                                                     │    │
│  │  ┌─────────────────────┐      ┌─────────────────────┐               │    │
│  │  │   Main Canvas       │      │   Capture Canvas    │               │    │
│  │  │   (visible)         │      │   (hidden)          │               │    │
│  │  │                     │      │                     │               │    │
│  │  │  - OffscreenCanvas  │      │  - OffscreenCanvas  │               │    │
│  │  │  - WebGL2 context   │      │  - WebGL2 context   │               │    │
│  │  │  - 4 textures       │      │  - 4 textures       │               │    │
│  │  │                     │      │                     │               │    │
│  │  │  Used for:          │      │  Used for:          │               │    │
│  │  │  - Live display     │      │  - Pre-rendering    │               │    │
│  │  │  - playbackFrames   │      │  - captureFrame()   │               │    │
│  │  │  - previewFrames    │      │                     │               │    │
│  │  │                     │      │                     │               │    │
│  │  └─────────────────────┘      └─────────────────────┘               │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Frame Sources:                                                             │
│                                                                             │
│    playbackFrames[4]  - Set via setFrame(index, VideoFrame)                 │
│                         Transferred from main thread per-frame              │
│                                                                             │
│    previewFrames[4]   - Set via setPreviewStream(index, ReadableStream)     │
│                         Continuously read in background loop                │
│                         Latest frame always available                       │
│                                                                             │
│  Rendering:                                                                 │
│                                                                             │
│    render():                                                                │
│      1. Clear canvas with dark background                                   │
│      2. Draw playbackFrames (background layer)                              │
│      3. Draw previewFrames (overlay layer)                                  │
│      4. Each frame: texImage2D → viewport → drawArrays                      │
│                                                                             │
│  WebGL Shader:                                                              │
│                                                                             │
│    precision mediump float;                                                 │
│    uniform sampler2D u_video;                                               │
│    varying vec2 v_uv;                                                       │
│    void main() {                                                            │
│      vec2 uv = v_uv * 0.5 + 0.5;                                            │
│      uv.y = 1.0 - uv.y;  // Flip Y for video                                │
│      gl_FragColor = texture2D(u_video, uv);                                 │
│    }                                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Worker Communication (RPC)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ @bigmistqke/rpc/messenger                                                    │
│                                                                              │
│  Main Thread                           Worker Thread                         │
│  ───────────                           ─────────────                         │
│                                                                              │
│  const worker = rpc<Methods>(          expose(methods)                       │
│    new Worker()                                                              │
│  )                                                                           │
│                                                                              │
│  // Call methods directly               // Methods are called via postMessage│
│  await worker.someMethod(arg)          const methods = {                     │
│                                          someMethod(arg) { ... }             │
│                                        }                                     │
│                                                                              │
│  // Transfer ownership                  // Receives transferred data         │
│  worker.setFrame(                                                            │
│    transfer(videoFrame)                                                      │
│  )                                                                           │
│                                                                              │
│  // Worker-to-Worker via MessageChannel                                      │
│  const channel = new MessageChannel()                                        │
│  workerA.setPort(transfer(channel.port1))                                    │
│  workerB.setPort(transfer(channel.port2))                                    │
│                                                                              │
│  // Worker A can now call Worker B directly                                  │
│  const rpcToB = rpc<BMethodsBethods>(port)                                   │
│  rpcToB.methodOnB(data)                                                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## State Management

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SolidJS Reactivity in Eddy                                                  │
│                                                                             │
│  create-editor.ts                                                           │
│  ─────────────────                                                          │
│                                                                             │
│  Project Store (createStore):                                               │
│    [project, setProject] = deepResource(...)                                │
│    - Tracks, clips, audio effects                                           │
│    - Fetched from AT Protocol when rkey provided                            │
│    - Fine-grained reactivity per property                                   │
│                                                                             │
│  Local State (createSignal):                                                │
│    - selectedTrackIndex: number | null                                      │
│    - masterVolume: number                                                   │
│                                                                             │
│  Local Clips Store (createStore):                                           │
│    [localClips, setLocalClips] = createStore({})                            │
│    - Blobs from recordings (not persisted until publish)                    │
│                                                                             │
│  Resource Map (createResourceMap):                                          │
│    stemBlobs = createResourceMap(clips, fetchStem)                          │
│    - Fine-grained loading per clipId                                        │
│    - Fetched from PDS when clip has stem reference                          │
│                                                                             │
│  Actions (action utility):                                                  │
│    previewAction = action(async (trackIndex, { onCleanup }) => ...)         │
│    recordAction = action(function* (trackIndex, { onCleanup }) => ...)      │
│    publishAction = action(async () => ...)                                  │
│                                                                             │
│    - Automatic pending/error state                                          │
│    - Generator support with defer() and hold()                              │
│    - Cleanup on cancel/clear/replace                                        │
│                                                                             │
│  Effects (whenEffect from solid-whenever):                                  │
│    whenEffect(player, player => {                                           │
│      // Only runs when player is truthy                                     │
│      // Cleans up automatically                                             │
│    })                                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## AT Protocol Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ AT Protocol Data Flow                                                       │
│                                                                             │
│  Lexicons (lexicons/):                                                      │
│    app.eddy.project - Project record with tracks, clips, effects            │
│    app.eddy.stem    - Media blob reference                                  │
│                                                                             │
│  Publishing Flow:                                                           │
│                                                                             │
│    1. Upload clip blobs to PDS                                              │
│       agent.uploadBlob(blob) ──▶ { cid, size }                              │
│                                                                             │
│    2. Create stem records for each clip                                     │
│       agent.com.atproto.repo.createRecord({                                 │
│         repo: did,                                                          │
│         collection: 'app.eddy.stem',                                        │
│         record: { blob: blobRef, mimeType, ... }                            │
│       }) ──▶ { uri, cid }                                                   │
│                                                                             │
│    3. Create project record with stem references                            │
│       agent.com.atproto.repo.createRecord({                                 │
│         repo: did,                                                          │
│         collection: 'app.eddy.project',                                     │
│         record: {                                                           │
│           tracks: [{                                                        │
│             clips: [{                                                       │
│               stem: { uri: stemUri, cid: stemCid }                          │
│             }]                                                              │
│           }]                                                                │
│         }                                                                   │
│       })                                                                    │
│                                                                             │
│  Loading Flow:                                                              │
│                                                                             │
│    1. Fetch project by rkey                                                 │
│       getProjectByRkey(agent, rkey, handle)                                 │
│                                                                             │
│    2. For each clip with stem reference:                                    │
│       getStemBlob(agent, stemUri) ──▶ Blob                                  │
│                                                                             │
│    3. Load blob into player                                                 │
│       player.loadClip(trackIndex, blob)                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Raw Buffer Storage for Video Frames

VideoFrames are hardware-backed and can become stale. The frame buffer stores raw ArrayBuffer data and creates fresh VideoFrames on-demand:

```
VideoFrame (from decoder) → copyTo(ArrayBuffer) → close()
                                    │
                         stored in FrameBuffer
                                    │
                    new VideoFrame(buffer) → transfer to compositor
```

### 2. Ring Buffer for Audio

Instead of scheduling individual AudioBufferSourceNodes, audio uses a SharedArrayBuffer ring buffer:

- Main thread writes decoded samples to ring buffer
- AudioWorkletProcessor reads samples at exact audio rate
- Lock-free synchronization via Atomics
- Eliminates gaps and overlaps from chunk scheduling

### 3. Worker-Based Architecture

Heavy processing happens in workers:

- **Demux Worker**: WebM parsing (avoids blocking main thread)
- **Compositor Worker**: WebGL rendering (OffscreenCanvas)
- **Capture Worker**: Frame capture from camera streams
- **Muxer Worker**: VP9/Opus encoding (mediabunny)

Workers communicate via MessageChannel RPC for direct data transfer.

### 4. Generator-Based Actions

Recording uses generator functions for clean async composition:

```typescript
const recordAction = action(function* (trackIndex, { onCleanup }) {
  const stream = yield* defer(getUserMedia(...))
  onCleanup(() => stream.stop())

  yield* defer(player.play(0))

  return hold(() => recordingInfo)  // Wait for cancel
})
```

This allows:

- Automatic cleanup on cancel/error
- Composition of async operations
- Clear ownership semantics

### 5. Fine-Grained Reactivity

SolidJS's fine-grained reactivity is used throughout:

- `createStore` for project data (path-level updates)
- `createResourceMap` for per-clip blob loading
- `whenEffect`/`whenMemo` for null-safe reactive guards
- `mapArray` for per-track effects without recreating all
