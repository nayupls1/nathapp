// Managed app data: every app's storage is NathApp's, not the project's. It
// lives in <dataDir>/appdata/<id> (a SQLite database and a folder for files),
// outside the project folder, so rebuilding, resetting or rewriting the
// project leaves it alone and the agent's file tools never touch it. App
// processes get it mounted into their sandbox (DATABASE_PATH,
// NATHAPP_FILES_DIR); other apps only through NathApp, after the user allows it.
//
// The user can look at an app's tables, export everything and delete it. It's
// part of the app's snapshots (history/History.ts, under "@data/").
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import type { DataColumn, DataOverview, DataRows, DataTable } from "../../shared/api";
import { ServerConfig } from "../Config";
import { Workspace } from "./Workspace";

export class AppDataError extends Data.TaggedError("AppDataError")<{ readonly status: 400 | 404; readonly message: string }> {}

/** Where an app's data shows up in its snapshots. */
export const DATA_PREFIX = "@data/";
export const DATABASE_FILE = "data.sqlite";
const SQLITE_SUFFIXES = ["", "-wal", "-shm", "-journal"];
const MAX_PAGE = 500;
/** Rows per table in an export's JSON (the database itself is always complete). */
const MAX_EXPORT_ROWS = 50_000;

export interface RowQuery {
  readonly offset?: number;
  readonly limit?: number;
  /** Text to look for in any text column. */
  readonly search?: string;
  /** Columns that must equal these values. */
  readonly where?: Record<string, string | number | null>;
  readonly orderBy?: string;
  readonly desc?: boolean;
}

export interface AppDataShape {
  /** The app's data folder (created, and moved out of an old project's .nathapp/ the first time). */
  readonly ensure: (appId: string) => Effect.Effect<{ dir: string; database: string; files: string }>;
  readonly dir: (appId: string) => string;
  readonly overview: (appId: string) => Effect.Effect<DataOverview>;
  readonly rows: (appId: string, table: string, query: RowQuery) => Effect.Effect<DataRows, AppDataError>;
  /** A .tar.gz: the database, its tables as JSON and the app's files. */
  readonly exportArchive: (appId: string) => Effect.Effect<Uint8Array>;
  /** Deletes the app's database and files (stop the app first). */
  readonly clear: (appId: string) => Effect.Effect<void>;
  /** Deletes the data folder (the app was deleted). */
  readonly remove: (appId: string) => Effect.Effect<void>;
}

export class AppData extends Context.Service<AppData, AppDataShape>()("nathapp/AppData") {}

export const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** JSON-friendly values: blobs as a size, big integers as text. */
const cell = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
};

/** Opens the database read-only; null when there is none (yet). */
function openReadOnly(file: string): Database | null {
  if (!existsSync(file)) return null;
  try {
    const db = new Database(file, { readonly: true });
    db.run("PRAGMA busy_timeout = 2000");
    return db;
  } catch {
    return null;
  }
}

