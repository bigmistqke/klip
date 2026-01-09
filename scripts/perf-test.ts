#!/usr/bin/env npx tsx
/**
 * Performance test script using Puppeteer
 *
 * Usage:
 *   1. Start the dev server: pnpm dev
 *   2. Run this script: npx tsx scripts/perf-test.ts
 *
 * Options:
 *   --url=<url>        App URL (default: http://127.0.0.1:5173)
 *   --duration=<ms>    How long to run playback test (default: 10000)
 *   --headless         Run in headless mode
 *   --video=<path>     Path to test video file (will be loaded into all 4 tracks)
 *   --tracks=<n>       Number of tracks to load (1-4, default: 4)
 */

import puppeteer, { type Browser, type Page } from 'puppeteer'
import * as fs from 'fs'
import * as path from 'path'

// Parse CLI args
const args = process.argv.slice(2)
const getArg = (name: string, defaultValue: string): string => {
  const arg = args.find(a => a.startsWith(`--${name}=`))
  return arg ? arg.split('=')[1] : defaultValue
}
const hasFlag = (name: string): boolean => args.includes(`--${name}`)

const APP_URL = getArg('url', 'http://127.0.0.1:5173')
const DURATION = parseInt(getArg('duration', '10000'), 10)
const HEADLESS = hasFlag('headless')
const VIDEO_PATH = getArg('video', '')
const NUM_TRACKS = Math.min(4, Math.max(1, parseInt(getArg('tracks', '4'), 10)))

interface PerfStats {
  samples: number
  avg: number
  max: number
  min: number
  overThreshold: number
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForSelector(page: Page, selector: string, timeout = 10000): Promise<void> {
  await page.waitForSelector(selector, { timeout })
}

async function main() {
  console.log('🚀 Starting performance test...')
  console.log(`   URL: ${APP_URL}`)
  console.log(`   Duration: ${DURATION}ms`)
  console.log(`   Headless: ${HEADLESS}`)
  console.log(`   Video: ${VIDEO_PATH || '(required - use --video=<path>)'}`)
  console.log(`   Tracks: ${NUM_TRACKS}`)
  console.log('')

  if (!VIDEO_PATH || !fs.existsSync(VIDEO_PATH)) {
    console.error('❌ Error: --video=<path> is required')
    console.error('   Please provide a path to a test video file (WebM or MP4)')
    console.error('')
    console.error('   Example: pnpm perf --video=test-clip.webm')
    process.exit(1)
  }

  let browser: Browser | null = null

  try {
    // Launch browser with permissions for camera/mic
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: [
        '--use-fake-ui-for-media-stream', // Auto-allow camera/mic
        '--use-fake-device-for-media-stream', // Use fake video/audio
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security', // For local testing
        '--allow-file-access-from-files',
      ],
      defaultViewport: { width: 1280, height: 720 },
    })

    const page = await browser.newPage()

    // Grant camera/microphone permissions
    const context = browser.defaultBrowserContext()
    await context.overridePermissions(APP_URL, [
      'camera',
      'microphone',
    ])

    // Enable console logging from the page
    page.on('console', msg => {
      const text = msg.text()
      // Show debug logs from our modules
      if (
        text.includes('[player]') ||
        text.includes('[editor]') ||
        text.includes('[playback-worker]') ||
        text.includes('Performance') ||
        text.includes('perf') ||
        text.includes('Error') ||
        text.includes('error')
      ) {
        console.log(`[page:${msg.type()}] ${text}`)
      }
    })

    // Navigate to editor
    console.log('📍 Navigating to editor...')
    await page.goto(`${APP_URL}/editor`, { waitUntil: 'networkidle0' })

    // Wait for player and editor to initialize (may take a few seconds for canvas resource)
    console.log('⏳ Waiting for player and editor to initialize...')
    await page.waitForFunction(
      () => !!(window as any).__EDDY_DEBUG__?.player && !!(window as any).__EDDY_DEBUG__?.editor,
      { timeout: 30000 },
    )

    // Read video file and convert to base64
    console.log('📼 Loading test video file...')
    const videoBuffer = fs.readFileSync(VIDEO_PATH)
    const videoBase64 = videoBuffer.toString('base64')
    const mimeType = VIDEO_PATH.endsWith('.mp4') ? 'video/mp4' : 'video/webm'

    // Load video into each track using the editor (which properly updates project + player)
    console.log(`📥 Loading video into ${NUM_TRACKS} tracks...`)

