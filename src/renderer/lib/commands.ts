// The command bar (Ctrl+K): what it offers and how a query ranks it. Tabs,
// workspaces, NathApp's own commands and the actions apps declare in their
// nathapp.json, plus routing for free text: a URL opens, a sentence goes to
// the agent (or a new app), anything else can be searched for.
import { createSignal } from "solid-js";
import { isImageIcon, type AppActionInfo, type AppSummary } from "../../shared/api";
import { searchEngines } from "../../shared/settings";
import { normalizeUrl } from "../../shared/web";
import { api } from "./api";
import { settings, updateSettings } from "./settings";
import {
  ACTIVITY_VIEW,
  SCHEDULES_VIEW,
  apps,
  clearChat,
  createWorkspace,
  currentWorkspace,
  deleteApp,
  duplicateApp,
  HISTORY_VIEW,
  isAgentCollapsed,
  isTab,
  moveApp,
  newApp,
  newWebTab,
  renameApp,
  selectApp,
  selectedId,
  sendPrompt,
  setAgentCollapsed,
  setRuntime,
  SETTINGS_VIEW,
  showWorkspace,
  states,
  stopAgent,
  workspaceById,
  workspaces,
} from "./store";
import { isSidebarCollapsed, toggleSidebar } from "./layout";
import { removeFromSplit, rotateSplit, splitOf, splitWith, unsplit, visibleTabs } from "./splits";
import { pageOf } from "./webtabs";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";

export interface Command {
  id: string;
  title: string;
  /** Shown after the title, muted (the app an action belongs to, a tab's workspace…). */
  subtitle?: string;
  /** Lucide icon name; a web tab shows its favicon instead. */
  icon: string;
  favicon?: string | null;
  /** What kind of thing it is, shown on the right. */
  group: string;
  /** More words it should be found by. */
  keywords?: string;
  /** Asks for text first; this is the placeholder. */
  input?: string;
  /** Ranks it regardless of how the query matches (routing). */
  rank?: number;
  run: (input?: string) => unknown;
}

const [open, setOpen] = createSignal(false);
const [appActions, setAppActions] = createSignal<AppActionInfo[]>([]);
export { open as commandBarOpen, appActions };

export function openCommandBar() {
  if (open()) return setOpen(false);
  setOpen(true);
  // Apps may have changed their nathapp.json since: fetched each time.
  void api.actions().then(setAppActions, () => {});
}

export const closeCommandBar = () => setOpen(false);

// --- Ranking ---------------------------------------------------------------------------

/** How well `query` (lowercase, trimmed) matches `text`: 0 for not at all, up to 100 for exactly. */
export function matchScore(query: string, text: string) {
  if (!query) return 0;
  const t = text.toLowerCase();
  if (t === query) return 100;
  if (t.startsWith(query)) return 90;
  const at = t.indexOf(query);
  if (at > 0 && /[\s\-_/.:(]/.test(t[at - 1]!)) return 80;
  if (at > 0) return 70;
  const words = query.split(/\s+/);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 60;
  // Letters in order ("nwt" → "New web tab"): the tighter, the better.
  let from = 0;
  let first = -1;
  for (const ch of query) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, from);
    if (i === -1) return 0;
    if (first === -1) first = i;
    from = i + 1;
  }
  const spread = from - first;
  return Math.max(10, 30 - Math.max(0, spread - query.length) * 2);
}

const scoreOf = (query: string, command: Command) =>
  Math.max(
    matchScore(query, command.title),
    Math.floor(matchScore(query, command.subtitle ?? "") * 0.7),
    Math.floor(matchScore(query, command.keywords ?? "") * 0.8),
  );

/** URLs and things that look like a domain, not searches. */
export function asUrl(text: string) {
  const engine = settings().web.searchEngine;
  const url = normalizeUrl(text, engine);
  return url && url !== searchEngines[engine].url.replace("%s", encodeURIComponent(text.trim())) ? url : null;
}

const isSentence = (text: string) => text.split(/\s+/).length >= 3;

/** What the bar shows for `query`, best first. */
export function results(query: string, commands: Command[], limit = 50): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored = commands.map((command, i) => ({ command, i, score: command.rank ?? scoreOf(q, command) }));
  // "Add expense lunch 12" runs "Add expense" with "lunch 12".
  for (const command of commands) {
    const prefix = `${command.title.toLowerCase()} `;
    if (!command.input || !q.startsWith(prefix) || q.length === prefix.length) continue;
    const rest = query.trim().slice(prefix.length).trim();
    scored.push({
      command: { ...command, id: `${command.id}:with`, subtitle: `${command.subtitle ? `${command.subtitle} · ` : ""}with “${rest}”`, input: undefined, run: () => command.run(rest) },
      i: -1,
      score: 950,
    });
  }
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.command);
}

