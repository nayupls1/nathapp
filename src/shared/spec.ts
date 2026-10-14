// The app spec is the only thing the agent produces. It describes a generated
// app's data model (tables) and its UI as a tree of catalog components. gApp
// validates it, migrates the app's database, and renders it.
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "must be snake_case: lowercase letters, digits, underscores")
  .refine((s) => !s.startsWith("sqlite_"), "must not start with sqlite_")
  .refine((s) => s !== "id" && s !== "created_at", "id and created_at are reserved");

export const ColumnType = z.enum(["text", "number", "boolean", "date"]);
export type ColumnType = z.infer<typeof ColumnType>;

export const Column = z.object({
  name: identifier,
  label: z.string().optional(),
  type: ColumnType,
  required: z.boolean().optional(),
  /** Restricts a text column to these values (rendered as a select). */
  options: z.array(z.string()).optional(),
});
export type Column = z.infer<typeof Column>;

export const Table = z.object({
  name: identifier,
  label: z.string().optional(),
  columns: z.array(Column).min(1),
});
export type Table = z.infer<typeof Table>;

export const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Value = z.infer<typeof Value>;

/** Equality filter: every listed column must equal the given value. */
export const Where = z.record(z.string(), Value);
export type Where = z.infer<typeof Where>;

export const Sort = z.object({ column: z.string(), dir: z.enum(["asc", "desc"]).default("asc") });
export type Sort = z.infer<typeof Sort>;

export const Aggregate = z.enum(["count", "sum", "avg", "min", "max"]);
export type Aggregate = z.infer<typeof Aggregate>;

/** Groups date values by period instead of by exact value. */
export const Bucket = z.enum(["day", "week", "month", "year"]);
export type Bucket = z.infer<typeof Bucket>;

// --- Backend actions -------------------------------------------------------

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("insert"), table: z.string(), values: z.record(z.string(), Value) }),
  z.object({
    type: z.literal("update"),
    table: z.string(),
    where: Where,
    values: z.record(z.string(), Value),
  }),
  z.object({ type: z.literal("delete"), table: z.string(), where: Where }),
]);
export type Action = z.infer<typeof Action>;

// --- UI components ---------------------------------------------------------

const Gap = z.enum(["sm", "md", "lg"]);

export type UINode =
  | { type: "stack"; direction?: "row" | "column"; gap?: "sm" | "md" | "lg"; children: UINode[] }
  | { type: "card"; title?: string; children: UINode[] }
  | { type: "tabs"; tabs: { label: string; children: UINode[] }[] }
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string; muted?: boolean }
  | { type: "form"; table: string; fields?: string[]; title?: string; submitLabel?: string }
  | {
      type: "table";
      table: string;
      columns?: string[];
      where?: Where;
      sort?: Sort;
      limit?: number;
      editable?: boolean;
      deletable?: boolean;
      emptyText?: string;
    }
  | {
      type: "list";
      table: string;
      primary: string;
      secondary?: string;
      checkbox?: string;
      where?: Where;
      sort?: Sort;
      limit?: number;
      deletable?: boolean;
      emptyText?: string;
    }
  | {
      type: "stat";
      label: string;
      table: string;
      aggregate: Aggregate;
      column?: string;
      where?: Where;
      format?: "number" | "currency" | "percent";
    }
  | {
      type: "chart";
      title?: string;
      table: string;
      groupBy: string;
      bucket?: Bucket;
      aggregate: Aggregate;
      column?: string;
      where?: Where;
    }
  | { type: "button"; label: string; action: Action; confirm?: string; variant?: "primary" | "danger" };

