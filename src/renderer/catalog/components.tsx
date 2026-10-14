// The UI catalog: one Solid component per `UINode` type in src/shared/spec.ts.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Index, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Row } from "../../shared/api";
import type { Column, Tone, UINode, Value } from "../../shared/spec";
import { Icon } from "../components/Icon";
import { Button, Checkbox, Input, Select } from "../components/ui";
import { colors, font, radius, space } from "../theme.stylex";
import { Chart } from "./Chart";
import {
  columnLabel,
  findColumn,
  formatStat,
  formatValue,
  framed,
  InCard,
  useData,
  useMutate,
  useTable,
} from "./context";

type NodeOf<T extends UINode["type"]> = Extract<UINode, { type: T }>;
type Props<T extends UINode["type"]> = { node: NodeOf<T> };

export function Render(props: { node: UINode }) {
  const component = () => catalog[props.node.type] as Component<{ node: UINode }>;
  return <Dynamic component={component()} node={props.node} />;
}

const RenderChildren = (props: { nodes: UINode[] }) => <Index each={props.nodes}>{(n) => <Render node={n()} />}</Index>;

// --- Layout --------------------------------------------------------------------

const gaps = { sm: space.sm, md: space.lg, lg: space.xl } as const;

function Stack(props: Props<"stack">) {
  const row = () => props.node.direction === "row";
  return (
    <div {...stylex.attrs(s.stack, row() && s.row, s.gap(gaps[props.node.gap ?? "md"]))}>
      <Index each={props.node.children}>
        {(child) => (
          <Show when={row()} fallback={<Render node={child()} />}>
            <div {...stylex.attrs(s.rowItem)}>
              <Render node={child()} />
            </div>
          </Show>
        )}
      </Index>
    </div>
  );
}

function Card(props: Props<"card">) {
  return (
    <section {...stylex.attrs(s.card)}>
      <Show when={props.node.title}>
        <h3 {...stylex.attrs(s.cardTitle)}>
          <Icon name={props.node.icon} size={16} {...stylex.attrs(s.titleIcon)} />
          {props.node.title}
        </h3>
      </Show>
      <div {...stylex.attrs(s.stack, s.gap(space.md))}>
        <InCard.Provider value={true}>
          <RenderChildren nodes={props.node.children} />
        </InCard.Provider>
      </div>
    </section>
  );
}

