import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { AppSummary, WorkspaceInfo } from "../../shared/api";
import {
  appById,
  clearChat,
  createWorkspace,
  currentWorkspace,
  deleteApp,
  duplicateApp,
  isLoaded,
  moveApp,
  moveTab,
  moveTabs,
  newApp,
  newWebTab,
  renameApp,
  selectApp,
  selectedId,
  setTabPinned,
  SETTINGS_VIEW,
  ACTIVITY_VIEW,
  SCHEDULES_VIEW,
  HISTORY_VIEW,
  MODS_VIEW,
  showWorkspace,
  states,
  updateWorkspace,
  workspaces,
  workspaceTabs,
} from "../lib/store";
import { draggedSplit, draggedTab, isSidebarCollapsed, setDraggedSplit, setDraggedTab, setSidebarCollapsed, TAB_DRAG_TYPE, setSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarWidth, toggleSidebar } from "../lib/layout";
import { canUnload, unloadTab } from "../lib/unload";
import { evenSplit, placeInSplit, removeFromSplit, rotateSplit, splitOf, splitWith, unsplit, visibleTabs } from "../lib/splits";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { IconPicker, TabIcon } from "./TabIcon";
import { Button } from "./ui";

/**
 * What the list shows, in the tabs' order: tab ids, and "split:<id>" for a
 * split view, which takes the place of its first tab and lists its tabs in it.
 */
const entries = () => {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const tab of workspaceTabs()) {
    const split = splitOf(tab.id);
    if (!split) list.push(tab.id);
    else if (!seen.has(split.id)) {
      seen.add(split.id);
      list.push(`split:${split.id}`);
    }
  }
  return list;
};

/** Width of the collapsed sidebar: icons only. */
const RAIL_WIDTH = 52;

export function Sidebar() {
  const [newMenu, setNewMenu] = createSignal<MenuPosition>();
  const newItems: MenuItem[] = [
    { label: "New app", icon: "sparkles", onSelect: () => newApp() },
    { label: "New web tab", icon: "globe", onSelect: () => newWebTab() },
  ];
  const compact = isSidebarCollapsed;
  return (
    <>
    <nav
      {...stylex.attrs(styles.root, compact() && styles.rootCompact)}
      style={{ width: `${compact() ? RAIL_WIDTH : sidebarWidth()}px` }}
      data-sidebar={compact() ? "collapsed" : "expanded"}
    >
      <WorkspaceSwitcher />
      <Button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setNewMenu({ x: r.left, y: r.bottom + 4 });
        }}
        xstyle={compact() ? styles.newButtonCompact : styles.newButton}
        title={compact() ? "New tab" : undefined}
        aria-haspopup="menu"
        data-new-tab
      >
        <Icon name="plus" size={15} />
        <Show when={!compact()}>
          New tab
          <Icon name="chevron-down" size={14} {...stylex.attrs(styles.chevron)} />
        </Show>
      </Button>
      <Show when={newMenu()}>
        {(position) => <ContextMenu items={newItems} position={position()} onClose={() => setNewMenu()} />}
      </Show>
      <ul {...stylex.attrs(styles.list)}>
        <For each={entries()}>
          {(key) => (
            <Show when={key.startsWith("split:")} fallback={<Show when={appById(key)}>{(app) => <Item app={app()} />}</Show>}>
              <SplitGroup splitId={key.slice(6)} />
            </Show>
          )}
        </For>
      </ul>
      <div {...stylex.attrs(styles.footer)}>
        <Show when={compact()}>
          <CollapseButton />
        </Show>
        <PageLink id={HISTORY_VIEW} icon="file-clock" label="History" />
        <PageLink id={SCHEDULES_VIEW} icon="calendar-clock" label="Schedules" />
        <PageLink id={MODS_VIEW} icon="puzzle" label="Mods" />
        <PageLink id={ACTIVITY_VIEW} icon="scroll-text" label="Activity" />
        <PageLink id={SETTINGS_VIEW} icon="settings" label="Settings" />
      </div>
    </nav>
    <Show when={!compact()}>
      <Resizer />
    </Show>
    </>
  );
}

