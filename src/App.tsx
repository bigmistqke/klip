import { type ParentComponent, Suspense } from 'solid-js'
import Header from '~/components/layout/Header'
import styles from './App.module.css'

const App: ParentComponent = (props) => {
  return (
    <div class={styles.app}>
      <Header />
      <main class={styles.main}>
        <Suspense fallback={<div class={styles.loading}>Loading...</div>}>
          {props.children}
        </Suspense>
      </main>
    </div>
  )
}

export default App
