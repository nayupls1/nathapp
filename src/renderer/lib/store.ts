// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one. Everything the server changes
// (agent output, app status, the tab and workspace lists) arrives on the hub.
// Tabs of every workspace stay loaded; the sidebar shows the current one's.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import type { AgentChoice, AppSummary, ChatMessage, PageContext, ProjectInfo, ProviderStatus, RuntimeStatus, WorkspaceInfo } from "../../shared/api";
import type { WorkspaceSettings } from "../../shared/settings";
import { topics } from "../../shared/hub";
import { normalizeUrl } from "../../shared/web";
import { api } from "./api";
import { onConnected, watchTopic } from "./realtime";
import { settings } from "./settings";

export interface TabState {
  loaded: boolean;
  messages: ChatMessage[];
  /** Assistant text currently being streamed. */
  draft: string;
  running: boolean;
  /** Who answers in this tab: provider, model and effort. */
  agent: AgentChoice;
  /** Apps: the project (null until the agent set one up) and how it runs. */
  project: ProjectInfo | null;
  runtime: RuntimeStatus | null;
}

/** Pseudo tab ids for the pages at the bottom of the sidebar. */
export const SETTINGS_VIEW = "settings";
export const ACTIVITY_VIEW = "activity";

const [apps, setApps] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, TabState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [providers, setProviders] = createSignal<ProviderStatus[]>([]);
const [workspaces, setWorkspaces] = createStore<WorkspaceInfo[]>([]);
const [workspaceId, setWorkspaceId] = createSignal<string | null>(localStorage.getItem("nathapp.workspace"));

export { apps, providers, selectedId, states, workspaces };

export const appById = (id: string | null) => (id ? apps.find((a) => a.id === id) : undefined);
export const workspaceById = (id: string | null) => (id ? workspaces.find((w) => w.id === id) : undefined);
/** The workspace shown in the sidebar. */
export const currentWorkspace = () => workspaceById(workspaceId()) ?? workspaces[0];
/** The tabs of the current workspace. */
export const workspaceTabs = () => apps.filter((a) => a.workspaceId === currentWorkspace()?.id);
export const isWebTab = (id: string | null) => appById(id)?.kind === "web";
/** Tabs (app or web) as opposed to the Settings page. */
export const isTab = (id: string | null): id is string => !!id && id !== SETTINGS_VIEW && id !== ACTIVITY_VIEW;

// Tabs stay alive (pages, previews, scroll) once opened, until deleted.
const [opened, setOpened] = createSignal<string[]>([]);
export const openTabs = () => apps.filter((a) => opened().includes(a.id));
const markOpened = (id: string) => {
  if (isTab(id) && !opened().includes(id)) setOpened([...opened(), id]);
};

// Whether the agent panel is hidden, per tab. Remembered across restarts.
const COLLAPSED_KEY = "nathapp.agentCollapsed";
const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    } catch {
      return {};
    }
  })(),
);

export const isAgentCollapsed = (id: string) => !!collapsed()[id];

export function setAgentCollapsed(id: string, value: boolean) {
  const next = { ...collapsed() };
  if (value) next[id] = true;
  else delete next[id];
  setCollapsed(next);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
}

export const toggleAgent = (id: string) => setAgentCollapsed(id, !isAgentCollapsed(id));

// --- Providers -------------------------------------------------------------------------

export const providerById = (id: string) => providers().find((p) => p.id === id);

export async function loadProviders() {
  setProviders(await api.providers());
}

export async function refreshProviders(id?: ProviderStatus["id"]) {
  setProviders(await api.refreshProviders(id));
}

watchTopic(topics.providers, (msg) => {
  if (msg.type === "providers") setProviders(msg.providers);
});

/** The agent new tabs start with: the workspace's default, else the one from Settings. */
export const defaultAgent = (workspace = currentWorkspace()): AgentChoice => {
  const { provider, model, effort } = workspace?.settings.agent ?? settings().agent;
  return { provider, model, effort };
};

