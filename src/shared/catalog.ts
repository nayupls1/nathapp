// Documentation for every UI component in the catalog, with a live example
// each. This is the single source for:
//   - the component reference in the agent's system prompt (server/prompt.ts)
//   - the Catalog page in the app (renderer/components/CatalogPage.tsx)
//   - tests that check every example validates and renders
// Examples run against a demo app (tables + seed rows below).
import type { AppSpec, Table, UINode, Value } from "./spec";

export type ComponentType = UINode["type"];

export interface PropDoc {
  name: string;
  /** TypeScript-ish type, as shown to the agent. */
  type: string;
  required?: boolean;
  description?: string;
}

export interface ComponentDoc {
  type: ComponentType;
  category: "Layout" | "Content" | "Data" | "Charts" | "Actions";
  summary: string;
  props: PropDoc[];
  example: UINode;
}

/** App id the server uses for the catalog's demo data. */
export const CATALOG_APP_ID = "catalog";

const icon: PropDoc = { name: "icon", type: "IconName", description: "Lucide icon shown before the text" };
const where: PropDoc = { name: "where", type: "Where", description: "only rows matching all column values" };
const sort: PropDoc = { name: "sort", type: "Sort", description: "default: newest first" };
const limit: PropDoc = { name: "limit", type: "number" };
const table: PropDoc = { name: "table", type: "table name", required: true };
const aggregate: PropDoc = { name: "aggregate", type: "Aggregate", required: true };
const aggColumn: PropDoc = { name: "column", type: "column", description: "required unless aggregate is count" };

