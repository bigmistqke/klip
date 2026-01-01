import { useParams } from "@solidjs/router";
import { Editor } from "~/components/editor/Editor";
import { ProjectProvider } from "~/lib/project/context";
import styles from "./editor.module.css";

export default function EditorRoute() {
  const params = useParams<{ handle?: string; rkey?: string }>();

  return (
    <ProjectProvider>
      <div class={styles.container}>
        <Editor handle={params.handle} rkey={params.rkey} />
      </div>
    </ProjectProvider>
  );
}
