/**
 * Deep resource primitive - combines resource fetching with store reconciliation.
 *
 * Fetches data via resource and syncs to a store using reconcile for fine-grained
 * reactivity. The store can be locally mutated while still receiving updates from refetches.
 */

import { type Resource, type ResourceSource } from 'solid-js'
import { createStore, reconcile, type SetStoreFunction, type Store } from 'solid-js/store'
import { resource, type ManagedResourceReturn, type ResourceFetcher } from './resource'

interface DeepResourceActions<T, S> extends Omit<ManagedResourceReturn<T, S>[1], 'mutate'> {
  mutate: SetStoreFunction<T>
}

/** Store accessor with loading state from the underlying resource */
interface StoreAccessor<T> {
  (): T
  loading: boolean
  error: unknown
}

/**
 * Creates a resource that syncs to a store with fine-grained reactivity.
 *
 * Returns a store accessor (not the resource directly) to preserve store reactivity.
 * The accessor has `loading` and `error` properties from the underlying resource.
 *
 * @example
 * ```ts
 * const [project, { mutate: setProject }] = deepResource(
 *   () => projectId(),
 *   async (id) => fetchProject(id),
 *   { initialValue: createDefaultProject() }
 * )
 *
 * // Access store (reactive)
 * project().title
 *
 * // Check loading state
 * project.loading
 *
 * // Mutate store locally
 * setProject('title', 'New Title')
 * ```
 */
export function deepResource<T extends object, S>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, NoInfer<T>>,
  options: { initialValue: T },
): [StoreAccessor<Store<T>>, DeepResourceActions<T, S>] {
  const [store, setStore] = createStore(options.initialValue)

  // Resource only tracks loading/error state, doesn't store the value
  const [res, actions] = resource(source, async (source, info) => {
    const result = await fetcher(source, info)
    setStore(reconcile(result))
    // Return undefined - we don't use the resource value
    return undefined
  })

  // Create accessor that returns the store but has resource's loading/error
  const accessor = (() => store) as StoreAccessor<Store<T>>
  Object.defineProperty(accessor, 'loading', {
    get: () => res.loading,
  })
  Object.defineProperty(accessor, 'error', {
    get: () => res.error,
  })

  return [
    accessor,
    {
      ...actions,
      mutate: setStore,
    },
  ]
}
