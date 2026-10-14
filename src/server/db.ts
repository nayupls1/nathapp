// Host database: the list of apps (sidebar tabs), their specs and chat history.
// Each generated app's own data lives in a separate database (see appdata.ts).
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AppSummary, ChatMessage, Effort } from "../shared/api";
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

// Columns added after the first release; created on existing databases.
const appColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(apps)").all().map((c) => c.name));
for (const [name, type] of [
  ["model", "TEXT"],
  ["effort", "TEXT"],
] as const) {
  if (!appColumns.has(name)) db.run(`ALTER TABLE apps ADD COLUMN ${name} ${type}`);
}

interface AppRow {
  id: string;
  name: string;
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
  name: r.name,
  icon: r.icon,
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

export function createApp(name = "New app"): AppSummary {
  const id = crypto.randomUUID();
  db.query("INSERT INTO apps (id, name) VALUES (?, ?)").run(id, name);
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
  if (fields.name !== undefined) sets.push("name = ?"), params.push(fields.name);
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
  db.query("INSERT INTO apps (id, name, icon, spec, model, effort) VALUES (?, ?, ?, ?, ?, ?)").run(
    copyId,
    `${source.name} copy`,
    source.icon,
    source.spec,
    source.model,
    source.effort,
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
