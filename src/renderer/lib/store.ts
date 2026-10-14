// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AppSummary, ChatMessage } from "../../shared/api";
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
}

const [apps, setApps] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, AppState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);

export { apps, selectedId, states };

const emptyState = (): AppState => ({
  loaded: false,
  spec: null,
  messages: [],
  draft: "",
  running: false,
  dataVersion: 0,
});

function upsertApp(app: AppSummary) {
  const i = apps.findIndex((a) => a.id === app.id);
  if (i === -1) setApps(apps.length, app);
  else setApps(i, reconcile(app));
}

export async function loadApps() {
  const list = await api.listApps();
  setApps(reconcile(list));
  if (!selectedId() && list.length) await selectApp(list[list.length - 1]!.id);
}

export async function selectApp(id: string) {
  setSelectedId(id);
  if (states[id]?.loaded) return;
  const detail = await api.getApp(id);
  setStates(id, {
    ...emptyState(),
    loaded: true,
    spec: detail.spec,
    messages: detail.messages,
    running: detail.running,
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
  try {
    await api.chat(id, prompt, (event) => {
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
