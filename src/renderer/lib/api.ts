// The gApp server's HTTP API. Every request carries the token Electron gave
// this window; agent output and app status arrive on the hub (realtime.ts).
import type { Settings } from "../../shared/settings";
import type {
  AppDetail,
  AppMode,
  AppSummary,
  ChatRequest,
  HealthResponse,
  LogLine,
  PresetInfo,
  ProjectInfo,
  ProviderId,
  ProviderStatus,
  RuntimeStatus,
  SiteOverride,
  TabKind,
} from "../../shared/api";

const url = (path: string) => `${window.gapp.serverUrl}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${window.gapp.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => request<HealthResponse>("/api/health"),

  providers: () => request<ProviderStatus[]>("/api/providers"),
  refreshProviders: (id?: ProviderId) => post<ProviderStatus[]>("/api/providers/refresh", id ? { id } : {}),
  presets: () => request<PresetInfo[]>("/api/presets"),

  getSettings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) => request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),

  listApps: () => request<AppSummary[]>("/api/apps"),
  createApp: (body: { kind?: TabKind; url?: string } = {}) => post<AppSummary>("/api/apps", body),
  getApp: (id: string) => request<AppDetail>(`/api/apps/${id}`),
  renameApp: (id: string, name: string) => request<AppSummary>(`/api/apps/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteApp: (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" }),
  duplicateApp: (id: string) => post<AppSummary>(`/api/apps/${id}/duplicate`),
  updatePage: (id: string, page: { url?: string; title?: string; favicon?: string | null }) =>
    request<AppSummary>(`/api/apps/${id}/page`, { method: "PATCH", body: JSON.stringify(page) }),

  /** Starts an agent turn; its output arrives on the hub (topic app:<id>). */
  chat: (id: string, body: ChatRequest) => post<{ ok: true }>(`/api/apps/${id}/chat`, body),
  stop: (id: string) => post<void>(`/api/apps/${id}/stop`),
  clearChat: (id: string) => request<void>(`/api/apps/${id}/messages`, { method: "DELETE" }),

  runtime: (id: string) => request<{ status: RuntimeStatus; logs: LogLine[] }>(`/api/apps/${id}/runtime`),
  controlRuntime: (id: string, action: "start" | "stop" | "restart") => post<RuntimeStatus>(`/api/apps/${id}/runtime`, { action }),
  setMode: (id: string, mode: AppMode) => post<RuntimeStatus>(`/api/apps/${id}/mode`, { mode }),
  createProject: (id: string, preset: string, name?: string) => post<ProjectInfo>(`/api/apps/${id}/project`, { preset, name }),

  listSites: () => request<SiteOverride[]>("/api/sites"),
  getSite: (host: string) => request<SiteOverride | null>(`/api/sites/${encodeURIComponent(host)}`),
  saveSite: (host: string, fields: Partial<Pick<SiteOverride, "css" | "js" | "enabled">>) =>
    request<SiteOverride>(`/api/sites/${encodeURIComponent(host)}`, { method: "PUT", body: JSON.stringify(fields) }),
  deleteSite: (host: string) => request<void>(`/api/sites/${encodeURIComponent(host)}`, { method: "DELETE" }),
};
