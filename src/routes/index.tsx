import { type Component } from 'solid-js'
import { A } from '@solidjs/router'
import styles from './index.module.css'

const Home: Component = () => {
  return (
    <div class={styles.container}>
      <div class={styles.hero}>
        <h1 class={styles.title}>Klip</h1>
        <p class={styles.subtitle}>
          A 4-track recorder for the AT Protocol era
        </p>
        <A href="/editor" class={styles.newProject}>
          New Project
        </A>
      </div>
    </div>
  )
}

export default Home
