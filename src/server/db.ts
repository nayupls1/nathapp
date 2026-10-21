// Host database: the list of apps (sidebar tabs), their specs and chat history.
// Each generated app's own data lives in a separate database (see appdata.ts).
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AppSummary, ChatMessage, Effort, SiteOverride, TabKind } from "../shared/api";
import { Settings } from "../shared/settings";
import { hostOf } from "../shared/web";
import type { AppSpec } from "../shared/spec";
import { dataDir } from "./config";

const db = new Database(join(dataDir, "gapp.sqlite"), { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

db.run(`
  CREATE TABLE IF NOT EXISTS apps (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT,
    spec       TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (${now}),
    updated_at TEXT NOT NULL DEFAULT (${now})
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${now})
  )
`);

db.run(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)`);

// Columns added after the first release; created on existing databases.
const appColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(apps)").all().map((c) => c.name));
for (const [name, type] of [
  ["model", "TEXT"],
  ["effort", "TEXT"],
  ["kind", "TEXT NOT NULL DEFAULT 'app'"],
  ["url", "TEXT"],
  ["favicon", "TEXT"],
  // Set when the user renames a web tab, so page titles stop renaming it.
  ["name_locked", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  if (!appColumns.has(name)) db.run(`ALTER TABLE apps ADD COLUMN ${name} ${type}`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS site_overrides (
    host       TEXT PRIMARY KEY,
    css        TEXT NOT NULL DEFAULT '',
    js         TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (${now})
  )
`);

interface AppRow {
  id: string;
  kind: TabKind;
  name: string;
  name_locked: number;
  url: string | null;
  favicon: string | null;
  icon: string | null;
  spec: string | null;
  session_id: string | null;
  model: string | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
}

const toSummary = (r: AppRow): AppSummary => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  icon: r.icon,
  url: r.url,
  favicon: r.favicon,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const getRow = db.query<AppRow, [string]>("SELECT * FROM apps WHERE id = ?");

export function listApps(): AppSummary[] {
  return db.query<AppRow, []>("SELECT * FROM apps ORDER BY created_at").all().map(toSummary);
}

export function getApp(id: string) {
  const row = getRow.get(id);
  if (!row) return null;
  return {
    ...toSummary(row),
    spec: row.spec ? (JSON.parse(row.spec) as AppSpec) : null,
    sessionId: row.session_id,
    model: row.model,
    effort: row.effort as Effort | null,
  };
}

export function createApp(kind: TabKind = "app", url: string | null = null): AppSummary {
  const id = crypto.randomUUID();
  const name = kind === "web" ? hostOf(url) || "New tab" : "New app";
  db.query("INSERT INTO apps (id, kind, name, url) VALUES (?, ?, ?, ?)").run(id, kind, name, url);
  return toSummary(getRow.get(id)!);
}

/** Web tab navigation: remembers the URL, favicon and (unless renamed) the page title. */
export function updateWebTab(id: string, fields: { url?: string; title?: string; favicon?: string | null }) {
  const row = getRow.get(id);
  if (!row || row.kind !== "web") return null;
  const sets: string[] = [`updated_at = ${now}`];
  const params: (string | null)[] = [];
  if (fields.url !== undefined) sets.push("url = ?"), params.push(fields.url);
  if (fields.favicon !== undefined) sets.push("favicon = ?"), params.push(fields.favicon);
  if (fields.title !== undefined && !row.name_locked && fields.title.trim()) {
    sets.push("name = ?"), params.push(fields.title.trim().slice(0, 120));
  }
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return toSummary(getRow.get(id)!);
}

export function updateApp(
  id: string,
  fields: {
    name?: string;
    icon?: string | null;
    spec?: AppSpec;
    sessionId?: string;
    model?: string | null;
    effort?: Effort | null;
  },
): AppSummary | null {
  const sets: string[] = [`updated_at = ${now}`];
  const params: (string | null)[] = [];
  if (fields.name !== undefined) sets.push("name = ?", "name_locked = 1"), params.push(fields.name);
  if (fields.icon !== undefined) sets.push("icon = ?"), params.push(fields.icon);
  if (fields.spec !== undefined) sets.push("spec = ?"), params.push(JSON.stringify(fields.spec));
  if (fields.sessionId !== undefined) sets.push("session_id = ?"), params.push(fields.sessionId);
  if (fields.model !== undefined) sets.push("model = ?"), params.push(fields.model);
  if (fields.effort !== undefined) sets.push("effort = ?"), params.push(fields.effort);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  const row = getRow.get(id);
  return row ? toSummary(row) : null;
}

/** Copies an app's name, icon, spec and agent settings (not its chat) to a new app. */
export function duplicateApp(id: string): AppSummary | null {
  const source = getRow.get(id);
  if (!source) return null;
  const copyId = crypto.randomUUID();
  db.query("INSERT INTO apps (id, kind, name, icon, spec, model, effort, url, favicon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    copyId,
    source.kind,
    `${source.name} copy`,
    source.icon,
    source.spec,
    source.model,
    source.effort,
    source.url,
    source.favicon,
  );
  return toSummary(getRow.get(copyId)!);
}

/** Deletes the chat history and forgets the agent session, so the next message starts fresh. */
export function clearMessages(appId: string) {
  db.transaction(() => {
    db.query("DELETE FROM messages WHERE app_id = ?").run(appId);
    db.query(`UPDATE apps SET session_id = NULL, updated_at = ${now} WHERE id = ?`).run(appId);
  })();
}

export function deleteApp(id: string) {
  db.query("DELETE FROM apps WHERE id = ?").run(id);
}

interface MessageRow {
  id: number;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
}

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
});

