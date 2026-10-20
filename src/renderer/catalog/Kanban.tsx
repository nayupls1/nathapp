// The "kanban" catalog component: rows as cards in lanes, one lane per value
// of a choice (or boolean) column. Dragging a card to another lane updates it.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Row } from "../../shared/api";
import type { UINode, Value } from "../../shared/spec";
import { Icon } from "../components/Icon";
import { colors, font, radius, space } from "../theme.stylex";
import { columnLabel, findColumn, formatValue, useData, useMutate, useTable } from "./context";

type KanbanNode = Extract<UINode, { type: "kanban" }>;

export function Kanban(props: { node: KanbanNode }) {
  const table = useTable(() => props.node.table);
  const mutate = useMutate();
  const data = useData<{ rows: Row[] }>(() => ({
    op: "query",
    table: props.node.table,
    where: props.node.where,
    sort: props.node.sort ?? { column: "created_at", dir: "asc" },
    limit: 1000,
  }));
  // Optimistic moves, so a dropped card doesn't jump back while the update is in flight.
  const [moved, setMoved] = createSignal<Record<number, Value>>({});
  const [dragging, setDragging] = createSignal<number>();
  const [over, setOver] = createSignal<string>();

  const column = () => findColumn(table(), props.node.groupBy);
  const laneOf = (row: Row): Value => (row.id in moved() ? moved()[row.id]! : (row[props.node.groupBy] ?? null));
  const lanes = createMemo((): Value[] => {
    const col = column();
    const values: Value[] = col?.options ?? (col?.type === "boolean" ? [false, true] : []);
    const rows = data.latest?.rows ?? [];
    return rows.some((r) => laneOf(r) === null) ? [null, ...values] : values;
  });
  const laneKey = (v: Value) => JSON.stringify(v);

  const drop = async (lane: Value) => {
    const id = dragging();
    setOver();
    setDragging();
    const row = data.latest?.rows.find((r) => r.id === id);
    if (!row || laneOf(row) === lane) return;
    setMoved((m) => ({ ...m, [row.id]: lane }));
    try {
      await mutate({
        op: "action",
        action: { type: "update", table: props.node.table, where: { id: row.id }, values: { [props.node.groupBy]: lane } },
      });
    } finally {
      setMoved(({ [row.id]: _, ...rest }) => rest);
    }
  };

  const remove = (row: Row) =>
    mutate({ op: "action", action: { type: "delete", table: props.node.table, where: { id: row.id } } });

  return (
    <div {...stylex.attrs(s.board)}>
      <For each={lanes()}>
        {(lane) => {
          const rows = () => (data.latest?.rows ?? []).filter((r) => laneOf(r) === lane);
          const isOver = () => over() === laneKey(lane);
          return (
            <section
              {...stylex.attrs(s.lane, isOver() && s.laneOver)}
              data-lane={laneKey(lane)}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(laneKey(lane));
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver();
              }}
              onDrop={(e) => {
                e.preventDefault();
                void drop(lane);
              }}
            >
              <header {...stylex.attrs(s.laneHeader)}>
                <span>{lane === null ? `No ${column() ? columnLabel(column()!).toLowerCase() : "value"}` : formatValue(column(), lane)}</span>
                <span {...stylex.attrs(s.count)}>{rows().length}</span>
              </header>
              <div {...stylex.attrs(s.cards)}>
                <For each={rows()}>
                  {(row) => (
                    <article
                      draggable="true"
                      onDragStart={(e) => {
                        e.dataTransfer?.setData("text/plain", String(row.id));
                        setDragging(row.id);
                      }}
                      onDragEnd={() => {
                        setDragging();
                        setOver();
                      }}
                      {...stylex.attrs(s.card, dragging() === row.id && s.cardDragging)}
                      data-card-id={row.id}
                    >
                      <Icon name={props.node.icon} size={15} {...stylex.attrs(s.cardIcon)} />
                      <div {...stylex.attrs(s.cardText)}>
                        <span {...stylex.attrs(s.cardTitle)}>
                          {formatValue(findColumn(table(), props.node.title), row[props.node.title] ?? null)}
                        </span>
                        <Show when={props.node.secondary}>
                          {(sec) => (
                            <span {...stylex.attrs(s.cardSecondary)}>{formatValue(findColumn(table(), sec()), row[sec()] ?? null)}</span>
                          )}
                        </Show>
                      </div>
                      <Show when={props.node.deletable}>
                        <button type="button" title="Delete" onClick={() => remove(row)} {...stylex.attrs(s.delete)}>
                          <Icon name="x" size={14} />
                        </button>
                      </Show>
                    </article>
                  )}
                </For>
              </div>
            </section>
          );
        }}
      </For>
    </div>
  );
}

const s = stylex.create({
  board: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "minmax(220px, 1fr)",
    gap: space.md,
    overflowX: "auto",
    paddingBottom: space.xs,
  },
  lane: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.sm,
    minHeight: 120,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "transparent",
    transition: "border-color 100ms, background-color 100ms",
  },
  laneOver: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  laneHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: space.xs,
    fontSize: font.xs,
    fontWeight: 600,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  count: { fontVariantNumeric: "tabular-nums" },
  cards: { display: "flex", flexDirection: "column", gap: space.sm, flex: 1 },
  card: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
    cursor: "grab",
  },
  cardDragging: { opacity: 0.4 },
  cardIcon: { flexShrink: 0, marginTop: 2, color: colors.muted },
  cardText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: font.sm, fontWeight: 500, overflowWrap: "anywhere" },
  cardSecondary: { fontSize: font.xs, color: colors.muted },
  delete: {
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
});