function tablesOf(db: Database): DataTable[] {
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return names.map((name) => ({
    name,
    rows: db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${quoteName(name)}`).get()!.n,
    columns: columnsOf(db, name),
  }));
}

function columnsOf(db: Database, table: string): DataColumn[] {
  return db
    .query<{ name: string; type: string; pk: number; notnull: number }, []>(`PRAGMA table_info(${quoteName(table)})`)
    .all()
    .map((c) => ({ name: c.name, type: c.type || "", primaryKey: c.pk > 0 }));
}

async function walkFiles(dir: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const walk = async (abs: string, rel: string) => {
    for (const entry of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(abs, entry.name), path);
      else if (entry.isFile()) out.push({ path, size: (await stat(join(abs, entry.name)).catch(() => ({ size: 0 }))).size });
    }
  };
  await walk(dir, "");
  return out;
}

/** Reads rows with optional search, equality filters and order; names are checked against the table's columns. */
export function queryRows(db: Database, table: string, query: RowQuery): DataRows | string {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  if (!tables.some((t) => t.name === table)) return `No table "${table}"`;
  const columns = columnsOf(db, table);
  const known = new Set(columns.map((c) => c.name));
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [column, value] of Object.entries(query.where ?? {})) {
    if (!known.has(column)) return `No column "${column}" in ${table}`;
    if (value === null) clauses.push(`${quoteName(column)} IS NULL`);
    else {
      clauses.push(`${quoteName(column)} = ?`);
      params.push(value);
    }
  }
  const search = query.search?.trim();
  if (search) {
    const text = columns.filter((c) => !/INT|REAL|FLOA|DOUB|NUM|BLOB|BOOL/i.test(c.type));
    const searchable = text.length ? text : columns;
    clauses.push(`(${searchable.map((c) => `CAST(${quoteName(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    for (const _ of searchable) params.push(like);
  }
  if (query.orderBy && !known.has(query.orderBy)) return `No column "${query.orderBy}" in ${table}`;
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = query.orderBy ? ` ORDER BY ${quoteName(query.orderBy)}${query.desc ? " DESC" : ""}` : query.desc ? " ORDER BY rowid DESC" : "";
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), MAX_PAGE);
  const offset = Math.max(Math.floor(query.offset ?? 0), 0);
  const from = `FROM ${quoteName(table)}${where}`;
  const total = db.query<{ n: number }, (string | number | null)[]>(`SELECT COUNT(*) AS n ${from}`).get(...params)!.n;
  const rows = db
    .query<Record<string, unknown>, (string | number | null)[]>(`SELECT * ${from}${order} LIMIT ${limit} OFFSET ${offset}`)
    .all(...params)
    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])));
  return { table, columns, rows, total, offset, limit };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const workspace = yield* Workspace;
  const root = join(config.dataDir, "appdata");
  const dir = (appId: string) => join(root, appId);
  const databaseOf = (appId: string) => join(dir(appId), DATABASE_FILE);
  const filesOf = (appId: string) => join(dir(appId), "files");

  const ensure = (appId: string) =>
    Effect.sync(() => {
      mkdirSync(filesOf(appId), { recursive: true });
      // Projects from before managed data kept their database in .nathapp/: it moves here once.
      const legacy = join(workspace.stateDir(appId), DATABASE_FILE);
      if (existsSync(legacy) && !existsSync(databaseOf(appId))) {
        for (const suffix of SQLITE_SUFFIXES) if (existsSync(legacy + suffix)) renameSync(legacy + suffix, databaseOf(appId) + suffix);
      }
      return { dir: dir(appId), database: databaseOf(appId), files: filesOf(appId) };
    });

  return {
    ensure,
    dir,

    overview: (appId) =>
      Effect.gen(function* () {
        yield* ensure(appId);
        const database = databaseOf(appId);
        const db = openReadOnly(database);
        let tables: DataTable[] = [];
        let error: string | null = null;
        try {
          if (db) tables = tablesOf(db);
        } catch (err) {
          error = `The database can't be read: ${(err as Error).message}`;
        } finally {
          db?.close();
        }
        const files = yield* Effect.promise(() => walkFiles(filesOf(appId)));
        const databaseBytes = yield* Effect.promise(async () => {
          let total = 0;
          for (const suffix of ["", "-wal"]) total += await stat(database + suffix).then((s) => s.size, () => 0);
          return total;
        });
        return {
          tables,
          databaseBytes,
          files: { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
          error,
        } satisfies DataOverview;
      }),

    rows: (appId, table, query) =>
      Effect.gen(function* () {
        yield* ensure(appId);
        const db = openReadOnly(databaseOf(appId));
        if (!db) return yield* new AppDataError({ status: 404, message: "The app has no data yet" });
        let result: DataRows | string;
        try {
          result = queryRows(db, table, query);
        } catch (err) {
          result = (err as Error).message;
        } finally {
          db.close();
        }
        if (typeof result === "string") return yield* new AppDataError({ status: result.startsWith("No ") ? 404 : 400, message: result });
        return result;
      }),

    exportArchive: (appId) =>
      Effect.gen(function* () {
        yield* ensure(appId);
        const entries: Record<string, Uint8Array | string> = {};
        const db = existsSync(databaseOf(appId)) ? new Database(databaseOf(appId)) : null;
        try {
          if (db) {
            db.run("PRAGMA busy_timeout = 2000");
            // A consistent copy, with what's still in the WAL.
            entries[DATABASE_FILE] = db.serialize();
            for (const table of tablesOf(db)) {
              const rows = db
                .query<Record<string, unknown>, []>(`SELECT * FROM ${quoteName(table.name)} LIMIT ${MAX_EXPORT_ROWS}`)
                .all()
                .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])));
              entries[`tables/${table.name.replace(/[^\w.-]/g, "_")}.json`] = `${JSON.stringify(rows, null, 2)}\n`;
            }
          }
        } finally {
          db?.close();
        }
        for (const file of yield* Effect.promise(() => walkFiles(filesOf(appId)))) {
          const bytes = yield* Effect.promise(() => readFile(join(filesOf(appId), file.path)).then((b) => new Uint8Array(b), () => null));
          if (bytes) entries[`files/${file.path}`] = bytes;
        }
        if (!Object.keys(entries).length) entries["README.txt"] = "This app has no data yet.\n";
        return yield* Effect.promise(() => new Bun.Archive(entries, { compress: "gzip" }).bytes());
      }),

    clear: (appId) =>
      Effect.promise(async () => {
        for (const suffix of SQLITE_SUFFIXES) await rm(databaseOf(appId) + suffix, { force: true });
        await rm(filesOf(appId), { recursive: true, force: true });
        mkdirSync(filesOf(appId), { recursive: true });
      }),

    remove: (appId) => Effect.promise(() => rm(dir(appId), { recursive: true, force: true })),
  } satisfies AppDataShape;
});

export const layer = Layer.effect(AppData, make);
