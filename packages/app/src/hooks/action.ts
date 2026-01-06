import { createSignal, type Accessor } from 'solid-js'
import { assertedNotNullish, isGeneratorFunction, isObject } from '~/utils'

/** Symbol to identify hold marker */
export const $HOLD = Symbol('hold')
export const $CLEANUP = Symbol('cleanup')

/** Hold marker type */
interface HoldMarker<T> {
  [$HOLD]: true
  getValue: () => T
}

export interface ActionContext {
  signal: AbortSignal
  /** Register a cleanup function to be called when action is cancelled/cleared/replaced */
  onCleanup: (fn: () => void) => void
}

/** Generator that yields promises and returns R (or HoldMarker<R>) */
export type ActionGenerator<R> = Generator<Promise<unknown>, R | HoldMarker<R>, unknown>

/** Async function fetcher */
export type AsyncFetcher<T, R> = (args: T, context: ActionContext) => Promise<R | HoldMarker<R>>

/** Generator function fetcher - yields promises, runner awaits with abort checks */
export type GeneratorFetcher<T, R> = (args: T, context: ActionContext) => ActionGenerator<R>

/** Either async or generator fetcher */
export type ActionFetcher<T, R> = AsyncFetcher<T, R> | GeneratorFetcher<T, R>

export type ActionFn<T, R> = [T] extends [undefined] ? () => Promise<R> : (args: T) => Promise<R>

export type TryFn<T, R> = [T] extends [undefined]
  ? () => Promise<R | undefined>
  : (args: T) => Promise<R | undefined>

export type Action<T, R> = ActionFn<T, R> & {
  /** Whether the action is currently running */
  pending: Accessor<boolean>
  /** The result of the last successful invocation */
  latest: Accessor<R | undefined>
  /** Any error from the last invocation */
  error: Accessor<unknown>
  /** Cancel the current invocation */
  cancel: () => void
  /** Clear the result and error */
  clear: () => void
  /** Call the action without throwing - returns undefined on error */
  try: TryFn<T, R>
  /** Await the result - waits for completion if pending, returns current result otherwise */
  promise: () => Promise<R | undefined>
}

export interface PromiseWithCleanup<T> extends Promise<T> {
  [$CLEANUP]: (value: T) => void
}

/**********************************************************************************/
/*                                                                                */
/*                                 Internal Utils                                 */
/*                                                                                */
/**********************************************************************************/

/** Check if a value is a hold marker */
function isHoldMarker<T>(value: unknown): value is HoldMarker<T> {
  return isObject(value) && $HOLD in value
}

