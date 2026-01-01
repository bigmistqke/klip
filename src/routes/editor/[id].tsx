import { type Component } from 'solid-js'
import { useParams } from '@solidjs/router'
import Timeline from '~/components/editor/Timeline'
import styles from './[id].module.css'

const Editor: Component = () => {
  const params = useParams<{ id?: string }>()

  return (
    <div class={styles.container}>
      <Timeline projectId={params.id} />
    </div>
  )
}

export default Editor
