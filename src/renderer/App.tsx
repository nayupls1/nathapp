import * as stylex from "@stylexjs/stylex";
import { For, Match, onMount, Show, Switch } from "solid-js";
import { ActivityPage } from "./components/ActivityPage";
import { AppTab } from "./components/AppTab";
import { ConfirmHost } from "./components/ConfirmDialog";
import { HistoryPage } from "./components/History";
import { PermissionHost } from "./components/PermissionHost";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui";
import { WebTab } from "./components/WebTab";
import { loadSettings } from "./lib/settings";
import { Icon } from "./components/Icon";
import { ACTIVITY_VIEW, currentWorkspace, HISTORY_VIEW, selectApp, loadApps, loadProviders, newApp, newWebTab, openTabs, selectedId, SETTINGS_VIEW, workspaceTabs } from "./lib/store";
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
      <div {...stylex.attrs(styles.column)}>
        <Show when={window.nathapp.safeMode}>
          <div role="status" {...stylex.attrs(styles.safeMode)} data-safe-mode>
            <Icon name="life-buoy" size={16} />
            <span {...stylex.attrs(styles.safeModeText)}>
              <strong>Safe mode.</strong> Your theme and site customizations are off. Undo what broke things in History, then restart normally.
            </span>
            <button type="button" onClick={() => void selectApp(HISTORY_VIEW)} {...stylex.attrs(styles.safeModeButton)}>
              Open History
            </button>
            <button type="button" onClick={() => window.nathapp.relaunch(false)} {...stylex.attrs(styles.safeModeButton)}>
              Restart normally
            </button>
          </div>
        </Show>
        <div {...stylex.attrs(styles.content)}>
          <Switch
            fallback={
              <div {...stylex.attrs(styles.empty)}>
                <p>{workspaceTabs().length ? "Select a tab" : `Nothing in ${currentWorkspace()?.name ?? "this workspace"} yet`}</p>
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
            <Match when={selectedId() === HISTORY_VIEW}>
              <HistoryPage />
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
  column: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 },
  content: { position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" },
  // Plain colors on purpose: it must stay readable whatever the theme did.
  safeMode: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    paddingBlock: 8,
    paddingInline: 14,
    backgroundColor: "#fef3c7",
    color: "#422006",
    fontSize: 13,
    flexShrink: 0,
  },
  safeModeText: { flex: 1 },
  safeModeButton: {
    paddingBlock: 4,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#b45309",
    borderRadius: 6,
    backgroundColor: "#fffbeb",
    color: "#422006",
    fontSize: 12,
    cursor: "pointer",
  },
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