function isPromiseWithCleanup<T>(value: unknown): value is PromiseWithCleanup<T> {
  return isObject(value) && $CLEANUP in value
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** Run a generator with abort checks between yields */
async function runGenerator<R>(
  gen: ActionGenerator<R>,
  context: ActionContext,
): Promise<R | HoldMarker<R>> {
  let result = gen.next()

  while (!result.done) {
    // Check abort before awaiting
    if (context.signal.aborted) {
      throw new CancelledError()
    }

    const promise = result.value

    if (isPromiseWithCleanup(promise)) {
      const cleanup = promise[$CLEANUP]
      context.onCleanup(async () => cleanup(await promise))
    }

    // Normal promise - await it
    const value = await result.value

    // Check abort after awaiting
    if (context.signal.aborted) {
      throw new CancelledError()
    }

    result = gen.next(value)
  }

  return result.value
}

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

export class CancelledError extends Error {
  constructor() {
    super('Action was cancelled')
    this.name = 'CancelledError'
  }
}

/**
 * Wrap a promise for use with yield* in generator actions.
 * Provides proper typing for the resolved value.
 *
 * @example
 * const data = yield* defer(fetch('/api').then(r => r.json()))
 * const stream = yield* defer(getUserMedia())
 */
export function* defer<T>(
  promise: Promise<T>,
  onCleanup?: (value: T) => void,
): Generator<Promise<T> | PromiseWithCleanup<T>, T, T> {
  if (onCleanup) {
    ;(promise as PromiseWithCleanup<T>)[$CLEANUP] = onCleanup
  }
  return (yield promise) as T
}

/**
 * Hold until the action is cancelled, then return the value.
 * Use this for "run until cancelled" actions that should resolve (not throw) on cancel.
 * Always the last statement - no code runs after cancellation.
 *
 * @example
 * // With return value
 * return hold(() => ({ trackIndex, duration }))
 *
 * // Void action (no return value)
 * return hold()
 */
export function hold<T = void>(getValue?: () => T): HoldMarker<T> {
  return { [$HOLD]: true, getValue: getValue ?? (() => undefined as T) }
}

/**********************************************************************************/
/*                                                                                */
/*                                      Utils                                     */
/*                                                                                */
/**********************************************************************************/

/**
 * Creates an async action that can be called directly and awaited.
 *
 * Supports two styles:
 * 1. Async function: `action(async (args, ctx) => { ... })`
 * 2. Generator function: `action(function* (args, ctx) { yield* defer(promise); ... })`
 *
 * Generator style automatically checks for abort between yields.
 *
 * @example
 * ```ts
 * // Basic usage with defer() for typed async operations
 * const fetchUser = action(function* () {
 *   const response = yield* defer(fetch('/api/user'))
 *   return yield* defer(response.json())
 * })
 *
 * // With cleanup using onCleanup
 * const record = action(function* (trackIndex: number, { onCleanup }) {
 *   const stream = yield* defer(navigator.mediaDevices.getUserMedia({ video: true }))
 *   onCleanup(() => stream.getTracks().forEach(t => t.stop()))
 *
 *   // defer() not needed if you don't need type inference or cleanup
 *   yield startRecording(stream)
 * })
 *
 * // With hold() - runs until cancelled, then returns value
 * const record = action(function* (trackIndex: number, { onCleanup }) {
 *   const stream = yield* defer(navigator.mediaDevices.getUserMedia({ video: true }))
 *   onCleanup(() => stream.getTracks().forEach(t => t.stop()))
 *
 *   const startTime = performance.now()
 *   // Hold until action.cancel() is called
 *   return hold(() => ({ trackIndex, duration: performance.now() - startTime }))
 * })
 *
 * // Usage
 * record(0)                              // Start recording
 * record.pending()                       // true while running
 * record.cancel()                        // Stop and trigger cleanup
 * const result = await record.promise()  // Get return value from hold()
 * ```
 */
export function action<T = undefined, R = void>(fetcher: ActionFetcher<T, R>): Action<T, R> {
  const [pending, setPending] = createSignal(false)
  const [latest, setResult] = createSignal<R | undefined>(undefined)
  const [error, setError] = createSignal<unknown>(undefined)

  let abortController: AbortController | null = null
  let cleanupFns: (() => void)[] = []
  let currentPromise: Promise<R> | null = null
  const { promise: initialPromise, resolve: resolveInitial } = Promise.withResolvers<void>()

  function registerCleanup(fn: () => void) {
    cleanupFns.push(fn)
  }

  function cleanup() {
    for (const fn of cleanupFns) {
      try {
        fn()
      } catch (e) {
        console.error('Cleanup error:', e)
      }
    }
    cleanupFns = []

    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  function cancel() {
    cleanup()
    setPending(false)
  }

  function clear() {
    cleanup()
    setPending(false)
    setResult(undefined)
    setError(undefined)
  }

  function createContext(signal: AbortSignal): ActionContext {
    return {
      signal,
      onCleanup: registerCleanup,
    }
  }

  async function actionFn(args?: T): Promise<R> {
    cleanup()

    abortController = new AbortController()
    const { signal } = abortController
    const context = createContext(signal)

    setPending(true)
    setError(undefined)

    const promise = (async () => {
      try {
        let value: R | HoldMarker<R>

        if (isGeneratorFunction<GeneratorFetcher<T, R>>(fetcher)) {
          value = await runGenerator(fetcher(args as T, context), context)
        } else {
          const promise = fetcher(args as T, context)
          if (isPromiseWithCleanup(promise)) {
            const cleanup = promise[$CLEANUP]
            context.onCleanup(async () => cleanup(await promise))
          }
          value = await promise
        }

        // Check if return value is a hold marker
        if (isHoldMarker(value)) {
          await waitForAbort(signal)
          value = value.getValue()
        }

        setResult(() => value)
        resolveInitial()
        return value
      } catch (err) {
        // If runGenerator threw CancelledError, re-throw it
        if (err instanceof CancelledError) {
          throw err
        }
        console.error(err)
        setError(err)
        throw err
      } finally {
        setPending(false)
      }
    })()

    currentPromise = promise
    return promise
  }

  async function tryAction(args?: T): Promise<R | undefined> {
    try {
      return await actionFn(args)
    } catch {
      return undefined
    }
  }

  async function promise(): Promise<R | undefined> {
    return initialPromise.then(() =>
      assertedNotNullish(currentPromise!, 'Current Promise is undefined'),
    )
  }

  return Object.assign(actionFn, {
    pending,
    latest,
    error,
    cancel,
    clear,
    try: tryAction,
    promise,
  }) as Action<T, R>
}
