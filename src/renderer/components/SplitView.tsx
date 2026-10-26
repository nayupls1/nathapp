// Split view in the content area. Tabs stay where they are in the DOM (moving
// a webview would reload it): a split only places their layers side by side.
// Here are the pane rectangles, the gutters that resize them, the focus ring
// and the drop zones for a tab dragged in from the sidebar.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, type JSX } from "solid-js";
import { draggedTab } from "../lib/layout";
import { evenSplit, resizeSplit, splitWith, visibleSplit, type SplitSide } from "../lib/splits";
import { appById, isTab, selectedId } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";

/** Panes don't get narrower (or lower) than this while resizing. */
const MIN_PANE_PX = 240;

/** Where a tab of the split on screen goes, as fractions of the content area; null if it isn't in it. */
export function paneRect(tabId: string): { left: number; top: number; width: number; height: number } | null {
  const split = visibleSplit();
  const i = split?.tabs.indexOf(tabId) ?? -1;
  if (!split || i === -1) return null;
  const offset = split.sizes.slice(0, i).reduce((a, b) => a + b, 0);
  const size = split.sizes[i]!;
  return split.direction === "row" ? { left: offset, top: 0, width: size, height: 1 } : { left: 0, top: offset, width: 1, height: size };
}

/** The inline style that puts a layer in its pane. */
export function paneStyle(tabId: string): JSX.CSSProperties | undefined {
  const r = paneRect(tabId);
  if (!r) return undefined;
  const pct = (v: number) => `${v * 100}%`;
  return { left: pct(r.left), top: pct(r.top), width: pct(r.width), height: pct(r.height), right: "auto", bottom: "auto" };
}

