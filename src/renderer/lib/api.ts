// The NathApp server's HTTP API. Every request carries the token Electron gave
// this window; agent output and app status arrive on the hub (realtime.ts).
import type { Settings } from "../../shared/settings";
import type {
  AppDetail,
  AppMode,
  AppSummary,
  AuditEntry,
  PermissionAction,
  PermissionGrant,
  PermissionRequest,
  SecretInfo,
  SecretsOverview,
  ChatRequest,
  HealthResponse,
  HistoryDetail,
  HistoryEntry,
  LogLine,
  PresetInfo,
  ProjectInfo,
  ProviderId,
  ProviderStatus,
  RuntimeStatus,
  SiteOverride,
  TabKind,
  WorkspaceInfo,
} from "../../shared/api";
import type { WorkspaceSettings } from "../../shared/settings";

const url = (path: string) => `${window.nathapp.serverUrl}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${window.nathapp.token}`,
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
  createApp: (body: { kind?: TabKind; url?: string; workspaceId?: string } = {}) => post<AppSummary>("/api/apps", body),
  moveApp: (id: string, workspaceId: string) => post<AppSummary>(`/api/apps/${id}/move`, { workspaceId }),

  workspaces: () => request<WorkspaceInfo[]>("/api/workspaces"),
  createWorkspace: (name: string) => post<WorkspaceInfo>("/api/workspaces", { name }),
  updateWorkspace: (id: string, fields: { name?: string; icon?: string | null; settings?: WorkspaceSettings }) =>
    request<WorkspaceInfo>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),
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

  secrets: (scope?: string) => request<SecretsOverview>(`/api/secrets${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  /** Creates or replaces a secret. The value is never sent back. */
  saveSecret: (scope: string, name: string, value: string) =>
    request<SecretInfo>("/api/secrets", { method: "PUT", body: JSON.stringify({ scope, name, value }) }),
  deleteSecret: (id: string) => request<void>(`/api/secrets/${id}`, { method: "DELETE" }),

  permissions: () => request<PermissionGrant[]>("/api/permissions"),
  setPermission: (subject: string, action: PermissionAction, resource: string, decision: "allow" | "deny") =>
    request<void>("/api/permissions", { method: "PUT", body: JSON.stringify({ subject, action, resource, decision }) }),
  revokePermission: (id: number) => request<void>(`/api/permissions/${id}`, { method: "DELETE" }),
  pendingPermissions: () => request<PermissionRequest[]>("/api/permissions/pending"),
  /** remember: for this app (or agent), or for every app in its workspace. */
  answerPermission: (id: string, allow: boolean, remember: boolean | "workspace") =>
    post<void>(`/api/permissions/pending/${id}`, { allow, remember }),

  audit: (filter: { tab?: string; workspace?: string; actor?: string; before?: number; limit?: number } = {}) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return request<AuditEntry[]>(`/api/audit${params.size ? `?${params}` : ""}`);
  },

  history: (filter: { target?: string; workspace?: string; before?: number; limit?: number } = {}) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return request<HistoryEntry[]>(`/api/history${params.size ? `?${params}` : ""}`);
  },
  historyDetail: (id: number) => request<HistoryDetail>(`/api/history/${id}`),
  /** A snapshot right now; undefined if nothing changed since the last one. */
  saveSnapshot: (target: string) => post<HistoryEntry | undefined>("/api/history", { target }),
  /** data: also put the app's data back (else its current data is kept). */
  restoreSnapshot: (id: number, data: boolean) => post<void>(`/api/history/${id}/restore`, { data }),
  undoSnapshot: (id: number, data = false) => post<{ note: string | null }>(`/api/history/${id}/undo`, { data }),

  listSites: () => request<SiteOverride[]>("/api/sites"),
  getSite: (host: string) => request<SiteOverride | null>(`/api/sites/${encodeURIComponent(host)}`),
  saveSite: (host: string, fields: Partial<Pick<SiteOverride, "css" | "js" | "enabled">>) =>
    request<SiteOverride>(`/api/sites/${encodeURIComponent(host)}`, { method: "PUT", body: JSON.stringify(fields) }),
  deleteSite: (host: string) => request<void>(`/api/sites/${encodeURIComponent(host)}`, { method: "DELETE" }),
};