export function setAgentChoice(id: string, choice: AgentChoice) {
  setStates(id, "agent", choice);
}

// --- Tabs ------------------------------------------------------------------------------

const emptyState = (): TabState => ({
  loaded: false,
  messages: [],
  draft: "",
  running: false,
  agent: defaultAgent(),
  project: null,
  runtime: null,
});

function upsertApp(app: AppSummary) {
  const i = apps.findIndex((a) => a.id === app.id);
  if (i === -1) setApps(apps.length, app);
  else setApps(i, reconcile(app));
}

/** After the selected tab went away (deleted, moved): its neighbour in the workspace, or nothing. */
function selectNeighbour(siblings: AppSummary[], index: number) {
  const next = siblings[Math.min(index, siblings.length - 1)];
  setSelectedId(null);
  if (next) void selectApp(next.id);
}

function forgetApp(id: string) {
  const index = workspaceTabs().findIndex((a) => a.id === id);
  if (!appById(id)) return;
  setApps((list) => list.filter((a) => a.id !== id));
  setOpened(opened().filter((x) => x !== id));
  watchers.get(id)?.();
  watchers.delete(id);
  setStates(produce((s) => void delete s[id]));
  if (selectedId() === id) selectNeighbour(workspaceTabs(), index);
}

// The tab list changes from elsewhere too (the agent names apps, duplicates…).
watchTopic(topics.apps, (msg) => {
  if (msg.type === "app") upsertApp(msg.app);
  else if (msg.type === "app-deleted") forgetApp(msg.appId);
});
onConnected(() => void api.listApps().then((list) => setApps(reconcile(list)), () => {}));

const addMessage = (id: string, message: ChatMessage) =>
  setStates(
    id,
    produce((s) => {
      if (s.messages.some((m) => m.id === message.id)) return;
      s.messages.push(message);
      if (message.role === "assistant") s.draft = "";
    }),
  );

// Agent output and app status for every loaded tab.
const watchers = new Map<string, () => void>();
function watch(id: string) {
  if (watchers.has(id)) return;
  const stopTopic = watchTopic(topics.app(id), (msg) => {
    if (!states[id]) return;
    if (msg.type === "runtime") {
      setStates(id, "runtime", msg.status);
      // The agent just set up the project.
      if (!states[id].project) void refreshDetail(id);
      return;
    }
    if (msg.type !== "chat") return;
    const event = msg.event;
    if (event.type === "started") setStates(id, { running: true, draft: "" });
    else if (event.type === "message") addMessage(id, event.message);
    else if (event.type === "delta") setStates(id, "draft", (d) => d + event.text);
    else if (event.type === "done") {
      setStates(id, { running: false, draft: "" });
      // The agent may have set up the project.
      if (appById(id)?.kind === "app") void refreshDetail(id);
    }
  });
  // After a reconnect, refetch: what happened in between wasn't pushed.
  const stopReconnect = onConnected(() => void refreshDetail(id));
  watchers.set(id, () => (stopTopic(), stopReconnect()));
}

async function refreshDetail(id: string) {
  const detail = await api.getApp(id).catch(() => null);
  if (!detail || !states[id]) return;
  setStates(id, {
    messages: detail.messages,
    running: detail.running,
    project: detail.project,
    runtime: detail.runtime,
    ...(detail.running ? {} : { draft: "" }),
  });
}

export async function loadApps() {
  const [spaces, list] = await Promise.all([api.workspaces(), api.listApps()]);
  setWorkspaces(reconcile(spaces));
  setApps(reconcile(list));
  if (!selectedId()) await showWorkspace(currentWorkspace()!.id);
}

