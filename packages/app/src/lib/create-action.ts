import { createSignal, type Accessor } from 'solid-js'

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

  function cancel() {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  function clear() {
    setResult(undefined)
    setError(undefined)
  }

  async function action(args?: T): Promise<R> {
    // Cancel any ongoing invocation
    cancel()

    // Create new abort controller
    abortController = new AbortController()
    const { signal } = abortController

    setPending(true)
    setError(undefined)

    try {
      const value = await fetcher(args as T, { signal })

      // Check if we were cancelled during execution
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
      if (!signal.aborted) {
        setPending(false)
      }
    }
  }

  return Object.assign(action, {
    pending,
    result,
    error,
    cancel,
    clear,
  }) as Action<T, R>
}
