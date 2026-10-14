import type { AppDetail, AppSummary, ChatEvent, DataRequest, DataResponse } from "../../shared/api";

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
  listApps: () => request<AppSummary[]>("/api/apps"),
  createApp: () => request<AppSummary>("/api/apps", { method: "POST" }),
  getApp: (id: string) => request<AppDetail>(`/api/apps/${id}`),
  renameApp: (id: string, name: string) =>
    request<AppSummary>(`/api/apps/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteApp: (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" }),
  stop: (id: string) => request<void>(`/api/apps/${id}/stop`, { method: "POST" }),

  data: <T extends DataResponse>(id: string, req: DataRequest) =>
    request<T>(`/api/apps/${id}/data`, { method: "POST", body: JSON.stringify(req) }),

  /** Sends a prompt to the agent and calls `onEvent` for each streamed event. */
  async chat(id: string, prompt: string, onEvent: (event: ChatEvent) => void) {
    const res = await fetch(url(`/api/apps/${id}/chat`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
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