// --- The commands ----------------------------------------------------------------------

const hostLabel = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

function tabCommand(app: AppSummary): Command {
  const workspace = workspaces.length > 1 ? workspaceById(app.workspaceId)?.name : undefined;
  const where = [app.kind === "web" ? hostLabel(app.url) : "", workspace].filter(Boolean).join(" · ");
  return {
    id: `tab:${app.id}`,
    title: app.name,
    subtitle: where || undefined,
    // Its own icon (an image shows like a favicon), else the default.
    icon: app.icon && !isImageIcon(app.icon) ? app.icon : app.kind === "web" ? "globe" : "app-window",
    favicon: isImageIcon(app.icon) ? app.icon : app.kind === "web" && !app.icon ? app.favicon : undefined,
    group: app.kind === "web" ? "Web tab" : "App",
    keywords: app.kind === "web" ? (app.url ?? "") : undefined,
    run: () => selectApp(app.id),
  };
}

/** Opens an app at one of its pages, once its preview is up. */
export async function openInApp(appId: string, path: string) {
  await selectApp(appId);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const page = pageOf(appId);
      if (page) return void (await page.navigate(path));
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
    if (Date.now() > deadline) throw new Error("The app didn't start in time");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function runAppAction(info: AppActionInfo, input?: string) {
  const { action } = info;
  if (action.path) return openInApp(info.appId, action.path);
  const pending = toast({ title: action.title, message: `Running in ${info.appName}…`, kind: "info", sticky: true });
  try {
    const result = await api.runAction(info.appId, action.id, input);
    pending.update({ message: result.message || (result.ok ? "Done" : `Failed (HTTP ${result.status})`), kind: result.ok ? "success" : "error" });
  } catch (err) {
    pending.update({ message: err instanceof Error ? err.message : String(err), kind: "error" });
  }
}

function actionCommand(info: AppActionInfo): Command {
  const { action } = info;
  return {
    id: `action:${info.appId}:${action.id}`,
    title: action.title,
    subtitle: info.appName,
    icon: info.appIcon ?? "zap",
    group: action.path ? "Open in app" : "App action",
    keywords: action.description,
    input: action.input,
    run: (input) => runAppAction(info, input),
  };
}

/** Sends a prompt to a tab's agent, with the page and picked elements if the tab is open. */
function askAgent(id: string, prompt: string) {
  void selectApp(id);
  setAgentCollapsed(id, false);
  const page = pageOf(id);
  if (page) page.send(prompt);
  else void sendPrompt(id, prompt);
}

function scrollToWorkspaceSettings() {
  void selectApp(SETTINGS_VIEW);
  requestAnimationFrame(() => document.querySelector('[data-section="workspace"]')?.scrollIntoView({ block: "start" }));
}

/** Commands about the tab you're on. */
function currentTabCommands(id: string): Command[] {
  const app = apps.find((a) => a.id === id);
  if (!app) return [];
  const state = states[id];
  const name = `“${app.name}”`;
  const list: Command[] = [
    { id: "tab.rename", title: "Rename tab", subtitle: app.name, icon: "pencil", group: "Tab", input: "New name", run: (name) => name?.trim() && renameApp(id, name.trim()) },
    { id: "tab.duplicate", title: "Duplicate tab", subtitle: app.name, icon: "copy", group: "Tab", run: () => duplicateApp(id) },
    // For an app, the agent panel is its mode: open while editing, hidden when done.
    app.kind === "app" && state?.project
      ? isAgentCollapsed(id)
        ? { id: "tab.agent", title: "Edit the app", subtitle: "Ctrl+J", icon: "pencil-ruler", group: "App", keywords: "show agent panel chat dev mode editing", run: () => setAgentCollapsed(id, false) }
        : { id: "tab.agent", title: "Done editing", subtitle: "Ctrl+J", icon: "check", group: "App", keywords: "hide agent panel chat mark as done live build publish", run: () => setAgentCollapsed(id, true) }
      : {
          id: "tab.agent",
          title: isAgentCollapsed(id) ? "Show the agent" : "Hide the agent",
          subtitle: "Ctrl+J",
          icon: "panel-right",
          group: "Tab",
          keywords: "toggle panel chat",
          run: () => setAgentCollapsed(id, !isAgentCollapsed(id)),
        },
  ];
  if (state?.running) list.push({ id: "tab.stop", title: "Stop the agent", subtitle: app.name, icon: "square", group: "Tab", run: () => stopAgent(id) });
  if (app.kind === "web") {
    list.push({ id: "tab.reload", title: "Reload page", subtitle: "Ctrl+R", icon: "rotate-cw", group: "Tab", run: () => pageOf(id)?.reload() });
  } else if (state?.project) {
    list.push(
      {
        id: "app.restart",
        title: "Restart app",
        subtitle: app.name,
        icon: "rotate-cw",
        group: "App",
        run: async () => setRuntime(id, await api.controlRuntime(id, "restart")),
      },
      {
        id: "app.snapshot",
        title: "Save a snapshot",
        subtitle: app.name,
        icon: "history",
        group: "App",
        keywords: "history version checkpoint",
        run: async () => {
          const entry = await api.saveSnapshot(`app:${id}`);
          toast({ message: entry ? "Saved a snapshot" : "Nothing changed since the last snapshot", kind: entry ? "success" : "info" });
        },
      },
    );
  }
  if (state?.messages.length) {
    list.push({
      id: "tab.clear",
      title: "Clear chat",
      subtitle: app.name,
      icon: "message-square-x",
      group: "Tab",
      run: async () => {
        if (await confirmDialog(`Clear the chat for ${name}? The agent starts a fresh conversation.`, { confirmLabel: "Clear chat" })) await clearChat(id);
      },
    });
  }
  for (const w of workspaces) {
    if (w.id !== app.workspaceId) list.push({ id: `tab.move:${w.id}`, title: `Move tab to ${w.name}`, subtitle: app.name, icon: "folder-input", group: "Tab", run: () => moveApp(id, w.id) });
  }
  list.push({
    id: "tab.delete",
    title: "Delete tab",
    subtitle: app.name,
    icon: "trash",
    group: "Tab",
    run: async () => {
      if (await confirmDialog(`Delete ${name} and all its data?`, { confirmLabel: "Delete", danger: true })) await deleteApp(id);
    },
  });
  return list;
}

function nathappCommands(): Command[] {
  const theme = (mode: "system" | "light" | "dark", title: string, icon: string): Command => ({
    id: `theme.${mode}`,
    title,
    icon,
    group: "NathApp",
    keywords: "theme appearance color scheme",
    run: () => updateSettings((s) => ({ ...s, theme: { ...s.theme, mode } })),
  });
  return [
    { id: "new.app", title: "New app", icon: "plus", group: "NathApp", keywords: "create build", run: () => newApp() },
    { id: "new.web", title: "New web tab", subtitle: "Ctrl+T", icon: "globe", group: "NathApp", keywords: "browser", run: () => newWebTab() },
    { id: "new.workspace", title: "New workspace", icon: "layers", group: "NathApp", input: "Name", run: (name) => name?.trim() && createWorkspace(name.trim()) },
    {
      id: "sidebar.toggle",
      title: isSidebarCollapsed() ? "Expand the sidebar" : "Collapse the sidebar",
      subtitle: "Ctrl+Shift+B",
      icon: "panel-left",
      group: "NathApp",
      keywords: "toggle hide show tabs",
      run: toggleSidebar,
    },
    { id: "open.history", title: "Open History", icon: "history", group: "NathApp", keywords: "undo restore snapshots versions", run: () => selectApp(HISTORY_VIEW) },
    { id: "open.schedules", title: "Open Schedules", icon: "calendar-clock", group: "NathApp", keywords: "background runs cron jobs timer", run: () => selectApp(SCHEDULES_VIEW) },
    { id: "open.activity", title: "Open Activity", icon: "activity", group: "NathApp", keywords: "audit log", run: () => selectApp(ACTIVITY_VIEW) },
    { id: "open.settings", title: "Open Settings", icon: "settings", group: "NathApp", keywords: "preferences", run: () => selectApp(SETTINGS_VIEW) },
    {
      id: "open.workspace-settings",
      title: "Workspace settings",
      subtitle: currentWorkspace()?.name,
      icon: "layers",
      group: "NathApp",
      keywords: "secrets instructions agent",
      run: scrollToWorkspaceSettings,
    },
    theme("system", "Theme: match the system", "monitor"),
    theme("light", "Theme: light", "sun"),
    theme("dark", "Theme: dark", "moon"),
    window.nathapp.safeMode
      ? { id: "restart.normal", title: "Restart normally", icon: "power", group: "NathApp", keywords: "safe mode", run: () => window.nathapp.relaunch(false) }
      : { id: "restart.safe", title: "Restart in safe mode", icon: "life-buoy", group: "NathApp", keywords: "recovery broken theme", run: () => window.nathapp.relaunch(true) },
  ];
}

/** The split view of the tab you're on, and (when something is typed) splitting it with another tab. */
function splitCommands(id: string, typed: boolean): Command[] {
  const app = apps.find((a) => a.id === id);
  if (!app) return [];
  const split = splitOf(id);
  const list: Command[] = [];
  if (split) {
    list.push(
      { id: "split.rotate", title: split.direction === "row" ? "Stack the split view" : "Split view side by side", icon: split.direction === "row" ? "rows-2" : "columns-2", group: "Split view", keywords: "rotate vertical horizontal", run: () => rotateSplit(split.id) },
      { id: "split.remove", title: "Remove from split view", subtitle: app.name, icon: "square-x", group: "Split view", run: () => removeFromSplit(id) },
      { id: "split.end", title: "Unsplit", icon: "square-split-horizontal", group: "Split view", keywords: "close split view", run: () => unsplit(split.id) },
    );
  }
  if (typed) {
    for (const tab of apps) {
      if (tab.workspaceId !== app.workspaceId || visibleTabs().includes(tab.id)) continue;
      list.push({ id: `split.with:${tab.id}`, title: `Split with ${tab.name}`, icon: "columns-2", group: "Split view", keywords: "side by side split view", run: () => splitWith(id, tab.id, "right") });
    }
  }
  return list;
}

/** For free text: open it, ask about it, build it or search for it. */
function routed(query: string, best: number): Command[] {
  const text = query.trim();
  if (!text) return [];
  const list: Command[] = [];
  const url = asUrl(text);
  const id = selectedId();
  const tab = isTab(id) ? apps.find((a) => a.id === id) : undefined;
  if (url) {
    list.push({ id: "route.open", title: `Open ${text}`, subtitle: "in a new tab", icon: "globe", group: "Web", rank: 1000, run: () => newWebTab(url) });
    if (tab?.kind === "web") {
      list.push({ id: "route.here", title: `Open ${text}`, subtitle: "in this tab", icon: "corner-down-right", group: "Web", rank: 999, run: () => pageOf(tab.id)?.navigate(url) });
    }
    return list;
  }
  // A sentence nothing matched well is most likely meant for an agent.
  const forAgent = isSentence(text) && best < 70;
  if (tab) {
    list.push({
      id: "route.ask",
      title: text,
      subtitle: `Ask the agent in ${tab.name}`,
      icon: "message-circle",
      group: "Agent",
      rank: forAgent ? 900 : 3,
      run: () => askAgent(tab.id, text),
    });
  }
  list.push({
    id: "route.build",
    title: text,
    subtitle: "Build a new app",
    icon: "sparkles",
    group: "Agent",
    rank: forAgent ? 850 : 2,
    run: async () => askAgent((await newApp()).id, text),
  });
  list.push({
    id: "route.search",
    title: text,
    subtitle: "Search the web",
    icon: "search",
    group: "Web",
    rank: forAgent ? 800 : 1,
    run: () => newWebTab(normalizeUrl(text, settings().web.searchEngine)),
  });
  return list;
}

/** Everything the bar can do right now, in the order it shows them without a query. */
export function commands(query: string): Command[] {
  const current = currentWorkspace()?.id;
  const id = selectedId();
  const inWorkspace = (workspaceId: string) => workspaceId === current;
  const tabs = [...apps].sort((a, b) => Number(inWorkspace(b.workspaceId)) - Number(inWorkspace(a.workspaceId)));
  const actions = [...appActions()].sort((a, b) => Number(inWorkspace(b.workspaceId)) - Number(inWorkspace(a.workspaceId)));
  const list: Command[] = [
    ...tabs.filter((a) => a.id !== id).map(tabCommand),
    ...actions.map(actionCommand),
    ...(isTab(id) ? currentTabCommands(id) : []),
    ...(isTab(id) ? splitCommands(id, !!query.trim()) : []),
    ...workspaces
      .filter((w) => w.id !== current)
      .map((w): Command => ({ id: `workspace:${w.id}`, title: w.name, subtitle: "Switch workspace", icon: w.icon ?? "layers", group: "Workspace", run: () => showWorkspace(w.id) })),
    ...nathappCommands(),
  ];
  const q = query.trim().toLowerCase();
  const best = q ? Math.max(0, ...list.map((c) => scoreOf(q, c))) : 0;
  return [...list, ...routed(query, best)];
}
