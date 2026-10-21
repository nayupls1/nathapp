import * as stylex from "@stylexjs/stylex";
import { For, onMount, Show } from "solid-js";
import { CatalogPage } from "./components/CatalogPage";
import { ConfirmHost } from "./components/ConfirmDialog";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui";
import { WebTab } from "./components/WebTab";
import { Workspace } from "./components/Workspace";
import { loadSettings } from "./lib/settings";
import { apps, CATALOG_VIEW, isWebTab, loadApps, newApp, newWebTab, openWebTabs, selectedId, SETTINGS_VIEW } from "./lib/store";
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
          when={!isWebTab(selectedId()) && selectedId()}
          keyed
          fallback={
            <div {...stylex.attrs(styles.empty)}>
              <p>{apps.length ? "Select a tab" : "Nothing open yet"}</p>
              <div {...stylex.attrs(styles.emptyActions)}>
                <Button variant="primary" onClick={() => newApp()}>
                  + New app
                </Button>
                <Button onClick={() => newWebTab()}>+ New web tab</Button>
              </div>
            </div>
          }
        >
          {(id) =>
            id === CATALOG_VIEW ? <CatalogPage /> : id === SETTINGS_VIEW ? <SettingsPage /> : <Workspace appId={id} />
          }
        </Show>
        {/* Web tabs stay mounted (hidden) so pages keep their state between visits. */}
        <For each={openWebTabs()}>
          {(tab) => (
            <div {...stylex.attrs(styles.webLayer, selectedId() !== tab.id && styles.webHidden)}>
              <WebTab appId={tab.id} active={selectedId() === tab.id} />
            </div>
          )}
        </For>
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
  content: { position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" },
  webLayer: { position: "absolute", inset: 0, zIndex: 1, backgroundColor: colors.bg },
  // Not display:none: webviews must keep their size to stay rendered.
  webHidden: { visibility: "hidden", pointerEvents: "none", zIndex: 0 },
  emptyActions: { display: "flex", gap: space.sm },
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
