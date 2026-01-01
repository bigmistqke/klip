import { useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import styles from "./callback.module.css";

export default function Callback() {
  const navigate = useNavigate();

  onMount(() => {
    // OAuth client handles callback automatically via BrowserOAuthClient.load()
    setTimeout(() => navigate("/", { replace: true }), 1000);
  });

  return (
    <div class={styles.container}>
      <div class={styles.message}>Completing sign in...</div>
    </div>
  );
}
