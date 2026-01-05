import { createSignal, type Accessor } from 'solid-js'

export class CancelledError extends Error {
  constructor() {
    super('Action was cancelled')
    this.name = 'CancelledError'
  }
}

/** Symbol to identify hold marker */
const HOLD = Symbol('hold')

/** Hold marker type */
interface HoldMarker<T> {
  [HOLD]: true
  getValue: () => T
}

export interface ActionContext {
  signal: AbortSignal
  /** Register a cleanup function to be called when action is cancelled/cleared/replaced */
  onCleanup: (fn: () => void) => void
}

/** Generator that yields promises and returns R (or HoldMarker<R>) */
export type ActionGenerator<R> = Generator<Promise<unknown>, R | HoldMarker<R>, unknown>

/**
 * Wrap a promise for use with yield* in generator actions.
 * Provides proper typing for the resolved value.
 *
 * @example
 * const data = yield* defer(fetch('/api').then(r => r.json()))
 * const stream = yield* defer(getUserMedia())
 */
export function* defer<T>(promise: Promise<T>): Generator<Promise<T>, T, T> {
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
  return { [HOLD]: true, getValue: getValue ?? (() => undefined as T) }
}

/** Async function fetcher */
export type AsyncFetcher<T, R> = (args: T, context: ActionContext) => Promise<R>

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
  result: Accessor<R | undefined>
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

/** Check if a function is a generator function */
function isGeneratorFunction(fn: Function): fn is (...args: any[]) => Generator {
  return fn.constructor.name === 'GeneratorFunction'
}

/** Check if a value is a hold marker */
function isHoldMarker(value: unknown): value is HoldMarker<unknown> {
  return value !== null && typeof value === 'object' && HOLD in value
}

/** Run a generator with abort checks between yields */
async function runGenerator<R>(gen: ActionGenerator<R>, signal: AbortSignal): Promise<R> {
  let result = gen.next()

  while (!result.done) {
    // Check abort before awaiting
    if (signal.aborted) {
      throw new CancelledError()
    }

    // Normal promise - await it
    const value = await result.value

    // Check abort after awaiting
    if (signal.aborted) {
      throw new CancelledError()
    }

    result = gen.next(value)
  }

  // Check if return value is a hold marker
  if (isHoldMarker(result.value)) {
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return result.value.getValue() as R
  }

  return result.value
}

/**
 * Creates an async action that can be called directly and awaited.
 *
 * Supports two styles:
 * 1. Async function: `action(async (args, ctx) => { ... })`
 * 2. Generator function: `action(function* (args, ctx) { yield promise; ... })`
 *
 * Generator style automatically checks for abort between yields.
 * Use `yield* defer(promise)` for typed yields:
 *
 * ```ts
 * const fetchUser = action(function* () {
 *   const response = yield* defer(fetch('/api/user'))
 *   return yield* defer(response.json())
 * })
 * ```
 */
export function action<T = undefined, R = void>(fetcher: ActionFetcher<T, R>): Action<T, R> {
  const [pending, setPending] = createSignal(false)
  const [result, setResult] = createSignal<R | undefined>(undefined)
  const [error, setError] = createSignal<unknown>(undefined)

  let abortController: AbortController | null = null
  let cleanupFns: (() => void)[] = []
  let currentPromise: Promise<R> | null = null

  const isGenerator = isGeneratorFunction(fetcher)

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

  /** Create a bound generator from args and context */
  function createGenerator(args: T, context: ActionContext): ActionGenerator<R> {
    if (isGenerator) {
      return (fetcher as GeneratorFetcher<T, R>)(args, context)
    } else {
      // Wrap async function as single-yield generator
      return (function* () {
        return (yield (fetcher as AsyncFetcher<T, R>)(args, context)) as R
      })()
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
        const gen = createGenerator(args as T, context)
        const value = await runGenerator(gen, signal)

        // If runGenerator completed, the generator finished successfully
        // (either normally, or via hold)
        setResult(() => value)
        return value
      } catch (err) {
        // If runGenerator threw CancelledError, re-throw it
        if (err instanceof CancelledError) {
          throw err
        }
        setError(err)
        throw err
      } finally {
        setPending(false)
        currentPromise = null
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
    if (currentPromise) {
      try {
        return await currentPromise
      } catch {
        return undefined
      }
    }
    return result()
  }

  return Object.assign(actionFn, {
    pending,
    result,
    error,
    cancel,
    clear,
    try: tryAction,
    promise,
  }) as Action<T, R>
}