export async function selectApp(id: string) {
  // A tab of another workspace (e.g. from a link): its workspace comes along.
  const tab = appById(id);
  if (tab && tab.workspaceId !== currentWorkspace()?.id) setCurrentWorkspace(tab.workspaceId);
  if (tab) rememberTab(tab.workspaceId, id);
  setSelectedId(id);
  markOpened(id);
  if (!isTab(id) || states[id]?.loaded) return;
  watch(id);
  const detail = await api.getApp(id);
  setStates(id, {
    ...emptyState(),
    loaded: true,
    messages: detail.messages,
    running: detail.running,
    agent: detail.agent ?? defaultAgent(workspaceById(detail.workspaceId)),
    project: detail.project,
    runtime: detail.runtime,
  });
}

function showNewTab(app: AppSummary) {
  upsertApp(app);
  watch(app.id);
  setStates(app.id, { ...emptyState(), loaded: true });
  rememberTab(app.workspaceId, app.id);
  setSelectedId(app.id);
  markOpened(app.id);
}

export async function newApp() {
  showNewTab(await api.createApp({ workspaceId: currentWorkspace()?.id }));
}

/** Opens a web tab: the given URL, or the home page from Settings. */
export async function newWebTab(url?: string) {
  const target = url ?? normalizeUrl(settings().web.homePage, settings().web.searchEngine);
  showNewTab(await api.createApp({ kind: "web", url: /^https?:\/\//i.test(target) ? target : undefined, workspaceId: currentWorkspace()?.id }));
}

// Web tab navigation is saved (debounced) so tabs reopen where they were.
const pageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingPages = new Map<string, { url?: string; title?: string; favicon?: string | null }>();
export function updatePage(id: string, page: { url?: string; title?: string; favicon?: string | null }) {
  const app = appById(id);
  if (!app) return;
  const next = { ...pendingPages.get(id), ...page };
  pendingPages.set(id, next);
  // Show it right away; the server decides the name (renamed tabs keep theirs).
  setApps(
    (a) => a.id === id,
    produce((a) => {
      if (page.url !== undefined) a.url = page.url;
      if (page.favicon !== undefined) a.favicon = page.favicon;
    }),
  );
  clearTimeout(pageTimers.get(id));
  pageTimers.set(
    id,
    setTimeout(() => {
      pendingPages.delete(id);
      api.updatePage(id, next).then(upsertApp, () => {});
    }, 400),
  );
}

export async function renameApp(id: string, name: string) {
  upsertApp(await api.renameApp(id, name));
}

export async function duplicateApp(id: string) {
  const copy = await api.duplicateApp(id);
  upsertApp(copy); // the list is ordered by creation, so it goes last
  await selectApp(copy.id);
}

export async function clearChat(id: string) {
  await api.clearChat(id);
  setStates(id, { messages: [], draft: "" });
}

export async function deleteApp(id: string) {
  await api.deleteApp(id);
  forgetApp(id);
}

/** Moves a tab to another workspace. It closes here; web tabs reopen with that workspace's session. */
export async function moveApp(id: string, workspaceId: string) {
  const index = workspaceTabs().findIndex((a) => a.id === id);
  const moved = await api.moveApp(id, workspaceId);
  setOpened(opened().filter((x) => x !== id));
  upsertApp(moved);
  if (selectedId() === id) selectNeighbour(workspaceTabs(), index);
}

// --- Workspaces --------------------------------------------------------------------------

const WORKSPACE_TABS_KEY = "nathapp.workspaceTabs";
const lastTabs = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_TABS_KEY) ?? "{}");
  } catch {
    return {};
  }
};
function rememberTab(workspaceId: string, tabId: string) {
  localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify({ ...lastTabs(), [workspaceId]: tabId }));
}

function setCurrentWorkspace(id: string) {
  setWorkspaceId(id);
  localStorage.setItem("nathapp.workspace", id);
}

