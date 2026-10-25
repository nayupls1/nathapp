import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";
import type { AppSummary, WorkspaceInfo } from "../../shared/api";
import {
  clearChat,
  createWorkspace,
  currentWorkspace,
  deleteApp,
  duplicateApp,
  moveApp,
  newApp,
  newWebTab,
  renameApp,
  selectApp,
  selectedId,
  SETTINGS_VIEW,
  ACTIVITY_VIEW,
  SCHEDULES_VIEW,
  HISTORY_VIEW,
  showWorkspace,
  states,
  updateWorkspace,
  workspaces,
  workspaceTabs,
} from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { Button } from "./ui";

export function Sidebar() {
  const [newMenu, setNewMenu] = createSignal<MenuPosition>();
  const newItems: MenuItem[] = [
    { label: "New app", icon: "sparkles", onSelect: () => newApp() },
    { label: "New web tab", icon: "globe", onSelect: () => newWebTab() },
  ];
  return (
    <nav {...stylex.attrs(styles.root)}>
      <WorkspaceSwitcher />
      <Button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setNewMenu({ x: r.left, y: r.bottom + 4 });
        }}
        xstyle={styles.newButton}
        aria-haspopup="menu"
        data-new-tab
      >
        <Icon name="plus" size={15} />
        New tab
        <Icon name="chevron-down" size={14} {...stylex.attrs(styles.chevron)} />
      </Button>
      <Show when={newMenu()}>
        {(position) => <ContextMenu items={newItems} position={position()} onClose={() => setNewMenu()} />}
      </Show>
      <ul {...stylex.attrs(styles.list)}>
        <For each={workspaceTabs()}>{(app) => <Item app={app} />}</For>
      </ul>
      <div {...stylex.attrs(styles.footer)}>
        <PageLink id={HISTORY_VIEW} icon="file-clock" label="History" />
        <PageLink id={SCHEDULES_VIEW} icon="calendar-clock" label="Schedules" />
        <PageLink id={ACTIVITY_VIEW} icon="scroll-text" label="Activity" />
        <PageLink id={SETTINGS_VIEW} icon="settings" label="Settings" />
      </div>
    </nav>
  );
}

/** The current workspace; its menu switches between them and creates new ones. */
function WorkspaceSwitcher() {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [naming, setNaming] = createSignal(false);
  const current = () => currentWorkspace();

  const items = (): (MenuItem | "separator")[] => [
    ...workspaces.map((w) => ({
      label: w.name,
      icon: w.icon ?? "layers",
      checked: w.id === current()?.id,
      onSelect: () => void showWorkspace(w.id),
    })),
    "separator",
    {
      label: "New workspace",
      icon: "plus",
      onSelect: async () => {
        await createWorkspace("New workspace");
        setNaming(true);
      },
    },
    { label: "Rename workspace", icon: "pencil", onSelect: () => setNaming(true) },
    { label: "Workspace settings", icon: "settings-2", onSelect: () => void openWorkspaceSettings() },
  ];

  const commit = (value: string) => {
    if (!naming()) return;
    setNaming(false);
    const name = value.trim();
    const workspace = current();
    if (workspace && name && name !== workspace.name) void updateWorkspace(workspace.id, { name });
  };

  return (
    <div {...stylex.attrs(styles.header)}>
      <Show
        when={naming()}
        fallback={
          <button
            type="button"
            aria-haspopup="menu"
            title="Switch workspace"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
            onDblClick={() => setNaming(true)}
            {...stylex.attrs(styles.switcher, menu() !== undefined && styles.switcherOpen)}
            data-workspace-switcher
          >
            <Show when={current()}>{(w) => <WorkspaceBadge workspace={w()} />}</Show>
            <span {...stylex.attrs(styles.workspaceName)}>{current()?.name}</span>
            <Icon name="chevrons-up-down" size={14} {...stylex.attrs(styles.chevron)} />
          </button>
        }
      >
        <input
          ref={(el) => queueMicrotask(() => el.select())}
          value={current()?.name ?? ""}
          aria-label="Workspace name"
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setNaming(false);
          }}
          {...stylex.attrs(styles.rename, styles.workspaceRename)}
          data-workspace-name
        />
      </Show>
      <Show when={menu()}>{(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}</Show>
    </div>
  );
}

/** Opens Settings at the current workspace's section. */
async function openWorkspaceSettings() {
  await selectApp(SETTINGS_VIEW);
  requestAnimationFrame(() => document.querySelector('[data-section="workspace"]')?.scrollIntoView({ block: "start" }));
}

/** The workspace's icon, or its initial. */
export function WorkspaceBadge(props: { workspace: WorkspaceInfo }) {
  return (
    <span {...stylex.attrs(styles.badge)} aria-hidden="true">
      <Icon name={props.workspace.icon} size={13} fallback={<>{props.workspace.icon ?? props.workspace.name.trim().charAt(0).toUpperCase()}</>} />
    </span>
  );
}

function PageLink(props: { id: string; icon: string; label: string }) {
  const selected = () => selectedId() === props.id;
  return (
    <button
      type="button"
      onClick={() => selectApp(props.id)}
      {...stylex.attrs(styles.item, styles.footerItem, selected() && styles.selected)}
    >
      <Icon name={props.icon} size={16} {...stylex.attrs(styles.icon)} />
      <span {...stylex.attrs(styles.name)}>{props.label}</span>
    </button>
  );
}