export const UINode: z.ZodType<UINode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("stack"),
      direction: z.enum(["row", "column"]).optional(),
      gap: Gap.optional(),
      children: z.array(UINode),
    }),
    z.object({ type: z.literal("card"), title: z.string().optional(), children: z.array(UINode) }),
    z.object({
      type: z.literal("tabs"),
      tabs: z.array(z.object({ label: z.string(), children: z.array(UINode) })).min(1),
    }),
    z.object({
      type: z.literal("heading"),
      text: z.string(),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }),
    z.object({ type: z.literal("text"), text: z.string(), muted: z.boolean().optional() }),
    z.object({
      type: z.literal("form"),
      table: z.string(),
      fields: z.array(z.string()).optional(),
      title: z.string().optional(),
      submitLabel: z.string().optional(),
    }),
    z.object({
      type: z.literal("table"),
      table: z.string(),
      columns: z.array(z.string()).optional(),
      where: Where.optional(),
      sort: Sort.optional(),
      limit: z.number().int().positive().optional(),
      editable: z.boolean().optional(),
      deletable: z.boolean().optional(),
      emptyText: z.string().optional(),
    }),
    z.object({
      type: z.literal("list"),
      table: z.string(),
      primary: z.string(),
      secondary: z.string().optional(),
      checkbox: z.string().optional(),
      where: Where.optional(),
      sort: Sort.optional(),
      limit: z.number().int().positive().optional(),
      deletable: z.boolean().optional(),
      emptyText: z.string().optional(),
    }),
    z.object({
      type: z.literal("stat"),
      label: z.string(),
      table: z.string(),
      aggregate: Aggregate,
      column: z.string().optional(),
      where: Where.optional(),
      format: z.enum(["number", "currency", "percent"]).optional(),
    }),
    z.object({
      type: z.literal("chart"),
      title: z.string().optional(),
      table: z.string(),
      groupBy: z.string(),
      bucket: Bucket.optional(),
      aggregate: Aggregate,
      column: z.string().optional(),
      where: Where.optional(),
    }),
    z.object({
      type: z.literal("button"),
      label: z.string(),
      action: Action,
      confirm: z.string().optional(),
      variant: z.enum(["primary", "danger"]).optional(),
    }),
  ]),
) as z.ZodType<UINode>;

// --- App -------------------------------------------------------------------

export const AppSpec = z.object({
  name: z.string().min(1).max(60),
  icon: z.string().max(8).optional(),
  description: z.string().optional(),
  tables: z.array(Table),
  ui: UINode,
});
export type AppSpec = z.infer<typeof AppSpec>;

/**
 * Validates a spec beyond its shape: every table/column a component or action
 * references must exist. Returns human-readable problems (empty = valid).
 */
export function checkReferences(spec: AppSpec): string[] {
  const problems: string[] = [];
  const tables = new Map(spec.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
  const columnType = (table: string, column: string) =>
    column === "created_at" ? "date" : spec.tables.find((t) => t.name === table)?.columns.find((c) => c.name === column)?.type;

  const seen = new Set<string>();
  for (const t of spec.tables) {
    if (seen.has(t.name)) problems.push(`duplicate table "${t.name}"`);
    seen.add(t.name);
  }

  const checkColumns = (where: string, table: string, columns: (string | undefined)[]) => {
    const cols = tables.get(table);
    if (!cols) return problems.push(`${where}: unknown table "${table}"`);
    for (const c of columns) {
      if (c && !cols.has(c) && c !== "id" && c !== "created_at") {
        problems.push(`${where}: table "${table}" has no column "${c}"`);
      }
    }
  };

  const walk = (node: UINode, path: string) => {
    const at = `${path}(${node.type})`;
    switch (node.type) {
      case "stack":
      case "card":
        node.children.forEach((c, i) => walk(c, `${at}.children[${i}]`));
        break;
      case "tabs":
        node.tabs.forEach((t, i) => t.children.forEach((c, j) => walk(c, `${at}.tabs[${i}][${j}]`)));
        break;
      case "form":
        checkColumns(at, node.table, node.fields ?? []);
        break;
      case "table":
        checkColumns(at, node.table, [...(node.columns ?? []), ...Object.keys(node.where ?? {}), node.sort?.column]);
        break;
      case "list":
        checkColumns(at, node.table, [
          node.primary,
          node.secondary,
          node.checkbox,
          ...Object.keys(node.where ?? {}),
          node.sort?.column,
        ]);
        break;
      case "stat":
      case "chart":
        checkColumns(at, node.table, [
          node.column,
          node.type === "chart" ? node.groupBy : undefined,
          ...Object.keys(node.where ?? {}),
        ]);
        if (node.aggregate !== "count" && !node.column) problems.push(`${at}: aggregate "${node.aggregate}" needs a column`);
        if (node.type === "chart" && node.bucket && columnType(node.table, node.groupBy) !== "date") {
          problems.push(`${at}: "bucket" needs groupBy to be a date column or created_at`);
        }
        break;
      case "button": {
        const a = node.action;
        checkColumns(at, a.table, [
          ...("values" in a ? Object.keys(a.values) : []),
          ...("where" in a ? Object.keys(a.where) : []),
        ]);
        break;
      }
    }
  };
  walk(spec.ui, "ui");
  return problems;
}
