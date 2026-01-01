import type { Agent } from "@atproto/api";
import type { OAuthSession } from "@atproto/oauth-client-browser";
import { action, createAsync, query } from "@solidjs/router";
import {
  createContext,
  createMemo,
  createSignal,
  type ParentComponent,
  useContext,
} from "solid-js";
import { createAgent, signIn as doSignIn, initSession } from "./client";

const getSession = query(async () => {
  const session = await initSession();
  return session;
}, "session");

export const signInAction = action(async (handle: string) => {
  await doSignIn(handle);
  return { ok: true };
});

interface AuthContextValue {
  session: () => OAuthSession | null | undefined;
  agent: () => Agent | null;
  loading: () => boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue>();

export const AuthProvider: ParentComponent = (props) => {
  const session = createAsync(() => getSession());
  const [manualSignOut, setManualSignOut] = createSignal(false);

  const activeSession = createMemo(() => {
    if (manualSignOut()) return null;
    return session();
  });

  const agent = createMemo(() => {
    const s = activeSession();
    return s ? createAgent(s) : null;
  });

  const loading = () => session() === undefined && !manualSignOut();

  const signOut = () => {
    setManualSignOut(true);
  };

  return (
    <AuthContext.Provider
      value={{ session: activeSession, agent, loading, signOut }}
    >
      {props.children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
