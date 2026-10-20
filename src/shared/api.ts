// Types shared between the Bun server, the Electron main/preload and the renderer.
import type { Action, Aggregate, AppSpec, Bucket, Sort, Value, Where } from "./spec";

export interface HealthResponse {
  ok: true;
  uptime: number;
  bun: string;
  dataDir: string;
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
  /** Last model/effort used for this app's agent (null = default). */
  model: string | null;
  effort: Effort | null;
}

export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof efforts)[number];

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  /** Effort levels the model supports; empty if it has no effort setting. */
  efforts: Effort[];
}

export interface ChatRequest {
  prompt: string;
  model?: string;
  effort?: Effort;
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
      seriesBy?: string;
    }
  | { op: "action"; action: Action };

export type DataResponse =
  | { rows: Row[] }
  | { value: number | null }
  | { groups: { key: Value; series?: Value; value: number | null }[] }
  | { changes: number };
