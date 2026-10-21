import type { Settings } from "../../shared/settings";
import type {
  AppDetail,
  AppSummary,
  BackendStatus,
  RuntimeInfo,
  ChatEvent,
  ChatRequest,
  DataRequest,
  DataResponse,
  HealthResponse,
  ModelOption,
  SiteOverride,
  TabKind,
} from "../../shared/api";

const url = (path: string) => `${window.gapp.serverUrl}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  listModels: () => request<ModelOption[]>("/api/models"),
  getSettings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) => request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  listApps: () => request<AppSummary[]>("/api/apps"),
  createApp: (body: { kind?: TabKind; url?: string } = {}) =>
    request<AppSummary>("/api/apps", { method: "POST", body: JSON.stringify(body) }),
  updatePage: (id: string, page: { url?: string; title?: string; favicon?: string | null }) =>
    request<AppSummary>(`/api/apps/${id}/page`, { method: "PATCH", body: JSON.stringify(page) }),
  listSites: () => request<SiteOverride[]>("/api/sites"),
  getSite: (host: string) => request<SiteOverride | null>(`/api/sites/${encodeURIComponent(host)}`),
  saveSite: (host: string, fields: Partial<Pick<SiteOverride, "css" | "js" | "enabled">>) =>
    request<SiteOverride>(`/api/sites/${encodeURIComponent(host)}`, { method: "PUT", body: JSON.stringify(fields) }),
  deleteSite: (host: string) => request<void>(`/api/sites/${encodeURIComponent(host)}`, { method: "DELETE" }),
  getApp: (id: string) => request<AppDetail>(`/api/apps/${id}`),
  renameApp: (id: string, name: string) =>
    request<AppSummary>(`/api/apps/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteApp: (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" }),
  duplicateApp: (id: string) => request<AppSummary>(`/api/apps/${id}/duplicate`, { method: "POST" }),
  clearChat: (id: string) => request<void>(`/api/apps/${id}/messages`, { method: "DELETE" }),
  stop: (id: string) => request<void>(`/api/apps/${id}/stop`, { method: "POST" }),

  /** A request to the app's custom backend (through the gApp server). */
  backend: (id: string, path: string, init?: RequestInit) =>
    fetch(url(`/api/apps/${id}/backend${path}`), {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    }),
  runtime: (id: string) => request<RuntimeInfo>(`/api/apps/${id}/runtime`),
  controlBackend: (id: string, action: "start" | "stop" | "restart") =>
    request<BackendStatus>(`/api/apps/${id}/runtime`, { method: "POST", body: JSON.stringify({ action }) }),
  readFile: async (id: string, path: string) => {
    const res = await fetch(url(`/api/apps/${id}/files/${path.split("/").map(encodeURIComponent).join("/")}`));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  },

  data: <T extends DataResponse>(id: string, req: DataRequest) =>
    request<T>(`/api/apps/${id}/data`, { method: "POST", body: JSON.stringify(req) }),

  /** Sends a prompt to the agent and calls `onEvent` for each streamed event. */
  async chat(id: string, body: ChatRequest, onEvent: (event: ChatEvent) => void) {
    const res = await fetch(url(`/api/apps/${id}/chat`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ChatEvent);
    }
  },
};