    for (let trackIndex = 0; trackIndex < NUM_TRACKS; trackIndex++) {
      const trackId = `track-${trackIndex}`
      console.log(`   Track ${trackIndex + 1}/${NUM_TRACKS} (${trackId})...`)

      await page.evaluate(
        async (base64: string, mime: string, id: string) => {
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          const blob = new Blob([bytes], { type: mime })
          const editor = (window as any).__EDDY_DEBUG__?.editor
          if (editor) {
            // Use editor.loadTestClip to properly add clip to project + player
            // Duration is estimated, will be corrected when player loads the clip
            editor.loadTestClip(id, blob, 5000)
          }
        },
        videoBase64,
        mimeType,
        trackId,
      )

      await sleep(1000) // Wait for clip to load (needs more time for project sync)
    }

    console.log('✅ All clips loaded to project')

    // Wait and check status periodically
    for (let i = 0; i < 10; i++) {
      await sleep(1000)
      const status = await page.evaluate(() => {
        const debug = (window as any).__EDDY_DEBUG__
        const player = debug?.player
        return {
          hasClip0: player?.hasClip?.('track-0'),
          hasClip1: player?.hasClip?.('track-1'),
          isLoading0: player?.isLoading?.('track-0'),
          isLoading1: player?.isLoading?.('track-1'),
        }
      })
      console.log(`⏳ Status check ${i + 1}/10:`, JSON.stringify(status))
      if (status.hasClip0 && status.hasClip1) {
        console.log('✅ Clips ready!')
        break
      }
    }

    const debugInfo = await page.evaluate(() => {
      const debug = (window as any).__EDDY_DEBUG__
      const project = debug?.editor?.project()
      const player = debug?.player
      return {
        trackCount: project?.tracks?.length ?? 0,
        tracks: project?.tracks?.map((t: any) => ({
          id: t.id,
          clipCount: t.clips?.length ?? 0,
          firstClipId: t.clips?.[0]?.id,
        })) ?? [],
        hasClip0: player?.hasClip?.('track-0') ?? 'no hasClip',
        hasClip1: player?.hasClip?.('track-1') ?? 'no hasClip',
        isLoading0: player?.isLoading?.('track-0') ?? 'no isLoading',
        isLoading1: player?.isLoading?.('track-1') ?? 'no isLoading',
      }
    })
    console.log('🔍 Debug info:', JSON.stringify(debugInfo, null, 2))

    // Reset perf counters before test (main + workers)
    console.log('🔄 Resetting perf counters...')
    await page.evaluate(async () => {
      const player = (window as any).__EDDY_DEBUG__?.player
      if (player?.resetPerf) {
        player.resetPerf()
      } else if ((window as any).eddy?.perf) {
        ;(window as any).eddy.perf.reset()
      }
    })

    // Start playback using debug interface
    console.log('▶️  Starting playback...')
    await page.evaluate(async () => {
      const player = (window as any).__EDDY_DEBUG__?.player
      if (player) {
        await player.play(0)
      }
    })

    // Let it play for the specified duration
    console.log(`⏱️  Running for ${DURATION}ms...`)
    await sleep(DURATION)

    // Stop playback
    console.log('⏹️  Stopping playback...')
    await page.evaluate(async () => {
      const player = (window as any).__EDDY_DEBUG__?.player
      if (player) {
        await player.stop()
      }
    })

    // Collect perf stats (main + workers)
    console.log('📊 Collecting performance stats...')
    const stats = await page.evaluate(async () => {
      const player = (window as any).__EDDY_DEBUG__?.player
      const perf = (window as any).eddy?.perf

      if (player?.getAllPerf) {
        // New API: get main + worker stats
        const allStats = await player.getAllPerf()
        return {
          stats: allStats.main,
          workers: allStats.workers,
          counters: perf?.getCounters() ?? {},
        }
      } else if (perf) {
        // Legacy API: main thread only
        return {
          stats: perf.getAllStats(),
          workers: {},
          counters: perf.getCounters(),
        }
      }
      return null
    })