/**
 * The sidebar's right edge: drag to resize, double-click for the default
 * width, arrow keys when focused. Dragging it far past the minimum collapses it.
 */
function Resizer() {
  const [dragging, setDragging] = createSignal(false);
  let stop = () => {};
  onCleanup(() => stop());

  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth();
    let raw = startWidth;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      raw = startWidth + ev.clientX - startX;
      setSidebarWidth(raw, false);
    };
    stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setDragging(false);
      stop = () => {};
      if (raw < SIDEBAR_MIN - 60) {
        setSidebarWidth(startWidth);
        setSidebarCollapsed(true);
      } else setSidebarWidth(raw);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div {...stylex.attrs(styles.resizer)}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={sidebarWidth()}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={start}
        onDblClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16;
          if (e.key === "ArrowLeft") setSidebarWidth(sidebarWidth() - step);
          else if (e.key === "ArrowRight") setSidebarWidth(sidebarWidth() + step);
          else return;
          e.preventDefault();
        }}
        {...stylex.attrs(styles.handle, dragging() && styles.handleActive)}
        data-sidebar-resizer
      />
      {/* Over everything (web pages and previews too), so they don't swallow the drag. */}
      <Show when={dragging()}>
        <div {...stylex.attrs(styles.dragShield)} />
      </Show>
    </div>
  );
}

/** The current workspace; its menu switches between them and creates new ones. */
function WorkspaceSwitcher() {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [naming, setNaming] = createSignal(false);
  const current = () => currentWorkspace();
  const menuOpen = () => menu() !== undefined;

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
    <div {...stylex.attrs(styles.header)} data-titlebar>
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
            {...stylex.attrs(styles.switcher, menuOpen() && styles.switcherOpen, isSidebarCollapsed() && styles.switcherCompact)}
            data-workspace-switcher
          >
            <Show when={current()}>{(w) => <WorkspaceBadge workspace={w()} />}</Show>
            <Show when={!isSidebarCollapsed()}>
              <span {...stylex.attrs(styles.workspaceName)}>{current()?.name}</span>
              <Icon name="chevrons-up-down" size={14} {...stylex.attrs(styles.chevron)} />
            </Show>
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
      <Show when={!isSidebarCollapsed()}>
        <CollapseButton />
      </Show>
      <Show when={menu()}>{(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}</Show>
    </div>
  );
}

function CollapseButton() {
  return (
    <button
      type="button"
      title={isSidebarCollapsed() ? "Expand the sidebar (Ctrl+Shift+B)" : "Collapse the sidebar (Ctrl+Shift+B)"}
      aria-label={isSidebarCollapsed() ? "Expand the sidebar" : "Collapse the sidebar"}
      aria-expanded={!isSidebarCollapsed()}
      onClick={toggleSidebar}
      {...stylex.attrs(styles.collapse)}
      data-sidebar-toggle
    >
      <Icon name={isSidebarCollapsed() ? "panel-left-open" : "panel-left-close"} size={16} />
    </button>
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
      title={isSidebarCollapsed() ? props.label : undefined}
      onClick={() => selectApp(props.id)}
      {...stylex.attrs(styles.item, styles.footerItem, selected() && styles.selected, isSidebarCollapsed() && styles.itemCompact)}
    >
      <Icon name={props.icon} size={16} {...stylex.attrs(styles.icon)} />
      <Show when={!isSidebarCollapsed()}>
        <span {...stylex.attrs(styles.name)}>{props.label}</span>
      </Show>
    </button>
  );
}

