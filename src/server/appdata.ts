// Data layer for generated apps. Every app gets its own SQLite file whose
// tables are derived from the app spec. All SQL is built here from validated
// identifiers; values are always bound as parameters.
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DataRequest, DataResponse, Row } from "../shared/api";
import { Action, Aggregate, type AppSpec, Bucket, type Column, Sort, type Table, type Value, Where } from "../shared/spec";
import { appsDir } from "./config";

const handles = new Map<string, Database>();

function open(appId: string): Database {
  let db = handles.get(appId);
  if (!db) {
    db = new Database(join(appsDir, `${appId}.sqlite`), { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL");
    handles.set(appId, db);
  }
  return db;
}

export function deleteAppData(appId: string) {
  handles.get(appId)?.close();
  handles.delete(appId);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(appsDir, `${appId}.sqlite${suffix}`), { force: true });
}

const q = (ident: string) => `"${ident}"`;

const bucketFormat: Record<Bucket, string> = {
  day: "%Y-%m-%d",
  week: "%Y-W%W",
  month: "%Y-%m",
  year: "%Y",
};

const sqlType: Record<Column["type"], string> = {
  text: "TEXT",
  number: "REAL",
  boolean: "INTEGER",
  date: "TEXT",
};

/**
 * Brings the app's database in line with its spec. Additive only: new tables
 * and columns are created, but nothing is ever dropped, so data survives the
 * agent reshaping the app.
 */
export function migrate(appId: string, spec: AppSpec) {
  const db = open(appId);
  db.transaction(() => {
    for (const table of spec.tables) {
      db.run(
        `CREATE TABLE IF NOT EXISTS ${q(table.name)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )`,
      );
      const existing = new Set(
        db.query<{ name: string }, []>(`PRAGMA table_info(${q(table.name)})`).all().map((c) => c.name),
      );
      for (const col of table.columns) {
        if (!existing.has(col.name)) db.run(`ALTER TABLE ${q(table.name)} ADD COLUMN ${q(col.name)} ${sqlType[col.type]}`);
      }
    }
  })();
}

export function rowCounts(appId: string, spec: AppSpec): Record<string, number> {
  const db = open(appId);
  return Object.fromEntries(
    spec.tables.map((t) => [t.name, db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).get()!.n]),
  );
}

// --- Request handling --------------------------------------------------------

export class DataError extends Error {}

const DataRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("query"),
    table: z.string(),
    where: Where.optional(),
    sort: Sort.optional(),
    limit: z.number().int().positive().max(10_000).optional(),
  }),
  z.object({
    op: z.literal("aggregate"),
    table: z.string(),
    aggregate: Aggregate,
    column: z.string().optional(),
    where: Where.optional(),
    groupBy: z.string().optional(),
    bucket: Bucket.optional(),
  }),
  z.object({ op: z.literal("action"), action: Action }),
]);

function getTable(spec: AppSpec, name: string): Table {
  const table = spec.tables.find((t) => t.name === name);
  if (!table) throw new DataError(`Unknown table "${name}"`);
  return table;
}

const builtinColumns: Column[] = [
  { name: "id", type: "number" },
  { name: "created_at", type: "text" },
];

function getColumn(table: Table, name: string): Column {
  const col = [...builtinColumns, ...table.columns].find((c) => c.name === name);
  if (!col) throw new DataError(`Table "${table.name}" has no column "${name}"`);
  return col;
}

function toSql(col: Column, value: Value): string | number | null {
  if (value === null || value === "") return null;
  switch (col.type) {
    case "boolean":
      return value === true || value === 1 || value === "true" ? 1 : 0;
    case "number": {
      const n = Number(value);
      if (Number.isNaN(n)) throw new DataError(`"${col.name}" must be a number`);
      return n;
    }
    default:
      if (col.options && !col.options.includes(String(value))) {
        throw new DataError(`"${col.name}" must be one of: ${col.options.join(", ")}`);
      }
      return String(value);
  }
}

function fromSql(table: Table, raw: Record<string, unknown>): Row {
  const row: Record<string, Value> = { id: raw.id as number, created_at: raw.created_at as string };
  for (const col of table.columns) {
    const v = raw[col.name] as string | number | null | undefined;
    row[col.name] = v == null ? null : col.type === "boolean" ? v === 1 : v;
  }
  return row as Row;
}

