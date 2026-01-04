import { A } from '@solidjs/router'
import { type Component, Show } from 'solid-js'
import { LoginButton } from '~/components/auth/LoginButton'
import { UserMenu } from '~/components/auth/UserMenu'
import { useAuth } from '~/lib/atproto/auth-context'
import styles from './Header.module.css'

export const Header: Component = () => {
  const auth = useAuth()

  return (
    <header class={styles.header}>
      <A href="/" class={styles.logo}>
        @eddy.dj
      </A>
      <div class={styles.actions}>
        <Show when={!auth.loading()} fallback={<span class={styles.loading}>...</span>}>
          <Show when={auth.session()} fallback={<LoginButton />}>
            <UserMenu />
          </Show>
        </Show>
      </div>
    </header>
  )
}