export function listMessages(appId: string): ChatMessage[] {
  return db
    .query<MessageRow, [string]>("SELECT * FROM messages WHERE app_id = ? ORDER BY id")
    .all(appId)
    .map(toMessage);
}

export function addMessage(appId: string, role: ChatMessage["role"], content: string): ChatMessage {
  const row = db
    .query<MessageRow, [string, string, string]>(
      "INSERT INTO messages (app_id, role, content) VALUES (?, ?, ?) RETURNING *",
    )
    .get(appId, role, content)!;
  return toMessage(row);
}

// --- Settings --------------------------------------------------------------------

/** The user's settings, with defaults for anything unset or invalid. */
export function getSettings(): Settings {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE id = 1").get();
  const parsed = Settings.safeParse(row ? JSON.parse(row.value) : {});
  return parsed.success ? parsed.data : Settings.parse({});
}

export function saveSettings(settings: Settings) {
  db.query("INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(settings),
  );
}

// --- Site overrides (web tabs) ------------------------------------------------------

interface OverrideRow {
  host: string;
  css: string;
  js: string;
  enabled: number;
  updated_at: string;
}

const toOverride = (r: OverrideRow): SiteOverride => ({
  host: r.host,
  css: r.css,
  js: r.js,
  enabled: r.enabled === 1,
  updatedAt: r.updated_at,
});

export function getOverride(host: string): SiteOverride | null {
  const row = db.query<OverrideRow, [string]>("SELECT * FROM site_overrides WHERE host = ?").get(host);
  return row ? toOverride(row) : null;
}

export function listOverrides(): SiteOverride[] {
  return db.query<OverrideRow, []>("SELECT * FROM site_overrides ORDER BY host").all().map(toOverride);
}

export function saveOverride(host: string, fields: { css?: string; js?: string; enabled?: boolean }): SiteOverride {
  const current = getOverride(host);
  const next = {
    css: fields.css ?? current?.css ?? "",
    js: fields.js ?? current?.js ?? "",
    enabled: fields.enabled ?? current?.enabled ?? true,
  };
  db.query(
    `INSERT INTO site_overrides (host, css, js, enabled, updated_at) VALUES (?, ?, ?, ?, ${now})
     ON CONFLICT (host) DO UPDATE SET css = excluded.css, js = excluded.js, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(host, next.css, next.js, next.enabled ? 1 : 0);
  return getOverride(host)!;
}

export function deleteOverride(host: string) {
  db.query("DELETE FROM site_overrides WHERE host = ?").run(host);
}
