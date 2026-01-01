import { type Component } from 'solid-js'
import styles from './Timeline.module.css'

interface TimelineProps {
  projectId?: string
}

const Timeline: Component<TimelineProps> = (props) => {
  return (
    <div class={styles.container}>
      <div class={styles.placeholder}>
        Editor
        {props.projectId && <span> - {props.projectId}</span>}
      </div>
    </div>
  )
}

export default Timeline
