import { createSignal, type Accessor } from 'solid-js'

export class CancelledError extends Error {
  constructor() {
    super('Action was cancelled')
    this.name = 'CancelledError'
  }
}

export interface ActionContext {
  signal: AbortSignal
  /** Register a cleanup function to be called when action is cancelled/cleared/replaced */
  onCleanup: (fn: () => void) => void
  /** Promise that resolves when the action is cancelled - useful for "run until cancelled" actions */
  readonly cancellation: Promise<void>
}

/** Generator that yields promises and returns R */
export type ActionGenerator<R> = Generator<Promise<unknown>, R, unknown>

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
): Generator<Promise<NoInfer<T>>, NoInfer<T>, NoInfer<T>> {
  return (yield promise) as T
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
}

/** Check if a function is a generator function */
function isGeneratorFunction(fn: Function): fn is (...args: any[]) => Generator {
  return fn.constructor.name === 'GeneratorFunction'
}

/** Run a generator with abort checks between yields */
async function runGenerator<R>(gen: ActionGenerator<R>, signal: AbortSignal): Promise<R> {
  let result = gen.next()

  while (!result.done) {
    // Check abort before awaiting
    if (signal.aborted) {
      throw new CancelledError()
    }

    // Await the yielded promise
    const value = await result.value

    // Check abort after awaiting
    if (signal.aborted) {
      throw new CancelledError()
    }

    // Send result back to generator
    result = gen.next(value)
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
    let cancellationPromise: Promise<void> | null = null
    return {
      signal,
      onCleanup: registerCleanup,
      get cancellation() {
        return (cancellationPromise ??= new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        }))
      },
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

    try {
      const gen = createGenerator(args as T, context)
      const value = await runGenerator(gen, signal)

      if (signal.aborted) {
        throw new CancelledError()
      }

      setResult(() => value)
      return value
    } catch (err) {
      if (signal.aborted) {
        throw new CancelledError()
      }
      setError(err)
      throw err
    } finally {
      setPending(false)
    }
  }

  async function tryAction(args?: T): Promise<R | undefined> {
    try {
      return await actionFn(args)
    } catch {
      return undefined
    }
  }

  return Object.assign(actionFn, {
    pending,
    result,
    error,
    cancel,
    clear,
    try: tryAction,
  }) as Action<T, R>
}
