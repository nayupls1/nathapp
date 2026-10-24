import * as stylex from "@stylexjs/stylex";
import { For, Match, onMount, Show, Switch } from "solid-js";
import { ActivityPage } from "./components/ActivityPage";
import { AppTab } from "./components/AppTab";
import { ConfirmHost } from "./components/ConfirmDialog";
import { PermissionHost } from "./components/PermissionHost";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui";
import { WebTab } from "./components/WebTab";
import { loadSettings } from "./lib/settings";
import { ACTIVITY_VIEW, apps, loadApps, loadProviders, newApp, newWebTab, openTabs, selectedId, SETTINGS_VIEW } from "./lib/store";
import { colors, font, space } from "./theme.stylex";

export default function App() {
  onMount(async () => {
    await loadSettings().catch((err) => console.error("Loading settings failed:", err));
    void loadProviders().catch((err) => console.error("Loading providers failed:", err));
    await loadApps();
  });

  const isSelected = (id: string) => selectedId() === id;

  return (
    <div {...stylex.attrs(styles.root)}>
      <Sidebar />
      <ConfirmHost />
      <PermissionHost />
      <div {...stylex.attrs(styles.content)}>
        <Switch
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
          <Match when={selectedId() === SETTINGS_VIEW}>
            <SettingsPage />
          </Match>
          <Match when={selectedId() === ACTIVITY_VIEW}>
            <ActivityPage />
          </Match>
          <Match when={openTabs().some((t) => t.id === selectedId())}>{null}</Match>
        </Switch>
        {/* Tabs stay mounted (hidden) so pages and previews keep their state between visits. */}
        <For each={openTabs()}>
          {(tab) => {
            const inBackground = () => !isSelected(tab.id);
            return (
              <div {...stylex.attrs(styles.layer, inBackground() && styles.hidden)}>
                <Show when={tab.kind === "web"} fallback={<AppTab appId={tab.id} active={isSelected(tab.id)} />}>
                  <WebTab appId={tab.id} active={isSelected(tab.id)} />
                </Show>
              </div>
            );
          }}
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
  layer: { position: "absolute", inset: 0, zIndex: 1, backgroundColor: colors.bg },
  // Not display:none: webviews must keep their size to stay rendered.
  hidden: { visibility: "hidden", pointerEvents: "none", zIndex: 0 },
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
