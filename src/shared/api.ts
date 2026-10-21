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
  web: {
    /** Session partition of web tabs (separate cookies/storage from gApp itself). */
    partition: string;
    /** A page asked to open a link in a new window: open it in a new web tab. */
    onOpenTab: (fn: (url: string) => void) => () => void;
    /** A browser shortcut pressed while a web page had focus. */
    onShortcut: (fn: (name: WebShortcut) => void) => () => void;
    /** Screenshot of a web tab's page as base64 JPEG. */
    capture: (webContentsId: number) => Promise<string>;
  };
}

export const WEB_PARTITION = "persist:web";

export type WebShortcut = "toggle-agent" | "focus-address" | "reload" | "back" | "forward" | "new-tab";

// --- Apps (one per sidebar tab) --------------------------------------------

export type TabKind = "app" | "web";

export interface AppSummary {
  id: string;
  /** "app": built by the agent from the catalog; "web": a browser tab. */
  kind: TabKind;
  name: string;
  icon: string | null;
  /** Web tabs: current URL and favicon. */
  url: string | null;
  favicon: string | null;
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
  /** Web tabs: the page and the elements the user picked. */
  page?: PageContext;
}

/** An element picked in a web tab, as described by the picker script. */
export interface ElementInfo {
  /** Unique-ish CSS selector for the element. */
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

export interface PageContext {
  url: string;
  title: string;
  selection: ElementInfo[];
}

export interface ChatMessage {
  id: number;
  /** "context": what the user pointed at (picked elements) with their message. */
  role: "user" | "assistant" | "tool" | "error" | "context";
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

// --- Custom app backends ----------------------------------------------------------

/** Entry point of an app's custom backend. */
export const BACKEND_ENTRY = "server.ts";

export interface BackendStatus {
  /** Whether the app has a server.ts at all. */
  exists: boolean;
  state: "stopped" | "starting" | "running" | "crashed";
  port: number | null;
  startedAt: string | null;
  exitCode: number | null;
  pid: number | null;
}

export interface RuntimeInfo {
  status: BackendStatus;
  logs: string[];
  files: { path: string; size: number }[];
}

// --- Web tabs -----------------------------------------------------------------------

/** CSS/JS the website agent made for a site, applied whenever it loads. */
export interface SiteOverride {
  host: string;
  css: string;
  js: string;
  enabled: boolean;
  updatedAt: string;
}
