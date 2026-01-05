import { createRoot, createSignal, type Accessor } from 'solid-js'

export class CancelledError extends Error {
  constructor() {
    super('Action was cancelled')
    this.name = 'CancelledError'
  }
}

export interface ActionContext {
  signal: AbortSignal
}

export type ActionFetcher<T, R> = (args: T, context: ActionContext) => Promise<R>

export type ActionFn<T, R> = [T] extends [undefined]
  ? () => Promise<R>
  : (args: T) => Promise<R>

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

/**
 * Creates an async action that can be called directly and awaited.
 *
 * - Calling while pending automatically cancels the previous invocation
 * - Cancelled calls reject with CancelledError
 * - Provides `pending`, `result`, and `error` state
 * - Pass `signal` to the fetcher for cancellation support
 */
export function createAction<T = undefined, R = void>(
  fetcher: ActionFetcher<T, R>
): Action<T, R> {
  const [pending, setPending] = createSignal(false)
  const [result, setResult] = createSignal<R | undefined>(undefined)
  const [error, setError] = createSignal<unknown>(undefined)

  let abortController: AbortController | null = null
  let dispose: (() => void) | null = null

  function cleanup() {
    if (dispose) {
      dispose()
      dispose = null
    }
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  function cancel() {
    cleanup()
  }

  function clear() {
    cleanup()
    setResult(undefined)
    setError(undefined)
  }

  async function action(args?: T): Promise<R> {
    // Cleanup any ongoing invocation
    cleanup()

    // Create new abort controller
    abortController = new AbortController()
    const { signal } = abortController

    setPending(true)
    setError(undefined)

    // Run fetcher inside a reactive root so onCleanup works
    const promise = new Promise<R>((resolve, reject) => {
      dispose = createRoot(disposeFn => {
        dispose = disposeFn

        fetcher(args as T, { signal })
          .then(value => {
            if (signal.aborted) {
              reject(new CancelledError())
            } else {
              setResult(() => value)
              resolve(value)
            }
          })
          .catch(err => {
            if (signal.aborted) {
              reject(new CancelledError())
            } else {
              setError(err)
              reject(err)
            }
          })
          .finally(() => {
            if (!signal.aborted) {
              setPending(false)
            }
          })

        return disposeFn
      })
    })

    return promise
  }

  async function tryAction(args?: T): Promise<R | undefined> {
    try {
      return await action(args)
    } catch {
      return undefined
    }
  }

  return Object.assign(action, {
    pending,
    result,
    error,
    cancel,
    clear,
    try: tryAction,
  }) as Action<T, R>
}
