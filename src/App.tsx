import { Route, Router } from "@solidjs/router";
import { lazy, type ParentProps, Suspense } from "solid-js";
import { Header } from "~/components/layout/Header";
import { AuthProvider } from "~/lib/atproto/AuthContext";
import styles from "./App.module.css";
import "./index.css";

const Home = lazy(() => import("~/routes/home"));
const Editor = lazy(() => import("~/routes/editor"));
const Callback = lazy(() => import("~/routes/callback"));

function Root(props: ParentProps) {
  return (
    <AuthProvider>
      <div class={styles.app}>
        <Header />
        <main class={styles.main}>
          <Suspense fallback={<div class={styles.loading}>Loading...</div>}>
            {props.children}
          </Suspense>
        </main>
      </div>
    </AuthProvider>
  );
}

export function App() {
  return (
    <Router root={Root}>
      <Route path="/" component={Home} />
      <Route path="/editor" component={Editor} />
      <Route path="/editor/:rkey" component={Editor} />
      <Route path="/editor/:handle/:rkey" component={Editor} />
      <Route path="/callback" component={Callback} />
    </Router>
  );
}
