// Open web tabs register a handle here so the website agent (RPC from the
// server), browser shortcuts and site customization updates can reach them.
import { createStore } from "solid-js/store";
import { createEffect, createRoot, createSignal } from "solid-js";
import type { NetworkFilter, PageChange, ReplayOverrides, RequestDraft, SiteOverride, WebShortcut } from "../../shared/api";
import { topics } from "../../shared/hub";
import { hostOf } from "../../shared/web";
import { api } from "./api";
import { handleRpc, onConnected, watchTopic } from "./realtime";
import { openCommandBar } from "./commands";
import { settings, settingsLoaded } from "./settings";
import { appById, isTab, newWebTab, openTab, selectedId, showWorkspace, toggleAgent, workspaces } from "./store";
import { targetScript, waitForScript, type Locator } from "./browse";
import { readPageScript, type SavedPage } from "./pagestate";
import { toggleSidebar } from "./layout";

export interface PageInfo {
  url: string;
  title: string;
}

export interface ApplyResult {
  /** The site's customization is on and applied. */
  applied: boolean;
  /** Its JavaScript threw. */
  error?: string;
  /** Customizations and page changes are on (Settings, not safe mode). */
  changesEnabled?: boolean;
  /** Page changes that failed on this page, by id. */
  changeErrors?: Record<string, string>;
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
  /** Re-reads the site's customization and applies it and the page changes; returns JS errors. */
  applyOverride: () => Promise<ApplyResult>;
  /** Called when the customization of `host` changed somewhere. */
  overrideChanged: (host: string) => void;
  /** Sends a prompt to the tab's agent, with the page and the picked elements (lib/picks.ts). */
  send: (prompt: string) => void;
  /** Starts picking an element in the page for the agent (or cancels picking). */
  pick: () => Promise<void>;
  /** Takes back a picked element (and its mark in the page). */
  unpick: (selector: string) => void;
  /** The page's webContents (web tabs only: their traffic is recorded). */
  webContentsId: () => number;
  /** Resolves once the page has loaded (right away if it has). */
  whenLoaded: () => Promise<void>;
  /** Scroll position and what was typed, before the tab is unloaded; null without a page. */
  saveState: () => Promise<SavedPage | null>;
  /** Something the user would notice going away is happening (sound playing). */
  busy: () => boolean;
  /** Web tabs: an action of the website agent, with real input events (lib/browse.ts). */
  act?: (action: BrowseAction) => Promise<unknown>;
  /** Web tabs: waits for what an action started (a navigation) to finish. */
  settle?: () => Promise<PageInfo>;
}

export type BrowseAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; x: number; y: number; value: string; clear: boolean }
  | { kind: "fill"; selector: string; x: number; y: number; value: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; direction: "down" | "up"; pixels: number | null; selector: string | null };

const pages = new Map<string, PageHandle>();
// Bumped when pages come and go or get their webContents (extensions follow the tabs).
const [pagesVersion, setPagesVersion] = createSignal(0);
export { pagesVersion };
export const pagesChanged = () => setPagesVersion((v) => v + 1);

/** The page open in a tab (web tab or app preview), if it's mounted. */
export const pageOf = (tabId: string) => pages.get(tabId);

/** The tab showing a webContents. */
export function tabOfContents(webContentsId: number) {
  for (const [tabId, handle] of pages) {
    try {
      if (handle.webContentsId() === webContentsId) return tabId;
    } catch {
      // not loaded yet
    }
  }
  return undefined;
}

export function registerPage(tabId: string, handle: PageHandle) {
  pages.set(tabId, handle);
  pagesChanged();
  return () => {
    if (pages.get(tabId) === handle) pages.delete(tabId);
    pagesChanged();
  };
}

const registered = (tabId: string, ms: number) =>
  new Promise<PageHandle | undefined>((resolve) => {
    const start = Date.now();
    const poll = () => {
      const handle = pages.get(tabId);
      if (handle || Date.now() - start > ms) resolve(handle);
      else setTimeout(poll, 50);
    };
    poll();
  });

/**
 * The page of a tab, for agents. A tab that isn't loaded (unloaded for being
 * idle, or not opened since NathApp started) is woken up first, in the
 * background, and stays loaded until it's idle again.
 */
export async function wakePage(tabId: string) {
  let handle = pages.get(tabId);
  if (!handle && appById(tabId)) {
    await openTab(tabId);
    handle = await registered(tabId, 5_000);
    // Waits for its first load (bounded: an app that isn't running has no page to load).
    await handle?.whenLoaded();
  }
  if (!handle) throw new Error("No page is open in this tab");
  return handle;
}