function Tabs(props: Props<"tabs">) {
  const [active, setActive] = createSignal(0);
  const current = () => props.node.tabs[Math.min(active(), props.node.tabs.length - 1)];
  return (
    <div {...stylex.attrs(s.stack, s.gap(space.lg))}>
      <div {...stylex.attrs(s.tabBar)}>
        <For each={props.node.tabs}>
          {(tab, i) => (
            <button type="button" onClick={() => setActive(i())} {...stylex.attrs(s.tab, active() === i() && s.tabActive)}>
              <Icon name={tab.icon} size={15} />
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div {...stylex.attrs(s.stack, s.gap(space.lg))}>
        <Show when={current()}>{(tab) => <RenderChildren nodes={tab().children} />}</Show>
      </div>
    </div>
  );
}

// --- Content -------------------------------------------------------------------

function Heading(props: Props<"heading">) {
  const level = () => props.node.level ?? 2;
  const size = { 1: s.h1, 2: s.h2, 3: s.h3 };
  const iconSize = { 1: 26, 2: 20, 3: 17 };
  return (
    <Dynamic component={`h${level()}`} {...stylex.attrs(s.heading, size[level()])}>
      <Icon name={props.node.icon} size={iconSize[level()]} {...stylex.attrs(s.titleIcon)} />
      {props.node.text}
    </Dynamic>
  );
}

const toneColor: Record<Tone, string> = {
  default: colors.text,
  muted: colors.muted,
  accent: colors.accent,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
};
const iconSizes = { sm: 16, md: 20, lg: 28 } as const;

function IconNode(props: Props<"icon">) {
  return (
    <Icon
      name={props.node.name}
      size={iconSizes[props.node.size ?? "md"]}
      {...stylex.attrs(s.icon, s.tone(toneColor[props.node.tone ?? "default"]))}
      fallback={<span {...stylex.attrs(s.muted)}>?</span>}
    />
  );
}

function Text(props: Props<"text">) {
  return <p {...stylex.attrs(s.text, props.node.muted && s.muted)}>{props.node.text}</p>;
}

// --- Data ----------------------------------------------------------------------

function FieldInput(props: { col: Column; name?: string; value?: Value; onChange?: (v: Value) => void; compact?: boolean }) {
  const common = () => ({
    name: props.name,
    required: props.col.required,
    xstyle: props.compact ? s.compactField : undefined,
  });
  const emit = (v: Value) => props.onChange?.(v);

  if (props.col.options) {
    return (
      <Select {...common()} value={String(props.value ?? "")} onChange={(e) => emit(e.currentTarget.value || null)}>
        <option value="">{props.compact ? "—" : "Select…"}</option>
        <For each={props.col.options}>{(o) => <option value={o}>{o}</option>}</For>
      </Select>
    );
  }
  switch (props.col.type) {
    case "boolean":
      return <Checkbox name={props.name} checked={props.value === true} onChange={(e) => emit(e.currentTarget.checked)} />;
    case "number":
      return (
        <Input
          {...common()}
          type="number"
          step="any"
          value={props.value == null ? "" : String(props.value)}
          onChange={(e) => emit(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
        />
      );
    case "date":
      return <Input {...common()} type="date" value={String(props.value ?? "")} onChange={(e) => emit(e.currentTarget.value || null)} />;
    default:
      return <Input {...common()} type="text" value={String(props.value ?? "")} onChange={(e) => emit(e.currentTarget.value || null)} />;
  }
}

function Form(props: Props<"form">) {
  const table = useTable(() => props.node.table);
  const mutate = useMutate();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  const columns = createMemo(() => {
    const t = table();
    if (!t) return [];
    const names = props.node.fields ?? t.columns.map((c) => c.name);
    return names.map((n) => t.columns.find((c) => c.name === n)).filter((c): c is Column => !!c);
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const values: Record<string, Value> = {};
    for (const col of columns()) {
      const raw = data.get(col.name);
      if (col.type === "boolean") values[col.name] = raw === "on";
      else if (raw === null || raw === "") values[col.name] = null;
      else values[col.name] = col.type === "number" ? Number(raw) : String(raw);
    }
    setBusy(true);
    setError();
    try {
      await mutate({ op: "action", action: { type: "insert", table: props.node.table, values } });
      form.reset();
      (form.querySelector("input, select") as HTMLElement | null)?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} {...stylex.attrs(s.form, framed() && s.frame)}>
      <Show when={props.node.title}>
        <h3 {...stylex.attrs(s.cardTitle)}>{props.node.title}</h3>
      </Show>
      <div {...stylex.attrs(s.formFields)}>
        <For each={columns()}>
          {(col) => (
            <label {...stylex.attrs(s.label, col.type === "boolean" && s.labelInline)}>
              <span {...stylex.attrs(s.labelText)}>
                {columnLabel(col)}
                {col.required ? " *" : ""}
              </span>
              <FieldInput col={col} name={col.name} />
            </label>
          )}
        </For>
      </div>
      <div {...stylex.attrs(s.formFooter)}>
        <Show when={error()}>
          <span {...stylex.attrs(s.error)}>{error()}</span>
        </Show>
        <Button type="submit" variant="primary" disabled={busy()}>
          {props.node.submitLabel ?? "Add"}
        </Button>
      </div>
    </form>
  );
}

function useRows(node: () => NodeOf<"table"> | NodeOf<"list">) {
  const data = useData<{ rows: Row[] }>(() => ({
    op: "query",
    table: node().table,
    where: node().where,
    sort: node().sort ?? { column: "created_at", dir: "desc" },
    limit: node().limit,
  }));
  return () => data.latest?.rows;
}

function DataTable(props: Props<"table">) {
  const table = useTable(() => props.node.table);
  const rows = useRows(() => props.node);
  const mutate = useMutate();

  const columns = createMemo(() => {
    const t = table();
    const names = props.node.columns ?? t?.columns.map((c) => c.name) ?? [];
    return names.map((n) => findColumn(t, n)).filter((c): c is Column => !!c);
  });

  const update = (row: Row, col: Column, value: Value) =>
    mutate({ op: "action", action: { type: "update", table: props.node.table, where: { id: row.id }, values: { [col.name]: value } } });
  const remove = (row: Row) => mutate({ op: "action", action: { type: "delete", table: props.node.table, where: { id: row.id } } });

  return (
    <div {...stylex.attrs(s.tableWrap)}>
      <table {...stylex.attrs(s.table)}>
        <thead>
          <tr>
            <For each={columns()}>{(col) => <th {...stylex.attrs(s.th)}>{columnLabel(col)}</th>}</For>
            <Show when={props.node.deletable}>
              <th {...stylex.attrs(s.th, s.actionCell)} />
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr {...stylex.attrs(s.tr)}>
                <For each={columns()}>
                  {(col) => {
                    const writable = () => props.node.editable && col.name !== "id" && col.name !== "created_at";
                    return (
                      <td {...stylex.attrs(s.td)}>
                        <Show
                          when={writable()}
                          fallback={
                            <Show when={col.type === "boolean"} fallback={formatValue(col, row[col.name] ?? null)}>
                              <Checkbox checked={row[col.name] === true} disabled />
                            </Show>
                          }
                        >
                          <FieldInput col={col} value={row[col.name]} compact onChange={(v) => update(row, col, v)} />
                        </Show>
                      </td>
                    );
                  }}
                </For>
                <Show when={props.node.deletable}>
                  <td {...stylex.attrs(s.td, s.actionCell)}>
                    <Button variant="ghost" title="Delete" onClick={() => remove(row)} xstyle={s.iconButton}>
                      ✕
                    </Button>
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={rows()?.length === 0}>
        <p {...stylex.attrs(s.empty)}>{props.node.emptyText ?? "Nothing here yet."}</p>
      </Show>
    </div>
  );
}

function List(props: Props<"list">) {
  const table = useTable(() => props.node.table);
  const rows = useRows(() => props.node);
  const mutate = useMutate();

  const toggle = (row: Row, checked: boolean) =>
    mutate({
      op: "action",
      action: { type: "update", table: props.node.table, where: { id: row.id }, values: { [props.node.checkbox!]: checked } },
    });
  const remove = (row: Row) => mutate({ op: "action", action: { type: "delete", table: props.node.table, where: { id: row.id } } });

  return (
    <div>
      <ul {...stylex.attrs(s.list)}>
        <For each={rows()}>
          {(row) => {
            const checked = () => !!props.node.checkbox && row[props.node.checkbox] === true;
            return (
              <li {...stylex.attrs(s.listItem)}>
                <Show when={props.node.checkbox}>
                  <Checkbox checked={checked()} onChange={(e) => toggle(row, e.currentTarget.checked)} />
                </Show>
                <Icon name={props.node.icon} size={16} {...stylex.attrs(s.listIcon)} />
                <div {...stylex.attrs(s.listText)}>
                  <span {...stylex.attrs(s.listPrimary, checked() && s.done)}>
                    {formatValue(findColumn(table(), props.node.primary), row[props.node.primary] ?? null)}
                  </span>
                  <Show when={props.node.secondary}>
                    {(sec) => (
                      <span {...stylex.attrs(s.listSecondary)}>{formatValue(findColumn(table(), sec()), row[sec()] ?? null)}</span>
                    )}
                  </Show>
                </div>
                <Show when={props.node.deletable}>
                  <Button variant="ghost" title="Delete" onClick={() => remove(row)} xstyle={s.iconButton}>
                    ✕
                  </Button>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={rows()?.length === 0}>
        <p {...stylex.attrs(s.empty)}>{props.node.emptyText ?? "Nothing here yet."}</p>
      </Show>
    </div>
  );
}

function Stat(props: Props<"stat">) {
  const data = useData<{ value: number | null }>(() => ({
    op: "aggregate",
    table: props.node.table,
    aggregate: props.node.aggregate,
    column: props.node.column,
    where: props.node.where,
  }));
  return (
    <div {...stylex.attrs(s.stat, framed() && s.frame)}>
      <span {...stylex.attrs(s.statLabel)}>
        <Icon name={props.node.icon} size={14} />
        {props.node.label}
      </span>
      <span {...stylex.attrs(s.statValue)}>{data.latest ? formatStat(data.latest.value, props.node.format) : "…"}</span>
    </div>
  );
}

function ActionButton(props: Props<"button">) {
  const mutate = useMutate();
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    if (props.node.confirm && !window.confirm(props.node.confirm)) return;
    setBusy(true);
    try {
      await mutate({ op: "action", action: props.node.action });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button variant={props.node.variant ?? "default"} disabled={busy()} onClick={run}>
        <Icon name={props.node.icon} size={15} />
        {props.node.label}
      </Button>
    </div>
  );
}

const catalog: { [K in UINode["type"]]: Component<Props<K>> } = {
  stack: Stack,
  card: Card,
  tabs: Tabs,
  heading: Heading,
  text: Text,
  icon: IconNode,
  form: Form,
  table: DataTable,
  list: List,
  stat: Stat,
  chart: Chart,
  button: ActionButton,
};

// --- Styles --------------------------------------------------------------------

const s = stylex.create({
  stack: { display: "flex", flexDirection: "column", minWidth: 0 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" },
  rowItem: { flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column" },
  gap: (gap: string) => ({ gap }),

  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    minWidth: 0,
  },
  cardTitle: { margin: 0, fontSize: font.md, fontWeight: 600, display: "flex", alignItems: "center", gap: space.sm },
  titleIcon: { flexShrink: 0, color: colors.accent },
  icon: { display: "block", flexShrink: 0 },
  tone: (color: string) => ({ color }),
  listIcon: { flexShrink: 0, color: colors.muted },
  frame: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },

  tabBar: {
    display: "flex",
    gap: space.xs,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderStyle: "none",
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    marginBottom: -1,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  tabActive: { color: colors.text, borderBottomColor: colors.accent },

  heading: { margin: 0, fontWeight: 650, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: space.sm },
  h1: { fontSize: font.xxl },
  h2: { fontSize: font.xl },
  h3: { fontSize: font.lg },
  text: { margin: 0, fontSize: font.md, lineHeight: 1.55, whiteSpace: "pre-wrap" },
  muted: { color: colors.muted },

  form: { display: "flex", flexDirection: "column", gap: space.md },
  formFields: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: space.md,
    alignItems: "end",
  },
  formFooter: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: space.md },
  label: { display: "flex", flexDirection: "column", gap: space.xs },
  labelInline: { flexDirection: "row-reverse", justifyContent: "flex-end", alignItems: "center", gap: space.sm, height: 34 },
  labelText: { fontSize: font.xs, fontWeight: 500, color: colors.muted },
  error: { color: colors.danger, fontSize: font.sm, marginRight: "auto" },
  compactField: { height: 28, fontSize: font.sm, paddingInline: space.sm, minWidth: 80 },

  tableWrap: {
    overflowX: "auto",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: font.sm },
  th: {
    textAlign: "left",
    fontWeight: 500,
    color: colors.muted,
    fontSize: font.xs,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    whiteSpace: "nowrap",
  },
  tr: { backgroundColor: { default: "transparent", ":hover": colors.surfaceHover } },
  td: {
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    verticalAlign: "middle",
  },
  actionCell: { width: 1, textAlign: "right" },
  iconButton: { height: 26, width: 26, paddingInline: 0, color: colors.muted, fontSize: font.xs },
  empty: { margin: 0, padding: space.lg, textAlign: "center", color: colors.muted, fontSize: font.sm },

  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  listItem: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.md,
    minHeight: 44,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  listText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  listPrimary: { fontSize: font.md, overflow: "hidden", textOverflow: "ellipsis" },
  listSecondary: { fontSize: font.xs, color: colors.muted },
  done: { textDecoration: "line-through", color: colors.muted },

  stat: { display: "flex", flexDirection: "column", gap: space.xs },
  statLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: font.xs,
    fontWeight: 500,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  statValue: { fontSize: font.xxl, fontWeight: 650, fontVariantNumeric: "tabular-nums" },

});
