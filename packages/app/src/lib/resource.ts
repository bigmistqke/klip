/**
 * Enhanced createResource with proper cleanup support.
 *
 * Solid's onCleanup doesn't work inside async resource fetchers (after await).
 * This wrapper provides an onCleanup callback that properly runs when:
 * - The resource refetches (previous result cleanup)
 * - The component is disposed
 *
 * Also provides AbortController for fetch cancellation.
 */

import {
  createResource,
  onCleanup as solidOnCleanup,
  type InitializedResourceReturn,
  type NoInfer,
  type Resource,
  type ResourceOptions,
  type ResourceReturn,
  type ResourceSource,
} from 'solid-js'

export interface ResourceFetcherInfo<S> {
  /** AbortSignal for cancelling fetches */
  signal: AbortSignal
  /** Register cleanup to run on refetch or disposal */
  onCleanup: (cleanup: () => void) => void
  /** Source value if refetching, false otherwise */
  refetching: S | boolean
}

export type ResourceFetcher<S, T> = (source: S, info: ResourceFetcherInfo<S>) => T | Promise<T>

export type ManagedResourceOptions<T, S> = Omit<ResourceOptions<T, S>, 'storage'> & {
  storage?: ResourceOptions<T, S>['storage']
}

export type ManagedResourceReturn<T, S> = [
  resource: Resource<T>,
  actions: {
    mutate: ResourceReturn<T, S>[1]['mutate']
    refetch: ResourceReturn<T, S>[1]['refetch']
  },
]

export type InitializedManagedResourceReturn<T, S> = [
  resource: InitializedResourceReturn<T>[0],
  actions: {
    mutate: InitializedResourceReturn<T, S>[1]['mutate']
    refetch: InitializedResourceReturn<T, S>[1]['refetch']
  },
]

/** Simple fetcher type for source-less resources */
export type SimpleFetcher<T> = (info?: ResourceFetcherInfo<true>) => T | Promise<T>

/**
 * Creates a resource with proper cleanup and abort support.
 *
 * @example
 * ```ts
 * // With source
 * const [player] = resource(
 *   () => canvas(),
 *   async (canvas, { signal, onCleanup }) => {
 *     const player = await createPlayer(canvas)
 *     onCleanup(() => player.destroy())
 *     return player
 *   }
 * )
 *
 * // Without source
 * const [data] = resource(async ({ signal }) => {
 *   return fetch('/api/data', { signal })
 * })
 * ```
 */
// Overload: fetcher only (no source)
export function resource<T>(
  fetcher: SimpleFetcher<T>,
  options?: ManagedResourceOptions<NoInfer<T>, true>,
): ManagedResourceReturn<T, true>

// Overload: source + fetcher with initialValue
export function resource<T, S = true>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T>,
  options: ManagedResourceOptions<NoInfer<T>, S> & {
    initialValue: T
  },
): InitializedManagedResourceReturn<T, S>

// Overload: source + fetcher
export function resource<T, S = true>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T>,
  options?: ManagedResourceOptions<NoInfer<T>, S>,
): ManagedResourceReturn<T, S>

// Implementation
export function resource<T, S = true>(
  sourceOrFetcher: ResourceSource<S> | SimpleFetcher<T>,
  fetcherOrOptions?: ResourceFetcher<S, T> | ManagedResourceOptions<NoInfer<T>, S>,
  maybeOptions?: ManagedResourceOptions<NoInfer<T>, S>,
): ManagedResourceReturn<T, S> {
  // Normalize arguments: detect if first arg is fetcher (no source)
  let source: ResourceSource<S>
  let fetcher: ResourceFetcher<S, T>
  let options: ManagedResourceOptions<NoInfer<T>, S> | undefined

  if (typeof fetcherOrOptions === 'function') {
    // source + fetcher form
    source = sourceOrFetcher as ResourceSource<S>
    fetcher = fetcherOrOptions
    options = maybeOptions
  } else {
    // fetcher-only form (no source)
    source = true as ResourceSource<S>
    fetcher = ((_, info) =>
      (sourceOrFetcher as SimpleFetcher<T>)(info as ResourceFetcherInfo<true>)) as ResourceFetcher<
      S,
      T
    >
    options = fetcherOrOptions as ManagedResourceOptions<NoInfer<T>, S> | undefined
  }

  let abortController: AbortController | null = null
  let cleanups: (() => void)[] = []

  /** Run all registered cleanups */
  function runCleanups() {
    const toRun = cleanups
    cleanups = []
    for (const cleanup of toRun) {
      try {
        cleanup()
      } catch (e) {
        console.error('Cleanup error:', e)
      }
    }
  }

  // Register cleanup for when component is disposed
  solidOnCleanup(() => {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    runCleanups()
  })

  const wrappedFetcher = async (sourceValue: S, info: { refetching: S | boolean }): Promise<T> => {
    // Abort previous fetch and run cleanups on refetch
    if (info.refetching) {
      if (abortController) {
        abortController.abort()
      }
      runCleanups()
    }

    // Create new abort controller for this fetch
    abortController = new AbortController()
    const { signal } = abortController

    // Collect cleanups for this fetch
    const fetchCleanups: (() => void)[] = []

    try {
      const result = await fetcher(sourceValue, {
        signal,
        onCleanup: (cleanup: () => void) => {
          fetchCleanups.push(cleanup)
        },
        get refetching() {
          return info.refetching
        },
      })

      // Store cleanups only if fetch succeeded
      cleanups = fetchCleanups

      return result
    } catch (e) {
      // Run cleanups on error
      for (const cleanup of fetchCleanups) {
        try {
          cleanup()
        } catch {
          // ignore cleanup errors
        }
      }
      throw e
    } finally {
      // Clear controller when done (unless replaced by new fetch)
      if (abortController?.signal === signal) {
        abortController = null
      }
    }
  }

  return createResource(source, wrappedFetcher, options)
}
