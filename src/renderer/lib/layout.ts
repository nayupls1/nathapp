// The main sidebar's width and whether it's collapsed to icons. Remembered across restarts.
import { createSignal } from "solid-js";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 232;

const KEY = "nathapp.sidebar";

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as { width?: number; collapsed?: boolean };
  } catch {
    return {};
  }
})();

const clamp = (width: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));

const [width, setWidthSignal] = createSignal(clamp(typeof saved.width === "number" ? saved.width : SIDEBAR_DEFAULT));
const [collapsed, setCollapsedSignal] = createSignal(saved.collapsed === true);

const save = () => localStorage.setItem(KEY, JSON.stringify({ width: width(), collapsed: collapsed() }));

export const sidebarWidth = width;
export const isSidebarCollapsed = collapsed;

/** While dragging, `persist` is false so only the end of the drag is written. */
export function setSidebarWidth(value: number, persist = true) {
  setWidthSignal(clamp(value));
  if (persist) save();
}

export function setSidebarCollapsed(value: boolean) {
  setCollapsedSignal(value);
  save();
}

export const toggleSidebar = () => setSidebarCollapsed(!collapsed());

/** The tab being dragged from the sidebar, if any (drop targets light up for it). */
export const [draggedTab, setDraggedTab] = createSignal<string | null>(null);
/** The data type of a tab drag. */
export const TAB_DRAG_TYPE = "application/x-nathapp-tab";
/** A split view being dragged from the sidebar (all its tabs move together). */
export const [draggedSplit, setDraggedSplit] = createSignal<string | null>(null);
