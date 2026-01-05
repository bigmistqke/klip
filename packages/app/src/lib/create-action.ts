import { createSignal, type Accessor } from 'solid-js'
import { createCancellableResource, type CancellableResourceFetcher } from './create-cancellable-resource'

export interface ActionContext {
  signal: AbortSignal
}

export type ActionFetcher<T, R> = (args: T, context: ActionContext) => Promise<R>

export interface Action<T, R> {
  /** Call the action with arguments */
  submit: (args: T) => void
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
 * Creates an async action that can be called imperatively.
 * Wraps createCancellableResource for Suspense integration.
 *
 * - Calling `submit()` while pending automatically cancels the previous invocation
 * - Provides `pending`, `result`, and `error` state
 * - Pass `signal` to the fetcher for cancellation support
 */
export function createAction<T, R>(fetcher: ActionFetcher<T, R>): Action<T, R> {
  const [args, setArgs] = createSignal<T | undefined>(undefined, { equals: false })

  const resourceFetcher: CancellableResourceFetcher<T, R> = (args, context) => fetcher(args, context)

  const [resource, { mutate, cancel }] = createCancellableResource(args, resourceFetcher)

  function submit(newArgs: T) {
    setArgs(() => newArgs)
  }

  function clear() {
    mutate(undefined)
  }

  return {
    submit,
    pending: () => resource.loading,
    result: resource,
    error: () => resource.error,
    cancel,
    clear,
  }
}