    if (stats?.stats) {
      console.log('')
      console.log('═══════════════════════════════════════════════════════════════')
      console.log('                    PERFORMANCE RESULTS')
      console.log('═══════════════════════════════════════════════════════════════')
      console.log('')

      // Sort by average time (descending)
      const sortedLabels = Object.keys(stats.stats).sort(
        (a, b) => stats.stats[b].avg - stats.stats[a].avg
      )

      // Table header
      console.log(
        '  Label                        │ Avg (ms) │ Max (ms) │ Min (ms) │ Samples │ Slow  │ Slow %'
      )
      console.log(
        '───────────────────────────────┼──────────┼──────────┼──────────┼─────────┼───────┼────────'
      )

      for (const label of sortedLabels) {
        const s: PerfStats = stats.stats[label]
        const slowPercent = ((s.overThreshold / s.samples) * 100).toFixed(1)
        console.log(
          `  ${label.padEnd(29)} │ ${s.avg.toFixed(2).padStart(8)} │ ${s.max.toFixed(2).padStart(8)} │ ${s.min.toFixed(2).padStart(8)} │ ${String(s.samples).padStart(7)} │ ${String(s.overThreshold).padStart(5)} │ ${slowPercent.padStart(5)}%`
        )
      }

      console.log('')
      console.log('═══════════════════════════════════════════════════════════════')

      // Worker stats
      if (stats.workers && Object.keys(stats.workers).length > 0) {
        console.log('')
        console.log('───────────────────────────────────────────────────────────────')
        console.log('                     WORKER STATS (per track)')
        console.log('───────────────────────────────────────────────────────────────')

        for (const [trackId, workerStats] of Object.entries(stats.workers)) {
          const ws = workerStats as Record<string, PerfStats>
          if (Object.keys(ws).length === 0) continue

          console.log('')
          console.log(`  Track: ${trackId}`)
          console.log('  Label                        │ Avg (ms) │ Max (ms) │ Samples │ Slow %')
          console.log('  ─────────────────────────────┼──────────┼──────────┼─────────┼────────')

          const sortedLabels = Object.keys(ws).sort((a, b) => ws[b].avg - ws[a].avg)
          for (const label of sortedLabels) {
            const s = ws[label]
            const slowPercent = ((s.overThreshold / s.samples) * 100).toFixed(1)
            console.log(
              `  ${label.padEnd(29)} │ ${s.avg.toFixed(2).padStart(8)} │ ${s.max.toFixed(2).padStart(8)} │ ${String(s.samples).padStart(7)} │ ${slowPercent.padStart(5)}%`
            )
          }
        }

        console.log('')
        console.log('═══════════════════════════════════════════════════════════════')
      }

      // Summary
      const renderLoop = stats.stats['renderLoop']
      if (renderLoop) {
        const fps = 1000 / renderLoop.avg
        const droppedPercent = (renderLoop.overThreshold / renderLoop.samples) * 100
        console.log('')
        console.log(`  📈 Effective FPS: ${fps.toFixed(1)}`)
        console.log(`  ⚠️  Dropped frames: ${renderLoop.overThreshold} (${droppedPercent.toFixed(1)}%)`)
        console.log(`  ⏱️  Avg frame time: ${renderLoop.avg.toFixed(2)}ms`)
        console.log(`  📉 Worst frame: ${renderLoop.max.toFixed(2)}ms`)
        console.log('')

        if (droppedPercent > 10) {
          console.log('  ❌ POOR: More than 10% dropped frames')
        } else if (droppedPercent > 5) {
          console.log('  ⚠️  FAIR: 5-10% dropped frames')
        } else if (droppedPercent > 1) {
          console.log('  ✅ GOOD: Less than 5% dropped frames')
        } else {
          console.log('  🎯 EXCELLENT: Less than 1% dropped frames')
        }
      }

      // Display counters
      if (stats.counters && Object.keys(stats.counters).length > 0) {
        console.log('')
        console.log('───────────────────────────────────────────────────────────────')
        console.log('                         COUNTERS')
        console.log('───────────────────────────────────────────────────────────────')
        console.log('')

        const counters = stats.counters as Record<string, number>
        const sortedCounters = Object.entries(counters).sort((a, b) => b[1] - a[1])

        for (const [label, value] of sortedCounters) {
          console.log(`  ${label.padEnd(30)} │ ${String(value).padStart(8)}`)
        }

        // Calculate cache hit rate
        const cacheHits = counters['cache-hit'] ?? 0
        const cacheMisses = counters['cache-miss'] ?? 0
        const totalCacheAccess = cacheHits + cacheMisses
        if (totalCacheAccess > 0) {
          const hitRate = (cacheHits / totalCacheAccess) * 100
          console.log('')
          console.log(`  📊 Cache hit rate: ${hitRate.toFixed(1)}% (${cacheHits}/${totalCacheAccess})`)

          if (hitRate < 90) {
            console.log('  ⚠️  Low cache hit rate - frames being evicted before use')
          }
        }

        // Check per-track frame misses
        const frameMisses: number[] = []
        for (let i = 0; i < 4; i++) {
          frameMisses.push(counters[`frame-miss-${i}`] ?? 0)
        }
        const totalMisses = frameMisses.reduce((a, b) => a + b, 0)
        if (totalMisses > 0) {
          console.log('')
          console.log(`  🎬 Frame misses by track: [${frameMisses.join(', ')}]`)
          console.log('  ⚠️  Frame misses cause visual jank!')
        }
      }
    } else {
      console.log('❌ Could not collect perf stats - window.eddy.perf not found')
    }

    // Also log to page console for the summary
    await page.evaluate(() => {
      if ((window as any).eddy?.perf) {
        ;(window as any).eddy.perf.logSummary()
      }
    })

  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  } finally {
    if (browser) {
      await browser.close()
    }
  }

  console.log('')
  console.log('✅ Performance test complete!')
}

main()
