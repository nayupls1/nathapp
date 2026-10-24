// Open web tabs register a handle here so the website agent (RPC from the
// server), browser shortcuts and site customization updates can reach them.
import { createStore } from "solid-js/store";
import { createEffect, createRoot } from "solid-js";
import type { NetworkFilter, ReplayOverrides, RequestDraft, SiteOverride, WebShortcut } from "../../shared/api";
import { topics } from "../../shared/hub";
import { hostOf } from "../../shared/web";
import { api } from "./api";
import { handleRpc, onConnected, watchTopic } from "./realtime";
import { openCommandBar } from "./commands";
import { settings, settingsLoaded } from "./settings";
import { isTab, newWebTab, selectedId, toggleAgent } from "./store";

export interface PageInfo {
  url: string;
  title: string;
}

export interface PageHandle {
  info: () => PageInfo;
  eval: (code: string) => Promise<unknown>;
  capture: () => Promise<string>;
  navigate: (url: string) => Promise<PageInfo>;
  reload: () => Promise<PageInfo>;
  back: () => void;
  forward: () => void;
  focusAddress: () => void;
  /** Re-reads the site's customization and applies it; returns JS errors. */
  applyOverride: () => Promise<{ applied: boolean; error?: string }>;
  /** Called when the customization of `host` changed somewhere. */
  overrideChanged: (host: string) => void;
  /** Sends a prompt to the tab's agent, with the page and picked elements, like its chat does. */
  send: (prompt: string) => void;
  /** The page's webContents (web tabs only: their traffic is recorded). */
  webContentsId: () => number;
}

const pages = new Map<string, PageHandle>();

/** The page open in a tab (web tab or app preview), if it's mounted. */
export const pageOf = (tabId: string) => pages.get(tabId);

export function registerPage(tabId: string, handle: PageHandle) {
  pages.set(tabId, handle);
  return () => {
    if (pages.get(tabId) === handle) pages.delete(tabId);
  };
}

function page(tabId: unknown) {
  const handle = typeof tabId === "string" ? pages.get(tabId) : undefined;
  if (!handle) throw new Error("No page is open in this tab");
  return handle;
}

handleRpc("page.info", ({ tabId }) => page(tabId).info());
handleRpc("page.eval", ({ tabId, code }) => page(tabId).eval(String(code)));
handleRpc("page.capture", ({ tabId }) => page(tabId).capture());
handleRpc("page.navigate", ({ tabId, url }) => page(tabId).navigate(String(url)));
handleRpc("page.reload", ({ tabId }) => page(tabId).reload());
// The agent just saved the site's customization: apply the fresh version (the
// realtime notification may not have arrived yet).
handleRpc("page.applyOverride", async ({ tabId }) => {
  const handle = page(tabId);
  const host = hostOf(handle.info().url);
  if (host) setOverrides(host, await api.getSite(host));
  return handle.applyOverride();
});

// --- Network (main/network.ts) ---------------------------------------------------------
// What the website agent gets is always redacted (reveal: false).

const network = window.nathapp.web.network;
handleRpc("network.list", ({ tabId, filter }) => network.list(page(tabId).webContentsId(), (filter ?? {}) as NetworkFilter));
handleRpc("network.get", ({ tabId, id }) => network.get(page(tabId).webContentsId(), String(id), false));
handleRpc("network.draft", ({ tabId, id }) => network.draft(page(tabId).webContentsId(), String(id)));
handleRpc("network.replay", ({ tabId, id, workspaceId, draft, overrides }) =>
  network.replay(
    typeof workspaceId === "string" ? { workspaceId, draft: draft as RequestDraft } : { webContentsId: page(tabId).webContentsId(), id: String(id) },
    (overrides ?? {}) as ReplayOverrides,
    false,
  ),
);

// Rules live on the server; the main process applies them.
const syncRules = () => api.networkRules().then(network.setRules, (err) => console.error("Loading network rules failed:", err));
watchTopic(topics.network, (msg) => {
  if (msg.type === "network-changed" && msg.what === "rules") void syncRules();
});
onConnected(() => void syncRules());

createRoot(() => {
  createEffect(() => {
    if (settingsLoaded()) network.setRecording(settings().web.recordNetwork);
  });
});

// --- Site customizations ---------------------------------------------------------

const [overrides, setOverrides] = createStore<Record<string, SiteOverride | null>>({});
const loading = new Map<string, Promise<SiteOverride | null>>();

/** The customization of a site (cached; refetched when it changes). */
export function siteOverride(host: string): Promise<SiteOverride | null> {
  if (host in overrides) return Promise.resolve(overrides[host] ?? null);
  let promise = loading.get(host);
  if (!promise) {
    promise = api
      .getSite(host)
      .then((o) => {
        setOverrides(host, o);
        return o;
      })
      .finally(() => loading.delete(host));
    loading.set(host, promise);
  }
  return promise;
}

/** Reactive view of the cache, for showing whether a site is customized. */
export const cachedOverride = (host: string) => overrides[host] ?? null;

async function refetch(host: string) {
  const fresh = await api.getSite(host).catch(() => null);
  setOverrides(host, fresh);
  for (const handle of pages.values()) handle.overrideChanged(host);
}

watchTopic("sites", (msg) => {
  if (msg.type === "site") void refetch(msg.host);
});
// Changes while disconnected weren't pushed.
onConnected(() => {
  for (const host of Object.keys(overrides)) void refetch(host);
});

// --- Shortcuts ---------------------------------------------------------------------

function runShortcut(name: WebShortcut) {
  const id = selectedId();
  if (name === "command-bar") return openCommandBar();
  if (name === "new-tab") return void newWebTab();
  if (!isTab(id)) return;
  if (name === "toggle-agent") return toggleAgent(id);
  const handle = pages.get(id);
  if (!handle) return;
  if (name === "focus-address") handle.focusAddress();
  else if (name === "reload") void handle.reload().catch(() => {});
  else if (name === "back") handle.back();
  else if (name === "forward") handle.forward();
}

// From web pages (keys pressed while a page has focus) and Ctrl+R in NathApp itself.
window.nathapp.web.onShortcut(runShortcut);
// Links that want a new window (web pages, app previews, chat links).
window.nathapp.web.onOpenTab((url) => void newWebTab(url));

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  const name: WebShortcut | undefined =
    key === "k"
      ? "command-bar"
      : key === "j"
        ? "toggle-agent"
        : key === "t"
          ? "new-tab"
          : key === "l" && pages.has(selectedId() ?? "")
            ? "focus-address"
            : undefined;
  if (!name) return;
  e.preventDefault();
  runShortcut(name);
});