export const componentDocs: ComponentDoc[] = [
  // --- Layout
  {
    type: "stack",
    category: "Layout",
    summary: "Arranges children vertically, or horizontally with wrapping on narrow screens.",
    props: [
      { name: "direction", type: '"column" | "row"', description: 'default "column"' },
      { name: "gap", type: '"sm" | "md" | "lg"', description: 'default "md"' },
      { name: "children", type: "UINode[]", required: true },
    ],
    example: {
      type: "stack",
      direction: "row",
      children: [
        { type: "stat", label: "Open tasks", table: "tasks", aggregate: "count", where: { done: false }, icon: "list-todo" },
        { type: "stat", label: "Done", table: "tasks", aggregate: "count", where: { done: true }, icon: "circle-check" },
      ],
    },
  },
  {
    type: "card",
    category: "Layout",
    summary: "A framed section with an optional title. Forms, stats and charts inside drop their own frame.",
    props: [{ name: "title", type: "string" }, icon, { name: "children", type: "UINode[]", required: true }],
    example: {
      type: "card",
      title: "Getting started",
      icon: "rocket",
      children: [{ type: "text", text: "Cards group related content.", muted: true }],
    },
  },
  {
    type: "tabs",
    category: "Layout",
    summary: "Switches between sections. Good for separating input, overview and history.",
    props: [{ name: "tabs", type: "{ label: string, icon?: IconName, children: UINode[] }[]", required: true }],
    example: {
      type: "tabs",
      tabs: [
        { label: "Overview", icon: "layout-dashboard", children: [{ type: "text", text: "First tab content." }] },
        { label: "Details", icon: "list", children: [{ type: "text", text: "Second tab content." }] },
      ],
    },
  },

  // --- Content
  {
    type: "heading",
    category: "Content",
    summary: "A title.",
    props: [
      { name: "text", type: "string", required: true },
      { name: "level", type: "1 | 2 | 3", description: "default 2" },
      icon,
    ],
    example: { type: "heading", text: "Weekly review", level: 2, icon: "calendar-check" },
  },
  {
    type: "text",
    category: "Content",
    summary: "A paragraph of plain text. Line breaks are kept.",
    props: [
      { name: "text", type: "string", required: true },
      { name: "muted", type: "boolean", description: "secondary, greyed-out text" },
    ],
    example: { type: "text", text: "Plain text, for explanations and hints.", muted: true },
  },
  {
    type: "icon",
    category: "Content",
    summary: "A standalone Lucide icon.",
    props: [
      { name: "name", type: "IconName", required: true },
      { name: "size", type: '"sm" | "md" | "lg"', description: 'default "md"' },
      { name: "tone", type: '"default" | "muted" | "accent" | "success" | "warning" | "danger"' },
    ],
    example: {
      type: "stack",
      direction: "row",
      gap: "sm",
      children: [
        { type: "icon", name: "heart", tone: "danger", size: "lg" },
        { type: "icon", name: "star", tone: "warning", size: "lg" },
        { type: "icon", name: "leaf", tone: "success", size: "lg" },
        { type: "icon", name: "zap", tone: "accent", size: "lg" },
      ],
    },
  },

  // --- Data
  {
    type: "form",
    category: "Data",
    summary: "Inserts a row into a table. Inputs match column types (text, number, checkbox, date, select for options).",
    props: [
      table,
      { name: "fields", type: "column[]", description: "default: all columns" },
      { name: "title", type: "string" },
      { name: "submitLabel", type: "string", description: 'default "Add"' },
    ],
    example: { type: "form", table: "tasks", fields: ["title", "priority", "due"], submitLabel: "Add task" },
  },
  {
    type: "table",
    category: "Data",
    summary: "Rows in a table. Optionally editable inline and deletable.",
    props: [
      table,
      { name: "columns", type: "column[]", description: "default: all columns; id and created_at are allowed" },
      where,
      sort,
      limit,
      { name: "editable", type: "boolean", description: "edit cells inline" },
      { name: "deletable", type: "boolean" },
      { name: "emptyText", type: "string" },
    ],
    example: {
      type: "table",
      table: "expenses",
      columns: ["description", "category", "amount", "date"],
      sort: { column: "date", dir: "desc" },
      limit: 5,
      editable: true,
      deletable: true,
    },
  },
  {
    type: "list",
    category: "Data",
    summary: "A compact list of rows. A checkbox column makes it a checklist.",
    props: [
      table,
      { name: "primary", type: "column", required: true },
      { name: "secondary", type: "column", description: "smaller line below" },
      { name: "checkbox", type: "boolean column", description: "toggled by a checkbox" },
      { ...icon, description: "Lucide icon shown on every item" },
      where,
      sort,
      limit,
      { name: "deletable", type: "boolean" },
      { name: "emptyText", type: "string" },
    ],
    example: { type: "list", table: "tasks", primary: "title", secondary: "priority", checkbox: "done", deletable: true },
  },
  {
    type: "stat",
    category: "Data",
    summary: "A single aggregated number.",
    props: [
      { name: "label", type: "string", required: true },
      table,
      aggregate,
      aggColumn,
      where,
      { name: "format", type: '"number" | "currency" | "percent"' },
      icon,
    ],
    example: {
      type: "stat",
      label: "Total spent",
      table: "expenses",
      aggregate: "sum",
      column: "amount",
      format: "currency",
      icon: "wallet",
    },
  },

  // --- Charts
  {
    type: "chart",
    category: "Charts",
    summary:
      "A chart of an aggregate per group. Use bucket to group dates by period and seriesBy to split into stacked bars or multiple lines.",
    props: [
      { name: "kind", type: '"bar" | "bar-horizontal" | "line" | "area" | "pie" | "donut"', description: 'default "bar"' },
      { name: "title", type: "string" },
      table,
      { name: "groupBy", type: "column", required: true, description: "x axis / slices" },
      { name: "bucket", type: '"day" | "week" | "month" | "year"', description: "groups a date column (or created_at) by period" },
      { name: "seriesBy", type: "column", description: "second grouping: stacked bars / one line per value; not for pie/donut" },
      aggregate,
      aggColumn,
      where,
      { name: "height", type: "number", description: "pixels, 120–800, default 260" },
    ],
    example: {
      type: "chart",
      kind: "bar",
      title: "Spending per month by category",
      table: "expenses",
      groupBy: "date",
      bucket: "month",
      seriesBy: "category",
      aggregate: "sum",
      column: "amount",
    },
  },

  // --- Actions
  {
    type: "button",
    category: "Actions",
    summary: "Runs a backend action (insert / update / delete), optionally after confirmation.",
    props: [
      { name: "label", type: "string", required: true },
      { name: "action", type: "Action", required: true },
      { name: "confirm", type: "string", description: "question to confirm first" },
      { name: "variant", type: '"primary" | "danger"' },
      icon,
    ],
    example: {
      type: "button",
      label: "Mark all done",
      icon: "check-check",
      variant: "primary",
      action: { type: "update", table: "tasks", where: { done: false }, values: { done: true } },
      confirm: "Mark every open task as done?",
    },
  },
];

