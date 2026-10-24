// The host database (nathapp.sqlite): tabs, chat history, settings and site
// customizations. Apps keep their own data inside their project folders.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { ServerConfig } from "../Config";

export const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

type Fn = (...args: any[]) => Effect.Effect<any, any, any>;

/** A repository with database errors turned into defects. */
export type OrDie<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any, infer C> ? (...args: A) => Effect.Effect<R, never, C> : T[K];
};

/** Database errors are defects: there is nothing a caller could do about them. */
export const orDieAll = <T extends Record<string, Fn>>(repo: T) =>
  Object.fromEntries(Object.entries(repo).map(([k, fn]) => [k, (...args: unknown[]) => Effect.orDie(fn(...args))])) as OrDie<T>;

const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("PRAGMA foreign_keys = ON");
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS apps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      icon       TEXT,
      created_at TEXT NOT NULL DEFAULT (${now}),
      updated_at TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS messages_app ON messages (app_id, id)");
  yield* sql.unsafe("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
  // AI requests per app and day (AI for apps has a daily limit).
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      app_id   TEXT NOT NULL,
      day      TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, day)
    )`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS site_overrides (
      host       TEXT PRIMARY KEY,
      css        TEXT NOT NULL DEFAULT '',
      js         TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (${now})
    )`);

  // Encrypted secrets (see security/Vault.ts): "global" or an app id as scope.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS secrets (
      id           TEXT PRIMARY KEY,
      scope        TEXT NOT NULL,
      name         TEXT NOT NULL,
      value        TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (${now}),
      updated_at   TEXT NOT NULL DEFAULT (${now}),
      last_used_at TEXT,
      UNIQUE (scope, name)
    )`);
  // Remembered permission decisions.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS permissions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      subject    TEXT NOT NULL,
      action     TEXT NOT NULL,
      resource   TEXT NOT NULL DEFAULT '',
      decision   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${now}),
      UNIQUE (subject, action, resource)
    )`);
  // What agents, apps and the user did.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT NOT NULL DEFAULT (${now}),
      actor       TEXT NOT NULL,
      actor_label TEXT NOT NULL,
      tab_id      TEXT,
      action      TEXT NOT NULL,
      target      TEXT,
      detail      TEXT,
      outcome     TEXT NOT NULL DEFAULT 'ok'
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS audit_tab ON audit (tab_id, id)");

  // Columns added over time; created on existing databases.
  const columns = new Set((yield* sql.unsafe<{ name: string }>("PRAGMA table_info(apps)")).map((c) => c.name));
  const added: [string, string][] = [
    ["kind", "TEXT NOT NULL DEFAULT 'app'"],
    ["url", "TEXT"],
    ["favicon", "TEXT"],
    // Set when the user renames a tab, so page titles / the agent stop renaming it.
    ["name_locked", "INTEGER NOT NULL DEFAULT 0"],
    // The agent: provider, model, effort, and the provider's session to resume.
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["effort", "TEXT"],
    ["session_id", "TEXT"],
    ["session_provider", "TEXT"],
    // dev (being edited: dev server) or live (done: built and started).
    ["mode", "TEXT NOT NULL DEFAULT 'dev'"],
  ];
  for (const [name, type] of added) {
    if (!columns.has(name)) yield* sql.unsafe(`ALTER TABLE apps ADD COLUMN ${name} ${type}`);
  }
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const filename = join(config.dataDir, "nathapp.sqlite");
    // The database of NathApp's earlier name (gApp) carries over.
    const legacy = join(config.dataDir, "gapp.sqlite");
    if (!existsSync(filename) && existsSync(legacy)) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(legacy + suffix)) renameSync(legacy + suffix, filename + suffix);
    }
    const client = SqliteClient.layer({ filename });
    return Layer.effectDiscard(migrate).pipe(Layer.provideMerge(client));
  }),
).pipe(Layer.orDie);