async function page(tabId: unknown) {
  if (typeof tabId !== "string") throw new Error("No page is open in this tab");
  return wakePage(tabId);
}

handleRpc("page.info", async ({ tabId }) => (await page(tabId)).info());
handleRpc("page.eval", async ({ tabId, code }) => (await page(tabId)).eval(String(code)));
handleRpc("page.capture", async ({ tabId }) => (await page(tabId)).capture());
handleRpc("page.navigate", async ({ tabId, url }) => (await page(tabId)).navigate(String(url)));
handleRpc("page.reload", async ({ tabId }) => (await page(tabId)).reload());
// The website agent's browse tools (agent/browseTools.ts): find the element, then act on it.
const browsing = async (tabId: unknown) => {
  const handle = await page(tabId);
  if (!handle.act || !handle.settle) throw new Error("Only web pages can be used this way");
  return handle as PageHandle & Required<Pick<PageHandle, "act" | "settle">>;
};
handleRpc("page.target", async (params) => (await browsing(params.tabId)).eval(targetScript(params as Locator)));
handleRpc("page.act", async (params) => (await browsing(params.tabId)).act(params as unknown as BrowseAction));
handleRpc("page.settle", async ({ tabId }) => (await browsing(tabId)).settle());
handleRpc("page.waitFor", async ({ tabId, text, selector, timeoutMs }) =>
  (await browsing(tabId)).eval(waitForScript((text as string | null) ?? null, (selector as string | null) ?? null, Math.min(Number(timeoutMs) || 10_000, 60_000))),
);
// read_tab (shared tab context): what another tab's page shows, as text.
handleRpc("page.read", async ({ tabId }) => (await page(tabId)).eval(readPageScript));
// The agent just saved the site's customization: apply the fresh version (the
// realtime notification may not have arrived yet).
handleRpc("page.applyOverride", async ({ tabId }) => {
  const handle = await page(tabId);
  const host = hostOf(handle.info().url);
  if (host) setOverrides(host, await api.getSite(host));
  await loadPageChanges();
  return handle.applyOverride();
});

// --- Network (main/network.ts) ---------------------------------------------------------
// What the website agent gets is always redacted (reveal: false).

const network = window.nathapp.web.network;
handleRpc("network.list", async ({ tabId, filter }) => network.list((await page(tabId)).webContentsId(), (filter ?? {}) as NetworkFilter));
handleRpc("network.get", async ({ tabId, id }) => network.get((await page(tabId)).webContentsId(), String(id), false));
handleRpc("network.draft", async ({ tabId, id }) => network.draft((await page(tabId)).webContentsId(), String(id)));
handleRpc("network.replay", async ({ tabId, id, workspaceId, draft, overrides }) =>
  network.replay(
    typeof workspaceId === "string" ? { workspaceId, draft: draft as RequestDraft } : { webContentsId: (await page(tabId)).webContentsId(), id: String(id) },
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

// --- Page changes ----------------------------------------------------------------------

const [pageChanges, setPageChanges] = createSignal<PageChange[]>([]);
/** Every page change (web tabs apply the ones whose scope matches their page). */
export { pageChanges };

async function loadPageChanges() {
  const list = await api.pageChanges().catch(() => null);
  if (list) setPageChanges(list);
}

watchTopic(topics.sites, (msg) => {
  if (msg.type === "page-changes") void loadPageChanges();
});
onConnected(() => void loadPageChanges());

// --- Shortcuts ---------------------------------------------------------------------

function runShortcut(name: WebShortcut) {
  const id = selectedId();
  if (name === "command-bar") return openCommandBar();
  if (name === "new-tab") return void newWebTab();
  if (name === "toggle-sidebar") return toggleSidebar();
  if (name.startsWith("workspace-")) {
    const target = workspaces[Number(name.slice("workspace-".length)) - 1];
    if (target) void showWorkspace(target.id);
    return;
  }
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
  const digit = /^Digit([1-9])$/.exec(e.code);
  if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && digit) {
    e.preventDefault();
    return runShortcut(`workspace-${Number(digit[1])}`);
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.shiftKey) {
    if (e.key.toLowerCase() !== "b") return;
    e.preventDefault();
    return runShortcut("toggle-sidebar");
  }
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
