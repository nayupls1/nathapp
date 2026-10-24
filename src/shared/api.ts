// Types shared between the Bun server, the Electron main/preload and the renderer.

export interface HealthResponse {
  ok: true;
  uptime: number;
  bun: string;
  dataDir: string;
}

/** API exposed on `window.nathapp` by the preload script. */
export interface NathAppBridge {
  serverUrl: string;
  /** Sent with every request to the NathApp server (and the hub). */
  token: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  web: {
    /** Session partition of web tabs (separate cookies/storage from NathApp itself). */
    partition: string;
    /** A page asked to open a link in a new window: open it in a new web tab. */
    onOpenTab: (fn: (url: string) => void) => () => void;
    /** A browser shortcut pressed while a web page had focus. */
    onShortcut: (fn: (name: WebShortcut) => void) => () => void;
    /** Screenshot of a page (web tab or app preview) as base64 JPEG. */
    capture: (webContentsId: number) => Promise<string>;
    /** Opens a URL in the system browser. */
    openExternal: (url: string) => void;
  };
}

export const WEB_PARTITION = "persist:web";
/** Each app's preview gets its own session: apps all live on 127.0.0.1, and cookies don't separate ports. */
export const appPartition = (appId: string) => `persist:app-${appId}`;
export const APP_PARTITION_PATTERN = /^persist:app-[\w-]+$/;

export type WebShortcut = "toggle-agent" | "focus-address" | "reload" | "back" | "forward" | "new-tab";

// --- Providers ------------------------------------------------------------------

export const providerIds = ["claude", "codex", "opencode"] as const;
export type ProviderId = (typeof providerIds)[number];

/** Reasoning effort. Providers support different levels; each model lists its own. */
export type Effort = string;

export const effortLabels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export interface ProviderModel {
  /** What the provider expects (OpenCode: "provider/model"). */
  id: string;
  name: string;
  description?: string;
  /** Effort levels the model supports; empty if it has none. */
  efforts: Effort[];
  /** Grouping in the picker (OpenCode: the upstream provider). */
  group?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  enabled: boolean;
  /**
   * ready: usable. missing: not installed. signed-out: needs a login.
   * error: something else is wrong (see message). disabled: turned off in Settings.
   */
  state: "ready" | "missing" | "signed-out" | "error" | "disabled" | "checking";
  version: string | null;
  /** Binary that runs, for Settings. */
  binary: string | null;
  /** What's wrong or how to fix it. */
  message: string | null;
  models: ProviderModel[];
  /** The model used when none is picked. */
  defaultModel: string | null;
}

/**
 * The model apps' AI requests use unless Settings pick one: a fast, cheap one
 * where the provider has it (app requests are many and small), else the
 * provider's default.
 */
export const defaultAppModel = (status: Pick<ProviderStatus, "models" | "defaultModel">): string | null =>
  (status.models.find((m) => m.id === "haiku") ?? status.models.find((m) => /haiku/i.test(m.id)))?.id ?? status.defaultModel;

export interface AgentChoice {
  provider: ProviderId;
  /** null: the provider's default model. */
  model: string | null;
  effort: Effort | null;
}

// --- Apps and web tabs (one per sidebar tab) ------------------------------------

export type TabKind = "app" | "web";

