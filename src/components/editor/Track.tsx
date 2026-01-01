import { type Component } from 'solid-js'
import styles from './Track.module.css'

const Track: Component = () => {
  const handleRecord = () => {
    console.log('Record clicked')
  }

  return (
    <div class={styles.track}>
      <div class={styles.preview}>
        No video
      </div>
      <div class={styles.controls}>
        <button class={styles.recordButton} onClick={handleRecord}>
          Record
        </button>
      </div>
    </div>
  )
}

export default Track
