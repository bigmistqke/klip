# @klip/compositor

WebGL video compositing for multi-track rendering.

## Exports

- `createCompositor(width, height)` - Create a 4-track video compositor

## Usage

```ts
import { createCompositor } from '@klip/compositor'

const compositor = createCompositor(1280, 720)
document.body.appendChild(compositor.canvas)

// Set video sources (HTMLVideoElement or VideoFrame)
compositor.setSource(0, videoElement)
compositor.setFrame(1, videoFrame)

// Render to canvas
compositor.render()

compositor.destroy()
```

## Layout

Currently renders a fixed 2x2 grid:
```
┌───────┬───────┐
│   0   │   1   │
├───────┼───────┤
│   2   │   3   │
└───────┴───────┘
```

## Dependencies

- `@bigmistqke/view.gl` - WebGL shader compilation