/** Switches the sidebar to a workspace and opens the tab you were last on there. Open tabs elsewhere keep running. */
export async function showWorkspace(id: string) {
  if (!workspaceById(id)) return;
  setCurrentWorkspace(id);
  const tabs = workspaceTabs();
  const last = lastTabs()[id];
  const tab = tabs.find((a) => a.id === last) ?? tabs[tabs.length - 1];
  if (tab) await selectApp(tab.id);
  else setSelectedId(null);
}

function upsertWorkspace(workspace: WorkspaceInfo) {
  const i = workspaces.findIndex((w) => w.id === workspace.id);
  if (i === -1) setWorkspaces(workspaces.length, workspace);
  else setWorkspaces(i, reconcile(workspace));
}

function forgetWorkspace(id: string) {
  if (!workspaceById(id)) return;
  const wasCurrent = currentWorkspace()?.id === id;
  for (const tab of apps.filter((a) => a.workspaceId === id)) forgetApp(tab.id);
  setWorkspaces((list) => list.filter((w) => w.id !== id));
  if (wasCurrent && workspaces[0]) void showWorkspace(workspaces[0].id);
}

// Settings being typed are saved shortly after; until then, echoes of older saves are ignored.
const workspaceSaves = new Map<string, ReturnType<typeof setTimeout>>();

/** Edits a workspace's settings: shown right away, saved shortly after. */
export function editWorkspaceSettings(id: string, update: (current: WorkspaceSettings) => WorkspaceSettings) {
  const workspace = workspaceById(id);
  if (!workspace) return;
  const next = update(structuredClone(unwrap(workspace.settings)));
  setWorkspaces((w) => w.id === id, "settings", reconcile(next));
  clearTimeout(workspaceSaves.get(id));
  workspaceSaves.set(
    id,
    setTimeout(() => {
      workspaceSaves.delete(id);
      api.updateWorkspace(id, { settings: next }).catch((err) => console.error("Saving the workspace failed:", err));
    }, 300),
  );
}

watchTopic(topics.workspaces, (msg) => {
  if (msg.type === "workspace") {
    const local = workspaceById(msg.workspace.id);
    upsertWorkspace(workspaceSaves.has(msg.workspace.id) && local ? { ...msg.workspace, settings: unwrap(local.settings) } : msg.workspace);
  }
  else if (msg.type === "workspace-deleted") forgetWorkspace(msg.workspaceId);
});
onConnected(() => void api.workspaces().then((list) => setWorkspaces(reconcile(list)), () => {}));

export async function createWorkspace(name: string) {
  const workspace = await api.createWorkspace(name);
  upsertWorkspace(workspace);
  await showWorkspace(workspace.id);
}

export async function updateWorkspace(id: string, fields: { name?: string; icon?: string | null; settings?: WorkspaceSettings }) {
  upsertWorkspace(await api.updateWorkspace(id, fields));
}

/** Deletes a workspace with its tabs and their data, and clears its web tabs' cookies and storage. */
export async function deleteWorkspace(id: string) {
  await api.deleteWorkspace(id);
  forgetWorkspace(id);
  await window.nathapp.web.clearWorkspace(id).catch((err) => console.error("Clearing the workspace's web data failed:", err));
}

// --- Agent -------------------------------------------------------------------------------

export async function sendPrompt(id: string, prompt: string, page?: PageContext) {
  setStates(id, { running: true, draft: "" });
  try {
    await api.chat(id, { prompt, agent: states[id]!.agent, page });
  } catch (err) {
    const message: ChatMessage = {
      id: -Date.now(),
      role: "error",
      content: err instanceof Error ? err.message : String(err),
      createdAt: new Date().toISOString(),
    };
    setStates(id, { running: false, draft: "" });
    setStates(id, "messages", (m) => [...m, message]);
  }
}

export function stopAgent(id: string) {
  return api.stop(id);
}

// --- Apps --------------------------------------------------------------------------------

export function setRuntime(id: string, status: RuntimeStatus) {
  if (states[id]) setStates(id, "runtime", status);
}