export interface AppSummary {
  id: string;
  /** "app": a project built by the agent; "web": a browser tab. */
  kind: TabKind;
  name: string;
  /** Lucide icon name chosen by the agent. */
  icon: string | null;
  /** Web tabs: current URL and favicon. */
  url: string | null;
  favicon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppDetail extends AppSummary {
  messages: ChatMessage[];
  running: boolean;
  /** Last provider/model/effort used for this tab (null = the defaults from Settings). */
  agent: AgentChoice | null;
  /** Apps only. */
  project: ProjectInfo | null;
  runtime: RuntimeStatus | null;
}

/** An app's project: its folder and nathapp.json. Null until the agent set one up. */
export interface ProjectInfo {
  dir: string;
  manifest: Manifest;
}

/** nathapp.json at the root of an app's project. */
export interface Manifest {
  /** The preset the project started from. */
  preset?: string;
  /** Install dependencies (run when package.json/lockfile changed). Default: "bun install" if there is a package.json. */
  install?: string;
  /** Dev server with live reload, listening on $PORT. */
  dev: string;
  /** Production build (optional). */
  build?: string;
  /** Serve the built app on $PORT. */
  start: string;
}

/** dev: the agent is working on it (dev server, live reload). live: done (built, start command). */
export type AppMode = "dev" | "live";

export interface RuntimeStatus {
  mode: AppMode;
  state: "stopped" | "installing" | "building" | "starting" | "running" | "crashed";
  /** Where the preview is served (127.0.0.1:port) once running. */
  url: string | null;
  port: number | null;
  exitCode: number | null;
  /** Why it isn't running (crash, failed build…). */
  error: string | null;
  startedAt: string | null;
  /** How the app's processes are isolated. */
  sandbox: SandboxKind;
}

export type SandboxKind = "bwrap" | "none";

export interface LogLine {
  /** Milliseconds since the epoch. */
  at: number;
  stream: "out" | "err" | "system";
  text: string;
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  /** Frontend / backend summary, e.g. "React · Bun API · SQLite". */
  stack: string;
}

// --- Chat ----------------------------------------------------------------------

export interface ChatRequest {
  prompt: string;
  agent?: Partial<AgentChoice>;
  /** Web tabs and app previews: the page and the elements the user picked. */
  page?: PageContext;
}

/** An element picked in a page, as described by the picker script. */
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
  /**
   * tool: one line of agent activity ("Edited src/App.tsx").
   * context: what the user pointed at (picked elements) with their message.
   * secret: the agent asks the user for a secret (JSON: { name, description }).
   */
  role: "user" | "assistant" | "tool" | "error" | "context" | "secret";
  content: string;
  createdAt: string;
}

/** Pushed on the hub topic `app:<id>` while the agent works. */
export type ChatEvent =
  | { type: "started" }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "done" };

// --- Web tabs -----------------------------------------------------------------------

/** CSS/JS the website agent made for a site, applied whenever it loads. */
export interface SiteOverride {
  host: string;
  css: string;
  js: string;
  enabled: boolean;
  updatedAt: string;
}

// --- Secrets ----------------------------------------------------------------------

/** "global", or the id of the app tab the secret belongs to. */
export type SecretScope = "global" | (string & {});

/** A secret without its value: values never leave the server once saved. */
export interface SecretInfo {
  id: string;
  scope: SecretScope;
  /** Environment variable name, e.g. STRIPE_KEY. */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Last time an app was started with it. */
  lastUsedAt: string | null;
}

export interface SecretsOverview {
  /**
   * keychain: the encryption key is protected by the OS keychain.
   * file: by file permissions only (no keychain available).
   * locked: the key can't be unlocked, secrets can't be used.
   */
  protection: "keychain" | "file" | "locked";
  secrets: SecretInfo[];
}

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Names NathApp sets itself (or that would break app processes). */
export const isReservedSecretName = (name: string) =>
  /^(NATHAPP_|BUN_|NODE_|NPM_|LD_|DYLD_)/.test(name) ||
  ["PORT", "HOST", "APP_URL", "DATABASE_PATH", "DATABASE_URL", "PATH", "HOME", "TMPDIR", "LANG", "NO_COLOR", "SHELL", "USER"].includes(name);

// --- Permissions and audit log ----------------------------------------------------

/**
 * app.ai: an app's server uses AI (resource: "").
 * app.secret: an app uses a global secret (resource: its name).
 * agent.site: the website agent customizes a site (subject "website-agent", resource: the host).
 */
export type PermissionAction = "app.ai" | "app.secret" | "agent.site";

export interface PermissionGrant {
  id: number;
  /** An app id, or "website-agent". */
  subject: string;
  subjectName: string;
  action: PermissionAction;
  resource: string;
  decision: "allow" | "deny";
  createdAt: string;
}

/** Something waiting for the user's answer. */
export interface PermissionRequest {
  id: string;
  subject: string;
  subjectName: string;
  action: PermissionAction;
  resource: string;
  title: string;
  detail: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  /** Who did it. */
  actor: "user" | "agent" | "app" | "nathapp";
  /** e.g. "Claude Code (haiku)", the app's name, "You". */
  actorLabel: string;
  /** The tab it happened in, if any. */
  tabId: string | null;
  /** e.g. "tool.run_command", "secret.create", "ai.request", "permission.allow". */
  action: string;
  /** What was affected (file, secret name, host…). Never secret values. */
  target: string | null;
  detail: string | null;
  outcome: "ok" | "denied" | "error";
}
