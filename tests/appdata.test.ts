import "./setup";
import { describe, expect, test } from "bun:test";
import { DataError, migrate, resetAppData, runData } from "../src/server/appdata";
import type { AppSpec } from "../src/shared/spec";

const spec: AppSpec = {
  name: "Expenses",
  tables: [
    {
      name: "expenses",
      columns: [
        { name: "title", type: "text", required: true },
        { name: "amount", type: "number" },
        { name: "category", type: "text", options: ["Food", "Fun"] },
        { name: "paid", type: "boolean" },
        { name: "date", type: "date" },
      ],
    },
  ],
  ui: { type: "text", text: "" },
};

const seed = {
  expenses: [
    { title: "Lunch", amount: 12, category: "Food", paid: true, date: "2026-09-03" },
    { title: "Cinema", amount: 20, category: "Fun", paid: false, date: "2026-09-20" },
    { title: "Dinner", amount: 30, category: "Food", paid: true, date: "2026-10-02" },
  ],
};

let n = 0;
const fresh = () => {
  const id = `test-${++n}`;
  resetAppData(id, spec, seed);
  return id;
};

describe("app data", () => {
  test("query filters, sorts and decodes booleans", () => {
    const id = fresh();
    const res = runData(id, spec, { op: "query", table: "expenses", where: { paid: true }, sort: { column: "amount", dir: "desc" } });
    expect("rows" in res && res.rows.map((r) => [r.title, r.paid])).toEqual([
      ["Dinner", true],
      ["Lunch", true],
    ]);
  });

  test("aggregates with month buckets and series", () => {
    const id = fresh();
    expect(runData(id, spec, { op: "aggregate", table: "expenses", aggregate: "sum", column: "amount" })).toEqual({ value: 62 });
    expect(
      runData(id, spec, { op: "aggregate", table: "expenses", aggregate: "sum", column: "amount", groupBy: "date", bucket: "month" }),
    ).toEqual({ groups: [{ key: "2026-09", value: 32 }, { key: "2026-10", value: 30 }] });
    expect(
      runData(id, spec, {
        op: "aggregate",
        table: "expenses",
        aggregate: "count",
        groupBy: "date",
        bucket: "month",
        seriesBy: "paid",
      }),
    ).toEqual({
      groups: [
        { key: "2026-09", series: false, value: 1 },
        { key: "2026-09", series: true, value: 1 },
        { key: "2026-10", series: true, value: 1 },
      ],
    });
  });

  test("validates writes", () => {
    const id = fresh();
    const insert = (values: Record<string, string | number | boolean | null>) =>
      runData(id, spec, { op: "action", action: { type: "insert", table: "expenses", values } });
    expect(() => insert({ amount: 1 })).toThrow(DataError);
    expect(() => insert({ title: "x", category: "Rent" })).toThrow("must be one of");
    expect(() => insert({ title: "x", nope: 1 })).toThrow("no writable column");
    expect(() => insert({ title: "x", amount: "abc" })).toThrow("must be a number");
    expect(insert({ title: "Snack", amount: "4.5" })).toEqual({ changes: 1 });
  });

  test("false matches unset booleans", () => {
    const id = fresh();
    runData(id, spec, { op: "action", action: { type: "insert", table: "expenses", values: { title: "No flag" } } });
    const res = runData(id, spec, { op: "aggregate", table: "expenses", aggregate: "count", where: { paid: false } });
    expect(res).toEqual({ value: 2 });
  });

  test("rejects unknown tables and columns in reads", () => {
    const id = fresh();
    expect(() => runData(id, spec, { op: "query", table: "nope" })).toThrow('Unknown table "nope"');
    expect(() => runData(id, spec, { op: "query", table: "expenses", sort: { column: "x; DROP TABLE", dir: "asc" } })).toThrow(
      DataError,
    );
  });

  test("update and delete by where", () => {
    const id = fresh();
    const act = (action: Parameters<typeof runData>[2]) => runData(id, spec, action);
    expect(act({ op: "action", action: { type: "update", table: "expenses", where: { category: "Food" }, values: { paid: false } } })).toEqual({ changes: 2 });
    expect(act({ op: "action", action: { type: "delete", table: "expenses", where: { paid: false } } })).toEqual({ changes: 3 });
  });

  test("migrations are additive and keep data", () => {
    const id = fresh();
    const next: AppSpec = {
      ...spec,
      tables: [{ name: "expenses", columns: [spec.tables[0]!.columns[0]!, { name: "note", type: "text" }] }],
    };
    migrate(id, next);
    const res = runData(id, next, { op: "query", table: "expenses" });
    expect("rows" in res && res.rows.map((r) => [r.title, r.note])).toEqual([
      ["Lunch", null],
      ["Cinema", null],
      ["Dinner", null],
    ]);
  });
});
