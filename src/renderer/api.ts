import type { HealthResponse, HelloResponse } from "../shared/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${window.gapp.serverUrl}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<HealthResponse>("/api/health"),
  hello: (name: string) => get<HelloResponse>(`/api/hello?name=${encodeURIComponent(name)}`),
};
