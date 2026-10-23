// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one. Everything the server changes
// (agent output, app status, the tab list) arrives on the hub.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AgentChoice, AppSummary, ChatMessage, PageContext, ProjectInfo, ProviderStatus, RuntimeStatus } from "../../shared/api";
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

/** Pseudo tab id for the Settings page at the bottom of the sidebar. */
export const SETTINGS_VIEW = "settings";

const [apps, setApps] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, TabState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [providers, setProviders] = createSignal<ProviderStatus[]>([]);

export { apps, providers, selectedId, states };

export const appById = (id: string | null) => (id ? apps.find((a) => a.id === id) : undefined);
export const isWebTab = (id: string | null) => appById(id)?.kind === "web";
/** Tabs (app or web) as opposed to the Settings page. */
export const isTab = (id: string | null): id is string => !!id && id !== SETTINGS_VIEW;

// Tabs stay alive (pages, previews, scroll) once opened, until deleted.
const [opened, setOpened] = createSignal<string[]>([]);
export const openTabs = () => apps.filter((a) => opened().includes(a.id));
const markOpened = (id: string) => {
  if (isTab(id) && !opened().includes(id)) setOpened([...opened(), id]);
};

// Whether the agent panel is hidden, per tab. Remembered across restarts.
const COLLAPSED_KEY = "gapp.agentCollapsed";
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

/** The agent new tabs start with (Settings). */
const defaultAgent = (): AgentChoice => {
  const { provider, model, effort } = settings().agent;
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

function forgetApp(id: string) {
  const index = apps.findIndex((a) => a.id === id);
  if (index === -1) return;
  setApps((list) => list.filter((a) => a.id !== id));
  setOpened(opened().filter((x) => x !== id));
  watchers.get(id)?.();
  watchers.delete(id);
  setStates(produce((s) => void delete s[id]));
  if (selectedId() === id) {
    const next = apps[Math.min(index, apps.length - 1)];
    setSelectedId(null);
    if (next) void selectApp(next.id);
  }
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
  const list = await api.listApps();
  setApps(reconcile(list));
  if (!selectedId()) await selectApp(list.length ? list[list.length - 1]!.id : SETTINGS_VIEW);
}

export async function selectApp(id: string) {
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
    agent: detail.agent ?? defaultAgent(),
    project: detail.project,
    runtime: detail.runtime,
  });
}

function showNewTab(app: AppSummary) {
  upsertApp(app);
  watch(app.id);
  setStates(app.id, { ...emptyState(), loaded: true });
  setSelectedId(app.id);
  markOpened(app.id);
}

export async function newApp() {
  showNewTab(await api.createApp());
}

/** Opens a web tab: the given URL, or the home page from Settings. */
export async function newWebTab(url?: string) {
  const target = url ?? normalizeUrl(settings().web.homePage, settings().web.searchEngine);
  showNewTab(await api.createApp({ kind: "web", url: /^https?:\/\//i.test(target) ? target : undefined }));
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
