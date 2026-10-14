// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AppSummary, ChatMessage, Effort, ModelOption } from "../../shared/api";
import type { AppSpec } from "../../shared/spec";
import { api } from "./api";

export interface AppState {
  loaded: boolean;
  spec: AppSpec | null;
  messages: ChatMessage[];
  /** Assistant text currently being streamed. */
  draft: string;
  running: boolean;
  /** Bumped whenever the app's data may have changed. */
  dataVersion: number;
  /** Agent settings for this app; null means Claude Code's default. */
  model: string | null;
  effort: Effort | null;
}

/** Pseudo app id for the Catalog page in the sidebar. */
export const CATALOG_VIEW = "catalog";

const [apps, setApps] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, AppState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [models, setModels] = createSignal<ModelOption[]>([]);
const [modelsError, setModelsError] = createSignal<string>();

export { apps, models, modelsError, selectedId, states };

// The last-used agent settings become the default for new apps.
const DEFAULTS_KEY = "gapp.agentDefaults";
const agentDefaults = (): { model: string | null; effort: Effort | null } => {
  try {
    return { model: null, effort: null, ...JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? "{}") };
  } catch {
    return { model: null, effort: null };
  }
};

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
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(options));
}

const emptyState = (): AppState => ({
  loaded: false,
  spec: null,
  messages: [],
  draft: "",
  running: false,
  dataVersion: 0,
  ...agentDefaults(),
});

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
  if (id === CATALOG_VIEW || states[id]?.loaded) return;
  const detail = await api.getApp(id);
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
  setSelectedId(app.id);
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

export async function sendPrompt(id: string, prompt: string) {
  setStates(id, { running: true, draft: "" });
  const { model, effort } = states[id]!;
  try {
    await api.chat(id, { prompt, model: model ?? undefined, effort: effort ?? undefined }, (event) => {
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
          bumpData(id);
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
