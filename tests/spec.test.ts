import { describe, expect, test } from "bun:test";
import { isIcon, searchIcons } from "../src/server/icons";
import { buildSystemPrompt, systemPrompt } from "../src/server/prompt";
import { Settings } from "../src/shared/settings";
import { AppSpec, checkReferences, type AppSpec as AppSpecType } from "../src/shared/spec";

const base: AppSpecType = {
  name: "Todos",
  icon: "list-todo",
  tables: [
    {
      name: "todos",
      columns: [
        { name: "title", type: "text", required: true },
        { name: "done", type: "boolean" },
        { name: "due", type: "date" },
      ],
    },
  ],
  ui: { type: "list", table: "todos", primary: "title", checkbox: "done" },
};

const problems = (spec: AppSpecType) => checkReferences(spec, { isIcon });

describe("spec validation", () => {
  test("accepts a valid spec", () => {
    expect(AppSpec.safeParse(base).success).toBe(true);
    expect(problems(base)).toEqual([]);
  });

  test("rejects reserved and malformed identifiers", () => {
    const bad = { ...base, tables: [{ name: "todos", columns: [{ name: "id", type: "text" }] }] };
    expect(AppSpec.safeParse(bad).success).toBe(false);
    expect(AppSpec.safeParse({ ...base, tables: [{ name: "Todo List", columns: base.tables[0]!.columns }] }).success).toBe(false);
  });

  test("reports unknown tables and columns", () => {
    expect(problems({ ...base, ui: { type: "list", table: "nope", primary: "title" } })).toEqual([
      'ui(list): unknown table "nope"',
    ]);
    expect(problems({ ...base, ui: { type: "list", table: "todos", primary: "name" } })).toEqual([
      'ui(list): table "todos" has no column "name"',
    ]);
  });

  test("reports unknown icons anywhere in the tree", () => {
    const spec: AppSpecType = {
      ...base,
      icon: "not-an-icon",
      ui: { type: "stack", children: [{ type: "heading", text: "Hi", icon: "also-fake" }, { type: "icon", name: "heart" }] },
    };
    expect(problems(spec)).toEqual([
      'app: unknown icon "not-an-icon" (use search_icons to find valid names)',
      'ui(stack).children[0](heading): unknown icon "also-fake" (use search_icons to find valid names)',
    ]);
  });

  test("chart rules: bucket needs a date, aggregates need a column, pies have no series", () => {
    const chart = (extra: object) =>
      problems({ ...base, ui: { type: "chart", table: "todos", groupBy: "title", aggregate: "count", ...extra } });
    expect(chart({ bucket: "month" })).toEqual(['ui(chart): "bucket" needs groupBy to be a date column or created_at']);
    expect(chart({ groupBy: "due", bucket: "month" })).toEqual([]);
    expect(chart({ groupBy: "created_at", bucket: "week" })).toEqual([]);
    expect(chart({ aggregate: "sum" })).toEqual(['ui(chart): aggregate "sum" needs a column']);
    expect(chart({ kind: "pie", seriesBy: "done" })).toEqual(['ui(chart): "seriesBy" is not supported for pie charts']);
  });
});

describe("themes and settings", () => {
  test("app themes take hex colors and known options", () => {
    expect(AppSpec.safeParse({ ...base, theme: { mode: "dark", accent: "#e11d48", radius: "lg", font: "serif" } }).success).toBe(true);
    expect(AppSpec.safeParse({ ...base, theme: { accent: "red" } }).success).toBe(false);
    expect(AppSpec.safeParse({ ...base, theme: { mode: "system" } }).success).toBe(false);
  });

  test("settings fill in defaults and prompt additions reach the prompt", () => {
    const settings = Settings.parse({ agent: { instructions: "Use EUR." } });
    expect(settings.theme.mode).toBe("system");
    expect(settings.web.searchEngine).toBe("duckduckgo");
    expect(buildSystemPrompt(settings.agent.instructions)).toEndWith("Use EUR.");
    expect(buildSystemPrompt("  ")).toBe(systemPrompt);
  });
});

describe("icons", () => {
  test("knows real Lucide names", () => {
    expect(isIcon("wallet")).toBe(true);
    expect(isIcon("arrow-down-a-z")).toBe(true);
    expect(isIcon("wallet-thing")).toBe(false);
  });

  test("search ranks exact and tag matches", () => {
    expect(searchIcons("calendar")[0]).toBe("calendar");
    expect(searchIcons("money")).toContain("wallet");
    expect(searchIcons("")).toEqual([]);
  });
});
