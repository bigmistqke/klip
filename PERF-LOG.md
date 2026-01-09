# Performance Log

Tracking performance metrics over time. Each entry records a perf test run.

---

## 2026-01-09 14:08 - 6296031

**Config:** tracks=4, duration=10000ms, video=test-vp9.webm

| Metric | Value |
|--------|-------|
| Effective FPS | 12254.2 |
| Dropped frames | 0.0% |
| Avg frame time | 0.08ms |
| Worst frame | 2.79ms |

**Worker Stats (avg across 4 tracks):**

| Operation | Avg (ms) | Max (ms) | Slow % |
|-----------|----------|----------|--------|
| bufferAhead | ~10.2 | ~145 | ~7.3% |
| decode | ~8.6 | ~80 | ~5.9% |
| transferFrame | ~0.97 | ~8.7 | 0% |
| demux | ~0.09 | ~6 | 0% |

**Rating:** EXCELLENT

**Notes:**
- First baseline after clip-based playback refactor
- Some RPC errors during clip loading (non-fatal)
- Keyframe decode spikes visible in bufferAhead max (~145ms)
- Per-worker decode ~8.6ms avg suggests room for optimization with all-keyframe video