function Item(props: { app: AppSummary }) {
  const [editing, setEditing] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuPosition>();
  const selected = () => selectedId() === props.app.id;
  const running = () => !!states[props.app.id]?.running;
  const menuOpen = () => menu() !== undefined;
  const highlighted = () => selected() || menuOpen();

  const commit = (value: string) => {
    if (!editing()) return; // Enter already committed; this is the blur that follows
    setEditing(false);
    const name = value.trim();
    if (name && name !== props.app.name) renameApp(props.app.id, name);
  };

  const menuItems = (): (MenuItem | "separator")[] => [
    { label: "Rename", icon: "pencil", onSelect: () => setEditing(true) },
    { label: "Duplicate", icon: "copy", onSelect: () => duplicateApp(props.app.id) },
    ...workspaces
      .filter((w) => w.id !== props.app.workspaceId)
      .map((w) => ({ label: `Move to ${w.name}`, icon: "folder-input", onSelect: () => void moveApp(props.app.id, w.id) })),
    {
      label: "Clear chat",
      icon: "message-square-x",
      disabled: running() || states[props.app.id]?.messages.length === 0,
      onSelect: async () => {
        const ok = await confirmDialog(
          `Clear the chat for “${props.app.name}”? The app and its data stay; the agent starts a fresh conversation.`,
          { confirmLabel: "Clear chat" },
        );
        if (ok) clearChat(props.app.id);
      },
    },
    "separator",
    {
      label: "Delete",
      icon: "trash",
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog(`Delete “${props.app.name}” and all its data?`, { confirmLabel: "Delete", danger: true });
        if (ok) deleteApp(props.app.id);
      },
    },
  ];

  return (
    <li
      {...stylex.attrs(stylex.defaultMarker(), styles.item, highlighted() && styles.selected)}
      onClick={() => selectApp(props.app.id)}
      onDblClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      aria-current={selected() ? "page" : undefined}
      data-app-id={props.app.id}
    >
      <Show
        when={props.app.kind === "web"}
        fallback={
          <Icon
            name={props.app.icon ?? "app-window"}
            size={16}
            {...stylex.attrs(styles.icon)}
            fallback={<span {...stylex.attrs(styles.icon)}>{props.app.icon}</span>}
          />
        }
      >
        <Favicon url={props.app.favicon} />
      </Show>
      <Show when={editing()} fallback={<span {...stylex.attrs(styles.name)}>{props.app.name}</span>}>
        <input
          ref={(el) => queueMicrotask(() => el.select())}
          value={props.app.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          {...stylex.attrs(styles.rename)}
        />
      </Show>
      <Show when={running()}>
        <span {...stylex.attrs(styles.dot)} title="Agent is working" />
      </Show>
      <button
        type="button"
        title="More"
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        {...stylex.attrs(styles.more, menuOpen() && styles.moreOpen)}
      >
        <Icon name="ellipsis" size={15} />
      </button>
      <Show when={menu()}>
        {(position) => <ContextMenu items={menuItems()} position={position()} onClose={() => setMenu()} />}
      </Show>
    </li>
  );
}

function Favicon(props: { url: string | null }) {
  const [broken, setBroken] = createSignal<string | null>(null);
  return (
    <Show when={props.url && broken() !== props.url} fallback={<Icon name="globe" size={16} {...stylex.attrs(styles.icon)} />}>
      <img src={props.url!} alt="" onError={() => setBroken(props.url)} {...stylex.attrs(styles.favicon)} />
    </Show>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.3 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.3 },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: 232,
    flexShrink: 0,
    padding: space.md,
    backgroundColor: colors.sidebar,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    overflowY: "auto",
  },
  header: { display: "flex", alignItems: "center", height: 34 },
  switcher: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    height: 34,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.md,
    fontWeight: 650,
    letterSpacing: "-0.01em",
    textAlign: "left",
    cursor: "pointer",
  },
  switcherOpen: { backgroundColor: colors.surfaceHover },
  workspaceName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  workspaceRename: { height: 30, fontSize: font.md },
  badge: {
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    flexShrink: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: font.xs,
    fontWeight: 700,
  },
  newButton: { justifyContent: "flex-start", width: "100%" },
  chevron: { marginLeft: "auto", opacity: 0.6 },
  favicon: { width: 16, height: 16, marginInline: 1, flexShrink: 0, objectFit: "contain", borderRadius: 3 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 34,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    fontSize: font.sm,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  selected: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px ${colors.border}`,
    fontWeight: 500,
  },
  icon: { width: 18, textAlign: "center", flexShrink: 0, color: colors.muted },
  footer: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    marginTop: "auto",
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  footerItem: { width: "100%", borderWidth: 0, color: colors.text, textAlign: "left" },
  name: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rename: {
    flex: 1,
    minWidth: 0,
    height: 24,
    paddingInline: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    outline: "none",
    fontSize: font.sm,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    flexShrink: 0,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  more: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, ":focus-visible": 1 },
  },
  moreOpen: { opacity: 1 },
});
