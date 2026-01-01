import { type Component, createSignal, Show } from "solid-js";
import { useAuth } from "~/lib/atproto/AuthContext";
import styles from "./UserMenu.module.css";

export const UserMenu: Component = () => {
  const auth = useAuth();
  const [open, setOpen] = createSignal(false);

  const displayName = () => {
    const _session = auth.session();
    if (!_session) return "?";
    return _session.did.replace("did:plc:", "").slice(0, 8);
  };

  return (
    <div class={styles.container}>
      <button
        type="button"
        class={styles.trigger}
        onClick={() => setOpen(!open())}
      >
        <div class={styles.avatar}>{displayName().charAt(0).toUpperCase()}</div>
      </button>
      <Show when={open()}>
        <div class={styles.menu}>
          <div class={styles.info}>{displayName()}</div>
          <hr class={styles.divider} />
          <button
            class={styles.menuItem}
            onClick={() => {
              auth.signOut();
              setOpen(false);
            }}
          >
            Sign out
          </button>
        </div>
      </Show>
    </div>
  );
};
