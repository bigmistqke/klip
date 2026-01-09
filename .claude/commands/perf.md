---
description: Run performance tests and track results over time
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: [--headless] [--duration=ms] [--tracks=n]
---

# Performance Test Runner

Runs the Puppeteer-based performance test and tracks results.

## Prerequisites

The dev server must be running on port 5173 (or specify --url).

```bash
# Check if dev server is running
curl -s http://127.0.0.1:5173 > /dev/null && echo "✓ Dev server running" || echo "✗ Dev server not running"
```

**If dev server is not running, inform user and stop.**

## Step 1: Run Performance Test

```bash
# Run perf test (pass through any arguments from $ARGUMENTS)
pnpm perf $ARGUMENTS
```

**Note:** The script has a built-in timeout via Puppeteer's waitFor functions.

## Step 2: Handle Results

### If test FAILS:

1. **Check common failure modes:**
   - Dev server not running → tell user to run `pnpm dev`
   - Video file not found → check fixture path exists
   - Timeout → browser or page load issue
   - WebGL error → check compositor.worker.ts
   - `__EDDY_DEBUG__` not found → check debug exports in player/editor

2. **Investigate the specific error:**
   ```bash
   # Check if the video fixture exists
   ls -la packages/codecs/src/__tests__/fixtures/

   # Check for recent changes that might have broken things
   git diff --stat HEAD~3
   ```

3. **Fix the issue if possible**, or report what needs manual intervention.

### If test SUCCEEDS:

1. **Parse the output** for key metrics:
   - Effective FPS
   - Dropped frames %
   - Avg frame time
   - Worst frame time
   - Per-track worker stats

2. **Append to performance log:**

   Create/update `docs/PERF-LOG.md` with a new entry:

   ```markdown
   ## [DATE] - [COMMIT SHORT HASH]

   **Config:** tracks=N, duration=Xms, video=Y

   | Metric | Value |
   |--------|-------|
   | Effective FPS | X.X |
   | Dropped frames | X.X% |
   | Avg frame time | X.XXms |
   | Worst frame | X.XXms |

   **Rating:** EXCELLENT / GOOD / FAIR / POOR

   **Notes:** (any observations about this run)
   ```

3. **Compare with previous run** (if exists):
   - FPS improved/degraded?
   - Dropped frames better/worse?
   - Any new bottlenecks?

## Step 3: Summary

Report to user:
- Test passed/failed
- Key metrics
- Comparison with last run (if available)
- Any recommendations

## Perf Log Location

Results are tracked in `docs/PERF-LOG.md` - append new entries at the top (newest first, after header).

## Quick Reference

```bash
# Basic run (4 tracks, 10s, headed)
pnpm perf

# Headless mode (CI)
pnpm perf --headless

# Custom duration
pnpm perf --duration=30000

# Fewer tracks (isolate issues)
pnpm perf --tracks=1

# All-keyframe video (faster decode)
pnpm perf --video=packages/codecs/src/__tests__/fixtures/test-vp9-all-keyframe.webm
```
