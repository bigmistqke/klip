import { useAction, useSubmission } from "@solidjs/router";
import { type Component, createSignal, Show } from "solid-js";
import { signInAction } from "~/lib/atproto/AuthContext";
import styles from "./LoginButton.module.css";

export const LoginButton: Component = () => {
  const [handle, setHandle] = createSignal("");
  const [showInput, setShowInput] = createSignal(false);

  const doSignIn = useAction(signInAction);
  const submission = useSubmission(signInAction);

  async function handleSubmit(event: Event) {
    event.preventDefault();
    const _handle = handle().trim();
    if (!_handle) return;
    await doSignIn(_handle);
  }

  return (
    <div class={styles.container}>
      <Show
        when={showInput()}
        fallback={
          <button
            type="button"
            class={styles.button}
            onClick={() => setShowInput(true)}
          >
            Sign in
          </button>
        }
      >
        <form onSubmit={handleSubmit} class={styles.form}>
          <input
            type="text"
            placeholder="handle.bsky.social"
            value={handle()}
            onInput={(e) => setHandle(e.currentTarget.value)}
            class={styles.input}
            disabled={submission.pending}
            autofocus
          />
          <button
            type="submit"
            class={styles.submit}
            disabled={submission.pending}
          >
            {submission.pending ? "..." : "Go"}
          </button>
          <button
            type="button"
            class={styles.cancel}
            onClick={() => setShowInput(false)}
          >
            Cancel
          </button>
        </form>
        <Show when={submission.error}>
          <div class={styles.error}>{String(submission.error)}</div>
        </Show>
      </Show>
    </div>
  );
};
