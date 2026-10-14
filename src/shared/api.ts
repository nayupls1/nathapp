// Types shared between the Bun server, the Electron main/preload and the renderer.
import type { Action, Aggregate, AppSpec, Bucket, Sort, Value, Where } from "./spec";

export interface HealthResponse {
  ok: true;
  uptime: number;
  bun: string;
}

/** API exposed on `window.gapp` by the preload script. */
export interface GappBridge {
  serverUrl: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

// --- Apps (one per sidebar tab) --------------------------------------------

export interface AppSummary {
  id: string;
  name: string;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppDetail extends AppSummary {
  spec: AppSpec | null;
  messages: ChatMessage[];
  running: boolean;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  createdAt: string;
}

/** Streamed (as NDJSON) from `POST /api/apps/:id/chat`. */
export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "spec"; spec: AppSpec }
  | { type: "app"; app: AppSummary }
  | { type: "done" };

// --- Generated app data ----------------------------------------------------

export type Row = { id: number; created_at: string } & Record<string, Value>;

export type DataRequest =
  | { op: "query"; table: string; where?: Where; sort?: Sort; limit?: number }
  | {
      op: "aggregate";
      table: string;
      aggregate: Aggregate;
      column?: string;
      where?: Where;
      groupBy?: string;
      bucket?: Bucket;
    }
  | { op: "action"; action: Action };

export type DataResponse =
  | { rows: Row[] }
  | { value: number | null }
  | { groups: { key: Value; value: number | null }[] }
  | { changes: number };
