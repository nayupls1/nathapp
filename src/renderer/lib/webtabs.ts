// Open web tabs register a handle here so the website agent (RPC from the
// server), browser shortcuts and site customization updates can reach them.
import { createStore } from "solid-js/store";
import type { SiteOverride, WebShortcut } from "../../shared/api";
import { hostOf } from "../../shared/web";
import { api } from "./api";
import { handleRpc, onConnected, watchTopic } from "./realtime";
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
}

const pages = new Map<string, PageHandle>();

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
    key === "j" ? "toggle-agent" : key === "t" ? "new-tab" : key === "l" && pages.has(selectedId() ?? "") ? "focus-address" : undefined;
  if (!name) return;
  e.preventDefault();
  runShortcut(name);
});
