// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AppSummary, ChatMessage, Effort, ModelOption, PageContext } from "../../shared/api";
import { normalizeUrl } from "../../shared/web";
import type { AppSpec } from "../../shared/spec";
import { api } from "./api";
import { onConnected, watchApp } from "./realtime";
import { settings } from "./settings";

export interface AppState {
  loaded: boolean;
  spec: AppSpec | null;
  messages: ChatMessage[];
  /** Assistant text currently being streamed. */
  draft: string;
  running: boolean;
  /** Bumped whenever any of the app's data may have changed. */
  dataVersion: number;
  /** Bumped per table when the server reports a change. */
  tableVersions: Record<string, number>;
  /** Agent settings for this app; null means Claude Code's default. */
  model: string | null;
  effort: Effort | null;
}

/** Pseudo app ids for the pages at the bottom of the sidebar. */
export const CATALOG_VIEW = "catalog";
export const SETTINGS_VIEW = "settings";
const isPage = (id: string) => id === CATALOG_VIEW || id === SETTINGS_VIEW;

const [apps, setApps] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, AppState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [models, setModels] = createSignal<ModelOption[]>([]);
const [modelsError, setModelsError] = createSignal<string>();

export { apps, models, modelsError, selectedId, states };

export const appById = (id: string | null) => (id ? apps.find((a) => a.id === id) : undefined);
export const isWebTab = (id: string | null) => appById(id)?.kind === "web";

// Web tabs stay alive (page state, scroll, logins) once opened, until deleted.
const [openedWeb, setOpenedWeb] = createSignal<string[]>([]);
export const openWebTabs = () => apps.filter((a) => a.kind === "web" && openedWeb().includes(a.id));
const markOpened = (id: string) => {
  if (isWebTab(id) && !openedWeb().includes(id)) setOpenedWeb([...openedWeb(), id]);
};

/** Tabs (app or web) as opposed to the Catalog/Settings pages. */
export const isTab = (id: string | null): id is string => !!id && !isPage(id);

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

// New tabs start with the default model/effort from Settings.
const agentDefaults = (): { model: string | null; effort: Effort | null } => ({
  model: settings().agent.model,
  effort: settings().agent.effort,
});

export async function loadModels() {
  try {
    setModels(await api.listModels());
    setModelsError();
  } catch (err) {
    setModelsError(err instanceof Error ? err.message : String(err));
  }
}

export function setAgentOptions(id: string, options: { model: string | null; effort: Effort | null }) {
  setStates(id, options);
}

const emptyState = (): AppState => ({
  loaded: false,
  spec: null,
  messages: [],
  draft: "",
  running: false,
  dataVersion: 0,
  tableVersions: {},
  ...agentDefaults(),
});

// Realtime updates for every loaded app: data changes and specs changed elsewhere.
const watchers = new Map<string, () => void>();
function watch(id: string) {
  if (watchers.has(id)) return;
  const stopApp = watchApp(id, { tables: (tables) => bumpTables(id, tables), spec: () => void reloadSpec(id) });
  // After a reconnect, refetch everything: changes in between weren't pushed.
  const stopReconnect = onConnected(() => bumpData(id));
  watchers.set(id, () => (stopApp(), stopReconnect()));
}

function upsertApp(app: AppSummary) {
  const i = apps.findIndex((a) => a.id === app.id);
  if (i === -1) setApps(apps.length, app);
  else setApps(i, reconcile(app));
}

export async function loadApps() {
  const list = await api.listApps();
  setApps(reconcile(list));
  if (!selectedId()) await selectApp(list.length ? list[list.length - 1]!.id : CATALOG_VIEW);
}

export async function selectApp(id: string) {
  setSelectedId(id);
  markOpened(id);
  if (isPage(id) || states[id]?.loaded) return;
  const detail = await api.getApp(id);
  watch(id);
  setStates(id, {
    ...emptyState(),
    loaded: true,
    spec: detail.spec,
    messages: detail.messages,
    running: detail.running,
    ...(detail.model || detail.effort ? { model: detail.model, effort: detail.effort } : {}),
  });
  // A run started before a reload: we can't reattach to its stream, so poll
  // until it finishes and then pick up the results.
  if (detail.running) void pollUntilIdle(id);
}

async function pollUntilIdle(id: string) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const detail = await api.getApp(id).catch(() => null);
    if (!detail) return;
    if (!detail.running) {
      setStates(id, { spec: detail.spec, messages: detail.messages, running: false });
      bumpData(id);
      return;
    }
  }
}

export async function newApp() {
  const app = await api.createApp();
  upsertApp(app);
  setStates(app.id, { ...emptyState(), loaded: true });
  watch(app.id);
  setSelectedId(app.id);
}

/** Opens a web tab: the given URL, or the home page from Settings. */
export async function newWebTab(url?: string) {
  const target = url ?? normalizeUrl(settings().web.homePage, settings().web.searchEngine);
  const app = await api.createApp({ kind: "web", url: /^https?:\/\//i.test(target) ? target : undefined });
  upsertApp(app);
  setStates(app.id, { ...emptyState(), loaded: true });
  watch(app.id);
  setSelectedId(app.id);
  markOpened(app.id);
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
  const index = apps.findIndex((a) => a.id === id);
  setApps((list) => list.filter((a) => a.id !== id));
  setOpenedWeb(openedWeb().filter((x) => x !== id));
  watchers.get(id)?.();
  watchers.delete(id);
  setStates(produce((s) => void delete s[id]));
  if (selectedId() === id) {
    const next = apps[Math.min(index, apps.length - 1)];
    setSelectedId(null);
    if (next) await selectApp(next.id);
  }
}

export function bumpData(id: string) {
  setStates(id, "dataVersion", (v) => v + 1);
}

export function bumpTables(id: string, tables: string[]) {
  if (!states[id]) return;
  setStates(id, "tableVersions", produce((t) => {
    for (const name of tables) t[name] = (t[name] ?? 0) + 1;
  }));
}

/** Data version of one table, for refetching only what changed. */
export const tableVersion = (id: string, table: string) =>
  (states[id]?.dataVersion ?? 0) + (states[id]?.tableVersions[table] ?? 0);

/** Picks up a spec changed outside the agent stream (import, another window). */
export async function reloadSpec(id: string) {
  const detail = await api.getApp(id).catch(() => null);
  if (detail && states[id]) setStates(id, { spec: detail.spec });
  if (detail) upsertApp(detail);
}

export async function sendPrompt(id: string, prompt: string, page?: PageContext) {
  setStates(id, { running: true, draft: "" });
  const { model, effort } = states[id]!;
  try {
    await api.chat(id, { prompt, model: model ?? undefined, effort: effort ?? undefined, page }, (event) => {
      switch (event.type) {
        case "message":
          setStates(id, produce((s) => {
            s.messages.push(event.message);
            if (event.message.role === "assistant") s.draft = "";
          }));
          break;
        case "delta":
          setStates(id, "draft", (d) => d + event.text);
          break;
        case "spec":
          setStates(id, { spec: event.spec });
          break;
        case "app":
          upsertApp(event.app);
          break;
        case "done":
          break;
      }
    });
  } catch (err) {
    const message: ChatMessage = {
      id: -Date.now(),
      role: "error",
      content: err instanceof Error ? err.message : String(err),
      createdAt: new Date().toISOString(),
    };
    setStates(id, "messages", (m) => [...m, message]);
  } finally {
    setStates(id, { running: false, draft: "" });
  }
}

export function stopAgent(id: string) {
  return api.stop(id);
}
