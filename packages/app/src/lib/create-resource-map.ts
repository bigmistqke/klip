import { createEffect, type Accessor, type Resource } from 'solid-js'
import { createStore } from 'solid-js/store'
import { resource } from './resource'

interface ResourceEntry<V> {
  resource: Resource<V | null>
}

export interface ResourceMap<V> {
  /** Get value by key - fine-grained reactivity */
  get(key: string): V | undefined
  /** Check loading state. With key: specific key loading. Without: any loading */
  loading(key?: string): boolean
}

/**
 * Creates a reactive map of resources with fine-grained reactivity.
 *
 * Each key maps to its own resource, so accessing `map.get(key)` only
 * subscribes to that specific key's resource.
 *
 * @param entries - Reactive accessor for [key, value] entries to create resources for
 * @param fetcher - Async function to fetch the value for a given key and entry value
 */
export function createResourceMap<K extends string, E, V>(
  entries: Accessor<[K, E][]>,
  fetcher: (key: K, entry: E) => Promise<V | null>,
): ResourceMap<V> {
  const [store, setStore] = createStore<Record<string, ResourceEntry<V>>>({})

  // Create resources as entries appear
  createEffect(() => {
    const currentEntries = entries()

    for (const [key, entry] of currentEntries) {
      if (!store[key]) {
        const [res] = resource(() => fetcher(key, entry))
        setStore(key, { resource: res })
      }
    }
  })

  return {
    get(key: string): V | undefined {
      const value = store[key]?.resource()
      return value ?? undefined
    },
    loading(key?: string): boolean {
      if (key !== undefined) {
        return store[key]?.resource.loading ?? false
      }
      return Object.values(store).some(entry => entry?.resource.loading)
    },
  }
}