/** The handles between the panes of the split on screen, and the focused pane's outline. */
export function SplitChrome() {
  const [dragging, setDragging] = createSignal<"row" | "column" | null>(null);

  const startResize = (e: PointerEvent, index: number) => {
    const split = visibleSplit();
    if (!split || e.button !== 0) return;
    e.preventDefault();
    const area = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const row = split.direction === "row";
    const length = row ? area.width : area.height;
    const start = split.sizes.slice(0, index).reduce((a, b) => a + b, 0);
    const end = start + split.sizes[index]! + split.sizes[index + 1]!;
    const min = Math.min(MIN_PANE_PX / length, (end - start) / 2);
    let sizes = split.sizes;
    setDragging(split.direction);
    const move = (ev: PointerEvent) => {
      const at = (row ? ev.clientX - area.left : ev.clientY - area.top) / length;
      const boundary = Math.min(end - min, Math.max(start + min, at));
      sizes = split.sizes.map((s, i) => (i === index ? boundary - start : i === index + 1 ? end - boundary : s));
      resizeSplit(split.id, sizes, false);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setDragging(null);
      resizeSplit(split.id, sizes, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const focused = () => {
    const id = selectedId();
    return id && visibleSplit() ? paneStyle(id) : undefined;
  };

  return (
    <Show when={visibleSplit()}>
      {(split) => {
        const isRow = () => split().direction === "row";
        const isColumn = () => split().direction === "column";
        return (
          <>
            <Show when={focused()}>{(style) => <div {...stylex.attrs(styles.focus)} style={style()} data-split-focus />}</Show>
            <For each={split().tabs.slice(0, -1)}>
              {(_, i) => {
                const at = () => `${split().sizes.slice(0, i() + 1).reduce((a, b) => a + b, 0) * 100}%`;
                return (
                  <div
                    role="separator"
                    aria-orientation={isRow() ? "vertical" : "horizontal"}
                    title="Drag to resize · double-click for equal sizes"
                    onPointerDown={(e) => startResize(e, i())}
                    onDblClick={() => evenSplit(split().id)}
                    {...stylex.attrs(styles.gutter, isRow() && styles.gutterRow, isColumn() && styles.gutterColumn)}
                    style={isRow() ? { left: at() } : { top: at() }}
                    data-split-gutter={i()}
                  />
                );
              }}
            </For>
            <Show when={dragging()}>
              {(direction) => <div {...stylex.attrs(styles.shield)} style={{ cursor: direction() === "row" ? "col-resize" : "row-resize" }} />}
            </Show>
          </>
        );
      }}
    </Show>
  );
}

const sideLabels: Record<SplitSide, string> = { left: "Split left", right: "Split right", top: "Split above", bottom: "Split below" };

/**
 * While a tab is dragged from the sidebar: drop it on a side of the tab on
 * screen to show them side by side (or at an end of the split on screen).
 */
export function SplitDropZones() {
  const [side, setSide] = createSignal<SplitSide | null>(null);
  const target = () => {
    const id = selectedId();
    return isTab(id) && appById(id) ? id : null;
  };
  const usable = () => {
    const dragged = draggedTab();
    const id = target();
    if (!dragged || !id) return false;
    // A tab can't be split with itself, but it can move within the split on screen.
    return dragged !== id || !!visibleSplit();
  };

  const sideAt = (e: DragEvent): SplitSide => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const split = visibleSplit();
    if (split) return split.direction === "row" ? (x < 0.5 ? "left" : "right") : y < 0.5 ? "top" : "bottom";
    return Math.min(x, 1 - x) <= Math.min(y, 1 - y) ? (x < 0.5 ? "left" : "right") : y < 0.5 ? "top" : "bottom";
  };

  const previewStyle = (s: SplitSide): JSX.CSSProperties => {
    // A new pane at an end of a split gets a share like the others.
    const n = (visibleSplit()?.tabs.length ?? 1) + 1;
    const share = `${100 / n}%`;
    return s === "left"
      ? { left: 0, top: 0, bottom: 0, width: share }
      : s === "right"
        ? { right: 0, top: 0, bottom: 0, width: share }
        : s === "top"
          ? { left: 0, right: 0, top: 0, height: share }
          : { left: 0, right: 0, bottom: 0, height: share };
  };

  return (
    <Show when={usable()}>
      <div
        {...stylex.attrs(styles.drop)}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer!.dropEffect = "move";
          setSide(sideAt(e));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSide(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const dragged = draggedTab();
          const id = target();
          const at = sideAt(e);
          setSide(null);
          if (dragged && id) splitWith(id, dragged, at);
        }}
        data-split-drop
      >
        <Show when={side()}>
          {(s) => (
            <div {...stylex.attrs(styles.preview)} style={previewStyle(s())} data-split-preview={s()}>
              <span {...stylex.attrs(styles.previewLabel)}>{sideLabels[s()]}</span>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

const styles = stylex.create({
  gutter: {
    position: "absolute",
    zIndex: 5,
    backgroundColor: { default: "transparent", ":hover": colors.accent },
    opacity: { default: 1, ":hover": 0.45 },
    transitionProperty: "background-color",
    transitionDuration: "120ms",
    // The line between the panes.
    boxShadow: `0 0 0 0.5px ${colors.border}`,
  },
  gutterRow: { top: 0, bottom: 0, width: 6, marginLeft: -3, cursor: "col-resize" },
  gutterColumn: { left: 0, right: 0, height: 6, marginTop: -3, cursor: "row-resize" },
  shield: { position: "fixed", inset: 0, zIndex: 1000 },
  focus: {
    position: "absolute",
    zIndex: 4,
    pointerEvents: "none",
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: colors.accent,
    opacity: 0.55,
  },
  drop: { position: "absolute", inset: 0, zIndex: 50 },
  preview: {
    position: "absolute",
    display: "grid",
    placeItems: "center",
    margin: space.sm,
    borderRadius: radius.md,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    opacity: 0.9,
    pointerEvents: "none",
  },
  previewLabel: {
    paddingBlock: 4,
    paddingInline: space.md,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontFamily: font.sans,
    fontSize: font.sm,
    fontWeight: 600,
  },
});