/** More chart variants shown on the Catalog page. */
export const chartExamples: UINode[] = [
  { type: "chart", kind: "bar-horizontal", title: "Total by category", table: "expenses", groupBy: "category", aggregate: "sum", column: "amount" },
  { type: "chart", kind: "line", title: "Spending per month", table: "expenses", groupBy: "date", bucket: "month", aggregate: "sum", column: "amount" },
  { type: "chart", kind: "area", title: "Per month by category", table: "expenses", groupBy: "date", bucket: "month", seriesBy: "category", aggregate: "sum", column: "amount" },
  { type: "chart", kind: "donut", title: "Share by category", table: "expenses", groupBy: "category", aggregate: "sum", column: "amount" },
  { type: "chart", kind: "pie", title: "Tasks by priority", table: "tasks", groupBy: "priority", aggregate: "count" },
];

// --- Demo app ----------------------------------------------------------------

const demoTables: Table[] = [
  {
    name: "tasks",
    columns: [
      { name: "title", type: "text", required: true },
      { name: "priority", type: "text", options: ["Low", "Medium", "High"] },
      { name: "due", type: "date" },
      { name: "done", type: "boolean" },
    ],
  },
  {
    name: "expenses",
    columns: [
      { name: "description", type: "text", required: true },
      { name: "amount", type: "number", required: true },
      { name: "category", type: "text", options: ["Food", "Housing", "Transport", "Fun"] },
      { name: "date", type: "date" },
    ],
  },
];

export const catalogSpec: AppSpec = {
  name: "Catalog",
  icon: "book-open",
  tables: demoTables,
  ui: { type: "stack", children: [...componentDocs.map((d) => d.example), ...chartExamples] },
};

export const catalogSeed: Record<string, Record<string, Value>[]> = {
  tasks: [
    { title: "Plan the week", priority: "High", due: "2026-10-12", done: true },
    { title: "Renew passport", priority: "High", due: "2026-10-20", done: false },
    { title: "Call the plumber", priority: "Medium", due: "2026-10-16", done: false },
    { title: "Sort photos", priority: "Low", due: null, done: false },
    { title: "Book dentist", priority: "Medium", due: "2026-10-09", done: true },
  ],
  expenses: [
    { description: "Groceries", amount: 64.3, category: "Food", date: "2026-08-03" },
    { description: "Rent", amount: 950, category: "Housing", date: "2026-08-01" },
    { description: "Train pass", amount: 49, category: "Transport", date: "2026-08-02" },
    { description: "Concert", amount: 45, category: "Fun", date: "2026-08-19" },
    { description: "Groceries", amount: 81.9, category: "Food", date: "2026-09-06" },
    { description: "Rent", amount: 950, category: "Housing", date: "2026-09-01" },
    { description: "Train pass", amount: 49, category: "Transport", date: "2026-09-02" },
    { description: "Dinner out", amount: 72.5, category: "Food", date: "2026-09-21" },
    { description: "Groceries", amount: 58.4, category: "Food", date: "2026-10-04" },
    { description: "Rent", amount: 950, category: "Housing", date: "2026-10-01" },
    { description: "Taxi", amount: 23, category: "Transport", date: "2026-10-08" },
    { description: "Cinema", amount: 28, category: "Fun", date: "2026-10-10" },
  ],
};