function whereClause(table: Table, where: Where | undefined) {
  const parts: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [name, value] of Object.entries(where ?? {})) {
    const col = getColumn(table, name);
    const v = toSql(col, value);
    if (v === null) parts.push(`${q(name)} IS NULL`);
    else parts.push(`${q(name)} = ?`), params.push(v);
  }
  return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

function writableValues(table: Table, values: Record<string, Value>) {
  return Object.entries(values).map(([name, value]) => {
    const col = table.columns.find((c) => c.name === name);
    if (!col) throw new DataError(`Table "${table.name}" has no writable column "${name}"`);
    return [name, toSql(col, value)] as const;
  });
}

export function runData(appId: string, spec: AppSpec, input: DataRequest): DataResponse {
  const parsed = DataRequestSchema.safeParse(input);
  if (!parsed.success) throw new DataError(z.prettifyError(parsed.error));
  const req = parsed.data;
  const db = open(appId);

  if (req.op === "query") {
    const table = getTable(spec, req.table);
    const where = whereClause(table, req.where);
    let sql = `SELECT * FROM ${q(table.name)}${where.sql}`;
    if (req.sort) sql += ` ORDER BY ${q(getColumn(table, req.sort.column).name)} ${req.sort.dir === "desc" ? "DESC" : "ASC"}`;
    else sql += " ORDER BY id";
    sql += ` LIMIT ${req.limit ?? 1000}`;
    const rows = db.query<Record<string, unknown>, (string | number | null)[]>(sql).all(...where.params);
    return { rows: rows.map((r) => fromSql(table, r)) };
  }

  if (req.op === "aggregate") {
    const table = getTable(spec, req.table);
    if (req.aggregate !== "count" && !req.column) throw new DataError(`"${req.aggregate}" needs a column`);
    const expr =
      req.aggregate === "count" ? "COUNT(*)" : `${req.aggregate.toUpperCase()}(${q(getColumn(table, req.column!).name)})`;
    const where = whereClause(table, req.where);
    if (req.groupBy) {
      const groupCol = getColumn(table, req.groupBy);
      const key = req.bucket ? `strftime('${bucketFormat[req.bucket]}', ${q(groupCol.name)})` : q(groupCol.name);
      const rows = db
        .query<{ key: string | number | null; value: number | null }, (string | number | null)[]>(
          `SELECT ${key} AS key, ${expr} AS value FROM ${q(table.name)}${where.sql} GROUP BY 1 ORDER BY 1`,
        )
        .all(...where.params);
      return {
        groups: rows.map((r) => ({
          key: groupCol.type === "boolean" && r.key !== null ? r.key === 1 : r.key,
          value: r.value,
        })),
      };
    }
    const row = db
      .query<{ value: number | null }, (string | number | null)[]>(
        `SELECT ${expr} AS value FROM ${q(table.name)}${where.sql}`,
      )
      .get(...where.params);
    return { value: row?.value ?? null };
  }

  const action = req.action;
  const table = getTable(spec, action.table);

  if (action.type === "insert") {
    for (const col of table.columns) {
      const v = action.values[col.name];
      if (col.required && (v === undefined || v === null || v === "")) throw new DataError(`"${col.label ?? col.name}" is required`);
    }
    const entries = writableValues(table, action.values);
    if (!entries.length) {
      return { changes: db.query(`INSERT INTO ${q(table.name)} DEFAULT VALUES`).run().changes };
    }
    const sql = `INSERT INTO ${q(table.name)} (${entries.map(([n]) => q(n)).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`;
    return { changes: db.query(sql).run(...entries.map(([, v]) => v)).changes };
  }

  const where = whereClause(table, action.where);

  if (action.type === "update") {
    const entries = writableValues(table, action.values);
    if (!entries.length) return { changes: 0 };
    const sql = `UPDATE ${q(table.name)} SET ${entries.map(([n]) => `${q(n)} = ?`).join(", ")}${where.sql}`;
    return { changes: db.query(sql).run(...entries.map(([, v]) => v), ...where.params).changes };
  }

  return { changes: db.query(`DELETE FROM ${q(table.name)}${where.sql}`).run(...where.params).changes };
}
