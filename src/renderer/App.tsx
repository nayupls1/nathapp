import * as stylex from "@stylexjs/stylex";
import { onMount, Show } from "solid-js";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui";
import { Workspace } from "./components/Workspace";
import { apps, loadApps, newApp, selectedId } from "./lib/store";
import { colors, font, space } from "./theme.stylex";

export default function App() {
  onMount(loadApps);

  return (
    <div {...stylex.attrs(styles.root)}>
      <Sidebar />
      <div {...stylex.attrs(styles.content)}>
        <Show
          when={selectedId()}
          keyed
          fallback={
            <div {...stylex.attrs(styles.empty)}>
              <p>{apps.length ? "Select an app" : "No apps yet"}</p>
              <Button variant="primary" onClick={() => newApp()}>
                + New app
              </Button>
            </div>
          }
        >
          {(id) => <Workspace appId={id} />}
        </Show>
      </div>
    </div>
  );
}

const styles = stylex.create({
  root: {
    display: "flex",
    height: "100%",
    fontFamily: font.sans,
    fontSize: font.md,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  content: { flex: 1, minWidth: 0, minHeight: 0 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    height: "100%",
    color: colors.muted,
  },
});
