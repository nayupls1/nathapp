// The UI catalog: one Solid component per `UINode` type in src/shared/spec.ts.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Index, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Row } from "../../shared/api";
import type { Column, Tone, UINode, Value } from "../../shared/spec";
import { confirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { Button, Checkbox, Input, Select } from "../components/ui";
import { colors, font, radius, space } from "../theme.stylex";
import { markdownToHtml } from "../../shared/markdown";
import { Chart } from "./Chart";
import { Custom } from "./Custom";
import { Kanban } from "./Kanban";
import { api } from "../lib/api";
import {
  columnLabel,
  findColumn,
  formatStat,
  formatValue,
  framed,
  InCard,
  useApp,
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

// Static gap styles: dynamic StyleX values live in the style attribute, which
// elements with inline styles (alignment, grid columns) would overwrite.
const gapStyle = (gap: "sm" | "md" | "lg" | undefined) => ({ sm: s.gapSm, md: s.gapLg, lg: s.gapXl })[gap ?? "md"];
const aligns = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
const justifies = { start: "flex-start", center: "center", end: "flex-end", between: "space-between" } as const;

function Stack(props: Props<"stack">) {
  const row = () => props.node.direction === "row";
  const align = () => aligns[props.node.align ?? "stretch"];
  const justify = () => justifies[props.node.justify ?? "start"];
  // Rows with a justify keep children at their natural size instead of filling the row.
  const natural = () => !!props.node.justify;
  return (
    <div
      {...stylex.attrs(s.stack, row() && s.row, gapStyle(props.node.gap))}
      style={{ "align-items": align(), "justify-content": justify() }}
    >
      <Index each={props.node.children}>
        {(child) => (
          <Show when={row()} fallback={<Render node={child()} />}>
            <div {...stylex.attrs(s.rowItem, natural() && s.rowItemNatural)}>
              <Render node={child()} />
            </div>
          </Show>
        )}
      </Index>
    </div>
  );
}

const gapPx = { sm: 8, md: 16, lg: 24 } as const;

function Grid(props: Props<"grid">) {
  // Columns are at least 160px wide, so wide grids wrap to fewer columns on
  // narrow screens. Sized with container units: Chromium can't resolve
  // percentages when counting auto-fill tracks.
  const template = () => {
    const n = props.node.columns ?? 2;
    const gutter = gapPx[props.node.gap ?? "md"] * (n - 1);
    return `repeat(auto-fill, minmax(max(160px, calc((100cqi - ${gutter}px) / ${n} - 0.1px)), 1fr))`;
  };
  return (
    <div {...stylex.attrs(s.gridWrap)}>
      <div {...stylex.attrs(s.grid, gapStyle(props.node.gap))} style={{ "grid-template-columns": template() }}>
        <RenderChildren nodes={props.node.children} />
      </div>
    </div>
  );
}

function Divider(props: Props<"divider">) {
  return (
    <div {...stylex.attrs(s.divider)} role="separator">
      <Show when={props.node.label}>
        <span {...stylex.attrs(s.dividerLabel)}>{props.node.label}</span>
      </Show>
    </div>
  );
}

function Card(props: Props<"card">) {
  const tone = () => props.node.tone;
  const tint = () => {
    const t = tone();
    return t && t !== "default" ? tinted(toneColor[t], 7) : undefined;
  };
  return (
    <section {...stylex.attrs(s.card)} style={tint()}>
      <Show when={props.node.title}>
        <h3 {...stylex.attrs(s.cardTitle)}>
          <Icon name={props.node.icon} size={16} {...stylex.attrs(s.titleIcon)} />
          {props.node.title}
        </h3>
      </Show>
      <div {...stylex.attrs(s.stack, s.gapMd)}>
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
    <div {...stylex.attrs(s.stack, s.gapLg)}>
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
      <div {...stylex.attrs(s.stack, s.gapLg)}>
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

/** Border + background tinted with a color (inline: see the StyleX note in CLAUDE.md). */
const tinted = (color: string, percent: number) => ({
  "border-color": color,
  "background-color": `color-mix(in oklab, ${colors.surface}, ${color} ${percent}%)`,
});

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

function Markdown(props: Props<"markdown">) {
  // markdownToHtml escapes its input; only a fixed set of tags is produced.
  return <div class="gapp-markdown" {...stylex.attrs(s.markdown)} innerHTML={markdownToHtml(props.node.text)} />;
}

function Badge(props: Props<"badge">) {
  const color = () => toneColor[props.node.tone ?? "accent"];
  return (
    <span {...stylex.attrs(s.badge)} style={{ ...tinted(color(), 14), color: color() }}>
      <Icon name={props.node.icon} size={13} />
      {props.node.text}
    </span>
  );
}

function Image(props: Props<"image">) {
  return (
    <img
      src={props.node.src}
      alt={props.node.alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
      {...stylex.attrs(s.image, props.node.rounded !== false && s.imageRounded)}
      style={{ height: props.node.height ? `${props.node.height}px` : "auto", "object-fit": props.node.fit ?? "cover" }}
    />
  );
}

function Link(props: Props<"link">) {
  return (
    <a href={props.node.href} target="_blank" rel="noreferrer" {...stylex.attrs(s.link)}>
      <Icon name={props.node.icon ?? "external-link"} size={14} />
      {props.node.text}
    </a>
  );
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

/** Client-side text filter over the shown columns of rows. */
function useSearch(rows: () => Row[] | undefined, columns: () => (Column | undefined)[]) {
  const [query, setQuery] = createSignal("");
  const filtered = () => {
    const q = query().trim().toLowerCase();
    const list = rows();
    if (!q || !list) return list;
    return list.filter((row) =>
      columns().some((col) => col && formatValue(col, row[col.name] ?? null).toLowerCase().includes(q)),
    );
  };
  return { query, setQuery, filtered };
}

function SearchBox(props: { value: string; onInput: (value: string) => void }) {
  return (
    <div {...stylex.attrs(s.search)}>
      <Icon name="search" size={15} {...stylex.attrs(s.searchIcon)} />
      <Input
        type="search"
        placeholder="Search…"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        xstyle={s.searchInput}
      />
    </div>
  );
}

function DataTable(props: Props<"table">) {
  const table = useTable(() => props.node.table);
  const allRows = useRows(() => props.node);
  const mutate = useMutate();

  const columns = createMemo(() => {
    const t = table();
    const names = props.node.columns ?? t?.columns.map((c) => c.name) ?? [];
    return names.map((n) => findColumn(t, n)).filter((c): c is Column => !!c);
  });
  const search = useSearch(allRows, columns);
  const rows = search.filtered;

  const update = (row: Row, col: Column, value: Value) =>
    mutate({ op: "action", action: { type: "update", table: props.node.table, where: { id: row.id }, values: { [col.name]: value } } });
  const remove = (row: Row) => mutate({ op: "action", action: { type: "delete", table: props.node.table, where: { id: row.id } } });

  return (
    <div {...stylex.attrs(s.stack, s.gapSm)}>
      <Show when={props.node.searchable}>
        <SearchBox value={search.query()} onInput={search.setQuery} />
      </Show>
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
          <p {...stylex.attrs(s.empty)}>{search.query() ? "No matches." : (props.node.emptyText ?? "Nothing here yet.")}</p>
        </Show>
      </div>
    </div>
  );
}

function List(props: Props<"list">) {
  const table = useTable(() => props.node.table);
  const allRows = useRows(() => props.node);
  const mutate = useMutate();
  const search = useSearch(allRows, () => [
    findColumn(table(), props.node.primary),
    props.node.secondary ? findColumn(table(), props.node.secondary) : undefined,
  ]);
  const rows = search.filtered;

  const toggle = (row: Row, checked: boolean) =>
    mutate({
      op: "action",
      action: { type: "update", table: props.node.table, where: { id: row.id }, values: { [props.node.checkbox!]: checked } },
    });
  const remove = (row: Row) => mutate({ op: "action", action: { type: "delete", table: props.node.table, where: { id: row.id } } });

  return (
    <div {...stylex.attrs(s.stack, s.gapSm)}>
      <Show when={props.node.searchable}>
        <SearchBox value={search.query()} onInput={search.setQuery} />
      </Show>
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
        <p {...stylex.attrs(s.empty)}>{search.query() ? "No matches." : (props.node.emptyText ?? "Nothing here yet.")}</p>
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

function Progress(props: Props<"progress">) {
  const data = useData<{ value: number | null }>(() => ({
    op: "aggregate",
    table: props.node.table,
    aggregate: props.node.aggregate,
    column: props.node.column,
    where: props.node.where,
  }));
  const value = () => data.latest?.value ?? 0;
  const pct = () => Math.max(0, Math.min(100, (value() / props.node.goal) * 100));
  const color = () => toneColor[props.node.tone ?? "accent"];
  return (
    <div {...stylex.attrs(s.progress, framed() && s.frame)}>
      <div {...stylex.attrs(s.progressHeader)}>
        <span {...stylex.attrs(s.statLabel)}>{props.node.label}</span>
        <span {...stylex.attrs(s.progressValue)}>
          {data.latest ? formatStat(value(), props.node.format) : "…"}
          <span {...stylex.attrs(s.muted)}> / {formatStat(props.node.goal, props.node.format)}</span>
        </span>
      </div>
      <div {...stylex.attrs(s.track)} role="progressbar" aria-valuenow={value()} aria-valuemax={props.node.goal}>
        <div {...stylex.attrs(s.bar)} style={{ width: `${pct()}%`, "background-color": color() }} />
      </div>
    </div>
  );
}

function ActionButton(props: Props<"button">) {
  const { appId } = useApp();
  const mutate = useMutate();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const run = async () => {
    if (props.node.confirm && !(await confirmDialog(props.node.confirm, { danger: props.node.variant === "danger" }))) return;
    setBusy(true);
    setError();
    try {
      const action = props.node.action;
      if (action.type === "backend") {
        // The backend writes through the SDK, so changes arrive via realtime.
        const res = await api.backend(appId, action.path, {
          method: action.method ?? "POST",
          body: action.body && action.method !== "GET" ? JSON.stringify(action.body) : undefined,
        });
        if (!res.ok) throw new Error((await res.text()) || `${res.status} ${res.statusText}`);
      } else {
        await mutate({ op: "action", action });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div {...stylex.attrs(s.buttonRow)}>
      <Button variant={props.node.variant ?? "default"} disabled={busy()} onClick={run}>
        <Icon name={props.node.icon} size={15} />
        {props.node.label}
      </Button>
      <Show when={error()}>
        <span {...stylex.attrs(s.error)}>{error()}</span>
      </Show>
    </div>
  );
}

const catalog: { [K in UINode["type"]]: Component<Props<K>> } = {
  stack: Stack,
  grid: Grid,
  card: Card,
  tabs: Tabs,
  divider: Divider,
  heading: Heading,
  text: Text,
  markdown: Markdown,
  badge: Badge,
  image: Image,
  link: Link,
  icon: IconNode,
  form: Form,
  table: DataTable,
  list: List,
  kanban: Kanban,
  stat: Stat,
  progress: Progress,
  chart: Chart,
  button: ActionButton,
  custom: Custom,
};

// --- Styles --------------------------------------------------------------------

const s = stylex.create({
  stack: { display: "flex", flexDirection: "column", minWidth: 0 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" },
  rowItem: { flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column" },
  rowItemNatural: { flex: "0 1 auto" },
  gapSm: { gap: space.sm },
  gapMd: { gap: space.md },
  gapLg: { gap: space.lg },
  gapXl: { gap: space.xl },
  gridWrap: { containerType: "inline-size", minWidth: 0 },
  grid: { display: "grid", minWidth: 0, alignItems: "start" },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    "::before": { content: "''", flex: 1, height: 1, backgroundColor: colors.border },
    "::after": { content: "''", flex: 1, height: 1, backgroundColor: colors.border },
  },
  dividerLabel: { flexShrink: 0 },
  markdown: { fontSize: font.md, lineHeight: 1.6, minWidth: 0, overflowWrap: "anywhere" },
  badge: {
    display: "inline-flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 4,
    height: 24,
    paddingInline: space.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    fontSize: font.xs,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  image: { display: "block", width: "100%", maxWidth: "100%", backgroundColor: colors.surfaceHover },
  imageRounded: { borderRadius: radius.md },
  link: {
    display: "inline-flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 6,
    color: colors.accent,
    fontSize: font.md,
    fontWeight: 500,
    textDecoration: { default: "none", ":hover": "underline" },
  },
  search: { position: "relative", display: "flex", alignItems: "center" },
  searchIcon: { position: "absolute", left: 10, color: colors.muted, pointerEvents: "none" },
  searchInput: { paddingLeft: 32 },
  progress: { display: "flex", flexDirection: "column", gap: space.sm },
  progressHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
  progressValue: { fontSize: font.lg, fontWeight: 650, fontVariantNumeric: "tabular-nums" },
  track: { height: 8, borderRadius: radius.full, backgroundColor: colors.surfaceHover, overflow: "hidden" },
  bar: { height: "100%", borderRadius: radius.full, transition: "width 300ms ease" },

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
  buttonRow: { display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" },
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
