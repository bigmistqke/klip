import { createContext, useContext } from "solid-js";
import type { ProjectStoreActions } from "./project-store";

export const StoreContext = createContext<ProjectStoreActions>();

export function useProject(): ProjectStoreActions {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error("useProject must be used within Editor");
  }
  return context;
}