/** A split view: its tabs in one block, with a handle to drag them all and a menu. */
function SplitGroup(props: { splitId: string }) {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const split = () => workspaces.flatMap((w) => w.splits).find((x) => x.id === props.splitId);
  const isRow = () => split()?.direction === "row";
  const isDragged = () => draggedSplit() === props.splitId;
  const openMenu = (position: MenuPosition) => setMenu(position);

  const items = (): MenuItem[] => [
    {
      label: isRow() ? "Stack them" : "Side by side",
      icon: isRow() ? "rows-2" : "columns-2",
      onSelect: () => rotateSplit(props.splitId),
    },
    { label: "Equal sizes", icon: "equal", onSelect: () => evenSplit(props.splitId) },
    { label: "Unsplit", icon: "square-split-horizontal", onSelect: () => unsplit(props.splitId) },
  ];

  return (
    <Show when={split()}>
      {(s) => (
        <li {...stylex.attrs(styles.group, isDragged() && styles.dragging)} data-split-group={props.splitId}>
          <div
            {...stylex.attrs(stylex.defaultMarker(), styles.groupHeader, isSidebarCollapsed() && styles.groupHeaderCompact)}
            title={isSidebarCollapsed() ? "Split view" : "Drag to move the split view"}
            draggable
            onDragStart={(e) => {
              e.dataTransfer!.setData(TAB_DRAG_TYPE, `split:${props.splitId}`);
              e.dataTransfer!.effectAllowed = "move";
              setDraggedSplit(props.splitId);
            }}
            onDragEnd={() => {
              setDraggedSplit(null);
              setDropAt(null);
            }}
            onClick={() => {
              // Shows the split: on the tab last focused in it, else its first.
              const tabs = s().tabs;
              if (!tabs.includes(selectedId() ?? "")) void selectApp(tabs[0]!);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <Icon name={isRow() ? "columns-2" : "rows-2"} size={13} />
            <Show when={!isSidebarCollapsed()}>
              <span {...stylex.attrs(styles.groupLabel)}>Split view</span>
              <button
                type="button"
                title="Split view options"
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu({ x: r.left, y: r.bottom + 4 });
                }}
                {...stylex.attrs(styles.more, styles.groupMore)}
                data-split-menu
              >
                <Icon name="ellipsis" size={14} />
              </button>
            </Show>
          </div>
          <ul {...stylex.attrs(styles.list)}>
            <For each={s().tabs}>{(id) => <Show when={appById(id)}>{(app) => <Item app={app()} />}</Show>}</For>
          </ul>
          <Show when={menu()}>{(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}</Show>
        </li>
      )}
    </Show>
  );
}

/** Where a dragged tab would land: before or after which tab. */
const [dropAt, setDropAt] = createSignal<{ id: string; side: "before" | "after" } | null>(null);

/**
 * A tab dropped next to a tab of a split view joins it there (or moves within
 * it); next to any other tab it leaves its split. A dragged split view moves
 * with all its tabs.
 */
function dropOn(at: { id: string; side: "before" | "after" }, tabId: string | null, groupId: string | null) {
  const target = splitOf(at.id);
  if (groupId) {
    const group = workspaces.flatMap((w) => w.splits).find((x) => x.id === groupId);
    if (group && target?.id !== groupId) void moveTabs(group.tabs, at.id, at.side);
    return;
  }
  if (!tabId) return;
  if (target) placeInSplit(target.id, tabId, target.tabs.indexOf(at.id) + (at.side === "after" ? 1 : 0));
  else removeFromSplit(tabId);
  void moveTab(tabId, at.id, at.side);
}

function Item(props: { app: AppSummary }) {
  const [editing, setEditing] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [iconPicker, setIconPicker] = createSignal<MenuPosition>();
  const dropBefore = () => draggedTab() !== props.app.id && dropAt()?.id === props.app.id && dropAt()?.side === "before";
  const dropAfter = () => draggedTab() !== props.app.id && dropAt()?.id === props.app.id && dropAt()?.side === "after";
  const split = () => splitOf(props.app.id);
  // On screen next to the selected tab, in a split view.
  const beside = () => selectedId() !== props.app.id && visibleTabs().includes(props.app.id);
  // The tab on screen this one could be shown beside.
  const current = () => {
    const id = selectedId();
    return id && id !== props.app.id && appById(id)?.workspaceId === props.app.workspaceId ? appById(id) : undefined;
  };
  const isDragged = () => draggedTab() === props.app.id;
  const neighbour = (offset: number) => {
    const tabs = workspaceTabs();
    return tabs[tabs.findIndex((t) => t.id === props.app.id) + offset];
  };
  const selected = () => selectedId() === props.app.id;
  const running = () => !!states[props.app.id]?.running;
  const menuOpen = () => menu() !== undefined;
  const highlighted = () => selected() || menuOpen();
  // Its page isn't open (unloaded for being idle, or not opened yet): it loads when clicked.
  const asleep = () => !isLoaded(props.app.id) && !selected();

  const commit = (value: string) => {
    if (!editing()) return; // Enter already committed; this is the blur that follows
    setEditing(false);
    const name = value.trim();
    if (name && name !== props.app.name) renameApp(props.app.id, name);
  };

  // Renaming needs room: a collapsed sidebar opens first.
  const rename = () => {
    setSidebarCollapsed(false);
    setEditing(true);
  };

  const menuItems = (): (MenuItem | "separator")[] => [
    { label: "Rename", icon: "pencil", onSelect: rename },
    { label: "Change icon…", icon: "shapes", onSelect: () => setIconPicker(menu() ?? { x: 0, y: 0 }) },
    { label: "Duplicate", icon: "copy", onSelect: () => duplicateApp(props.app.id) },
    ...(split()
      ? [{ label: "Remove from split view", icon: "square-x", onSelect: () => removeFromSplit(props.app.id) }]
      : current()
        ? [{ label: `Show beside “${current()!.name}”`, icon: "columns-2", onSelect: () => splitWith(current()!.id, props.app.id, "right") }]
        : []),
    props.app.pinned
      ? { label: "Allow unloading", icon: "pin-off", onSelect: () => void setTabPinned(props.app.id, false) }
      : { label: "Keep loaded", icon: "pin", onSelect: () => void setTabPinned(props.app.id, true) },
    { label: "Unload", icon: "moon", disabled: !canUnload(props.app.id), onSelect: () => void unloadTab(props.app.id) },
    { label: "Move up", icon: "arrow-up", disabled: !neighbour(-1), onSelect: () => void moveTab(props.app.id, neighbour(-1)!.id, "before") },
    { label: "Move down", icon: "arrow-down", disabled: !neighbour(1), onSelect: () => void moveTab(props.app.id, neighbour(1)!.id, "after") },
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
      {...stylex.attrs(
        stylex.defaultMarker(),
        styles.item,
        highlighted() && styles.selected,
        beside() && styles.beside,
        isSidebarCollapsed() && styles.itemCompact,
        isDragged() && styles.dragging,
        dropBefore() && styles.dropBefore,
        dropAfter() && styles.dropAfter,
      )}
      title={isSidebarCollapsed() ? props.app.name : asleep() ? "Not loaded: opens where you left it" : undefined}
      onClick={() => selectApp(props.app.id)}
      onDblClick={rename}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      aria-current={selected() ? "page" : undefined}
      data-app-id={props.app.id}
      data-loaded={isLoaded(props.app.id) ? "" : undefined}
      data-pinned={props.app.pinned ? "" : undefined}
      draggable={!editing()}
      onDragStart={(e) => {
        e.dataTransfer!.setData(TAB_DRAG_TYPE, props.app.id);
        e.dataTransfer!.effectAllowed = "move";
        setDraggedTab(props.app.id);
      }}
      onDragEnd={() => {
        setDraggedTab(null);
        setDropAt(null);
      }}
      onDragOver={(e) => {
        if (!draggedTab() && !draggedSplit()) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        setDropAt({ id: props.app.id, side: e.clientY < r.top + r.height / 2 ? "before" : "after" });
      }}
      onDragLeave={(e) => {
        if (dropAt()?.id === props.app.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={(e) => {
        const id = draggedTab();
        const group = draggedSplit();
        const at = dropAt();
        setDraggedTab(null);
        setDraggedSplit(null);
        setDropAt(null);
        if (!at) return;
        e.preventDefault();
        dropOn(at, id, group);
      }}
    >
      <span {...stylex.attrs(styles.tabIcon, asleep() && styles.asleep)}>
        <TabIcon tab={props.app} />
      </span>
      <Show when={editing()} fallback={<span {...stylex.attrs(styles.name, isSidebarCollapsed() && styles.hiddenText)}>{props.app.name}</span>}>
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
      <Show when={props.app.pinned && !isSidebarCollapsed()}>
        <Icon name="pin" size={12} {...stylex.attrs(styles.pin)} aria-label="Kept loaded" />
      </Show>
      <Show when={running()}>
        <span {...stylex.attrs(styles.dot, isSidebarCollapsed() && styles.dotCompact)} title="Agent is working" />
      </Show>
      <Show when={!isSidebarCollapsed()}>
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
      </Show>
      <Show when={menu()}>
        {(position) => <ContextMenu items={menuItems()} position={position()} onClose={() => setMenu()} />}
      </Show>
      <Show when={iconPicker()}>
        {(position) => <IconPicker tab={props.app} position={position()} onClose={() => setIconPicker()} />}
      </Show>
    </li>
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
    flexShrink: 0,
    padding: space.md,
    backgroundColor: colors.sidebar,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    overflowX: "hidden",
    overflowY: "auto",
  },
  rootCompact: { paddingInline: 8 },
  header: { display: "flex", alignItems: "center", gap: 2, height: 34 },
  collapse: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 34,
    height: 34,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  resizer: { position: "relative", width: 0, flexShrink: 0, zIndex: 5 },
  handle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -3,
    width: 6,
    cursor: "col-resize",
    backgroundColor: { default: "transparent", ":hover": colors.accent, ":focus-visible": colors.accent },
    opacity: { default: 1, ":hover": 0.5, ":focus-visible": 0.5 },
    outline: "none",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  handleActive: { backgroundColor: colors.accent, opacity: 0.5 },
  dragShield: { position: "fixed", inset: 0, zIndex: 1000, cursor: "col-resize" },
  switcherCompact: { justifyContent: "center", paddingInline: 0 },
  newButtonCompact: { justifyContent: "center", width: "100%", paddingInline: 0 },
  itemCompact: { justifyContent: "center", paddingInline: 0, position: "relative" },
  hiddenText: { display: "none" },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 3,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 20,
    paddingInline: 6,
    color: colors.muted,
    fontSize: font.xs,
    cursor: "grab",
    userSelect: "none",
  },
  groupHeaderCompact: { justifyContent: "center", paddingInline: 0 },
  groupLabel: { flex: 1, fontWeight: 600, letterSpacing: "0.02em" },
  groupMore: { width: 18, height: 18 },
  dragging: { opacity: 0.45 },
  // In the split view on screen, next to the selected tab.
  beside: { backgroundColor: { default: colors.surfaceHover, ":hover": colors.surfaceHover } },
  // A line where the dragged tab would land (the list has a 2px gap).
  dropBefore: { boxShadow: `0 -2px 0 0 ${colors.accent}` },
  dropAfter: { boxShadow: `0 2px 0 0 ${colors.accent}` },
  dotCompact: { position: "absolute", top: 5, right: 5 },
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
  tabIcon: { display: "flex", flexShrink: 0, transitionProperty: "opacity", transitionDuration: "150ms" },
  // Not loaded: dimmed, like a sleeping tab.
  asleep: { opacity: 0.45, filter: "grayscale(0.6)" },
  pin: { flexShrink: 0, color: colors.muted, transform: "rotate(45deg)" },
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
