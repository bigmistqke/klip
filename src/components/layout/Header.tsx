import { type Component } from 'solid-js'
import { A } from '@solidjs/router'
import styles from './Header.module.css'

const Header: Component = () => {
  return (
    <header class={styles.header}>
      <A href="/" class={styles.logo}>
        Klip
      </A>
      <div class={styles.actions}>
        <span class={styles.placeholder}>Sign in</span>
      </div>
    </header>
  )
}

export default Header
