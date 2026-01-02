import { createContext, useContext } from 'solid-js'
import type { ProjectStoreActions } from './store'

export const ProjectContext = createContext<ProjectStoreActions>()

export function useProject(): ProjectStoreActions {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error('useProject must be used within Editor')
  }
  return context
}
