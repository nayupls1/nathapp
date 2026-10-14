import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";
import type { AppSummary } from "../../shared/api";
import { apps, deleteApp, newApp, renameApp, selectApp, selectedId, states } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Button } from "./ui";

export function Sidebar() {
  return (
    <nav {...stylex.attrs(styles.root)}>
      <div {...stylex.attrs(styles.header)}>
        <span {...stylex.attrs(styles.brand)}>gApp</span>
      </div>
      <Button onClick={() => newApp()} xstyle={styles.newButton}>
        + New app
      </Button>
      <ul {...stylex.attrs(styles.list)}>
        <For each={apps}>{(app) => <Item app={app} />}</For>
      </ul>
    </nav>
  );
}

function Item(props: { app: AppSummary }) {
  const [editing, setEditing] = createSignal(false);
  const selected = () => selectedId() === props.app.id;
  const running = () => states[props.app.id]?.running;

  const commit = (value: string) => {
    setEditing(false);
    const name = value.trim();
    if (name && name !== props.app.name) renameApp(props.app.id, name);
  };

  return (
    <li
      {...stylex.attrs(stylex.defaultMarker(), styles.item, selected() && styles.selected)}
      onClick={() => selectApp(props.app.id)}
      onDblClick={() => setEditing(true)}
      title="Double-click to rename"
    >
      <span {...stylex.attrs(styles.icon)}>{props.app.icon ?? "✦"}</span>
      <Show
        when={editing()}
        fallback={<span {...stylex.attrs(styles.name)}>{props.app.name}</span>}
      >
        <input
          ref={(el) => queueMicrotask(() => el.select())}
          value={props.app.name}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          {...stylex.attrs(styles.rename)}
        />
      </Show>
      <Show when={running()}>
        <span {...stylex.attrs(styles.dot)} title="Agent is working" />
      </Show>
      <button
        type="button"
        title="Delete app"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Delete “${props.app.name}” and all its data?`)) deleteApp(props.app.id);
        }}
        {...stylex.attrs(styles.delete)}
      >
        ✕
      </button>
    </li>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.3 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.3 },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: 232,
    flexShrink: 0,
    padding: space.md,
    backgroundColor: colors.sidebar,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    overflowY: "auto",
  },
  header: { display: "flex", alignItems: "center", height: 32, paddingInline: space.sm },
  brand: { fontWeight: 700, fontSize: font.lg, letterSpacing: "-0.02em" },
  newButton: { justifyContent: "flex-start", width: "100%" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 34,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    fontSize: font.sm,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  selected: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px ${colors.border}`,
    fontWeight: 500,
  },
  icon: { width: 18, textAlign: "center", flexShrink: 0 },
  name: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rename: {
    flex: 1,
    minWidth: 0,
    height: 24,
    paddingInline: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    outline: "none",
    fontSize: font.sm,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    flexShrink: 0,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  delete: {
    display: "grid",
    placeItems: "center",
    width: 20,
    height: 20,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.muted,
    fontSize: 11,
    cursor: "pointer",
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, ":focus-visible": 1 },
  },
});
