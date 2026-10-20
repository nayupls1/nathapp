import * as stylex from "@stylexjs/stylex";
import { onMount, Show } from "solid-js";
import { CatalogPage } from "./components/CatalogPage";
import { ConfirmHost } from "./components/ConfirmDialog";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui";
import { Workspace } from "./components/Workspace";
import { loadSettings } from "./lib/settings";
import { apps, CATALOG_VIEW, loadApps, newApp, selectedId, SETTINGS_VIEW } from "./lib/store";
import { colors, font, space } from "./theme.stylex";

export default function App() {
  onMount(async () => {
    await loadSettings().catch((err) => console.error("Loading settings failed:", err));
    await loadApps();
  });

  return (
    <div {...stylex.attrs(styles.root)}>
      <Sidebar />
      <ConfirmHost />
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
          {(id) =>
            id === CATALOG_VIEW ? <CatalogPage /> : id === SETTINGS_VIEW ? <SettingsPage /> : <Workspace appId={id} />
          }
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
  content: { flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" },
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
