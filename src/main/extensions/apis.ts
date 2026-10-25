// The main-process half of the chrome.* APIs the shim adds (see
// src/extension-preload/shim.ts). An extension only sees the web tabs of its
// own workspace (each workspace's session runs its own copy of it), and only
// what its permissions allow: URLs and titles with "tabs" or a host
// permission, or for the tab the user invoked it on (activeTab).
import {
  BrowserWindow,
  nativeImage,
  Notification,
  powerMonitor,
  webContents,
  webFrameMain,
  type WebFrameMain,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { join } from "node:path";
import {
  hostPermissionsOf,
  iconPath,
  matchesAny,
  matchPattern,
  optionsPageOf,
  parseColor,
  permissionsOf,
  type DnrRule,
  type ExtensionTabRequest,
  type Manifest,
} from "../../shared/extensions";
import { dispatch, keepAlive, type ActionState, type Context, type Contexts, type ExtensionState, type MenuItem } from "./host";
import { connectNative, sendNativeMessage, type NativePort } from "./native";
import { extensionFile, extensionsDir, imageDataUrl, readJson, readManifest, writeJson, type InstalledExtension, type Registry } from "./registry";

export interface ApiEnv {
  contexts: Contexts;
  registry: Registry;
  state: (s: Session, id: string) => ExtensionState | undefined;
  workspaceOf: (s: Session) => string | undefined;
  /** Every web tab session with extensions running. */
  sessions: () => Session[];
  window: () => BrowserWindow | undefined;
  /** A workspace's web tabs (webContents ids, in order) and the selected one. */
  tabs: (workspaceId: string) => number[];
  active: (workspaceId: string) => number | null;
  hasActiveTab: (s: Session, id: string, tabId: number) => boolean;
  /** The user invoked the extension on a tab (toolbar button, shortcut, context menu): activeTab. */
  grantActiveTab: (s: Session, id: string, tabId: number | null) => void;
  /** Asks the NathApp window to open, select or close a tab; resolves with the tab's webContents id. */
  requestTab: (request: DistributiveOmit<ExtensionTabRequest, "requestId">) => Promise<number | null>;
  requestPermission: (s: Session, id: string, permissions: string[], origins: string[]) => Promise<boolean>;
  openPopup: (s: Session, id: string) => boolean;
  actionsChanged: (s: Session) => void;
  commandsOf: (id: string) => { name: string; description: string; shortcut: string }[];
  rules: (s: Session) => DnrRule[];
  reload: (s: Session, id: string) => void;
  /** Resolves when the extension finished loading in the session. */
  whenLoaded: (s: Session, id: string) => Promise<void>;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

const err = (message: string) => new Error(message);

/** A pattern like "https://*.example.com/*" as a URL it covers, to check it against other patterns. */
function sampleUrl(pattern: string) {
  if (pattern === "<all_urls>") return "https://example.com/";
  return pattern.replace(/^\*:/, "https:").replace("://*.", "://").replace("://*/", "://example.com/").replace(/\*/g, "");
}

// --- storage.sync: one file per extension, shared by every workspace -------------------------

const SYNC_QUOTA = 102400;
const SYNC_ITEM_QUOTA = 8192;
const SYNC_MAX_ITEMS = 512;

class SyncStore {
  private cache = new Map<string, Record<string, unknown>>();
  private file = (id: string) => join(extensionsDir(), "sync", `${id}.json`);

  data(id: string) {
    let d = this.cache.get(id);
    if (!d) {
      d = readJson<Record<string, unknown>>(this.file(id)) ?? {};
      this.cache.set(id, d);
    }
    return d;
  }

  save(id: string) {
    writeJson(this.file(id), this.data(id));
  }

  forget(id: string) {
    this.cache.delete(id);
  }
}

const itemSize = (key: string, value: unknown) => key.length + JSON.stringify(value ?? null).length;

export function createApis(env: ApiEnv) {
  const sync = new SyncStore();
  const favicons = new Map<number, string>();
  const nativePorts = new Map<string, NativePort>();
  const notifications = new Map<string, Notification>();

  const manifestOf = (s: Session, id: string): Manifest => (s.extensions.getExtension(id)?.manifest as Manifest | undefined) ?? {};
  const entryOf = (id: string): InstalledExtension | undefined => env.registry.get(id);

  // --- Permissions ----------------------------------------------------------------------------

  const required = (s: Session, id: string) => {
    const m = manifestOf(s, id);
    return { permissions: permissionsOf(m), origins: hostPermissionsOf(m) };
  };
  const granted = (id: string) => entryOf(id)?.granted ?? { permissions: [], origins: [] };
  const allPermissions = (s: Session, id: string) => {
    const r = required(s, id);
    const g = granted(id);
    return { permissions: [...new Set([...r.permissions, ...g.permissions])], origins: [...new Set([...r.origins, ...g.origins])] };
  };
  const hasPermission = (s: Session, id: string, permission: string) => allPermissions(s, id).permissions.includes(permission);
  const hostAccess = (s: Session, id: string, url: string) => matchesAny(allPermissions(s, id).origins, url);

  const covers = (origins: string[], pattern: string) => origins.includes(pattern) || matchesAny(origins, sampleUrl(pattern));

  function contains(s: Session, id: string, p: { permissions?: string[]; origins?: string[] }) {
    const all = allPermissions(s, id);
    return (p.permissions ?? []).every((x) => all.permissions.includes(x)) && (p.origins ?? []).every((o) => covers(all.origins, o));
  }

  // --- Tabs -------------------------------------------------------------------------------------

  const windowId = () => env.window()?.id ?? 1;

  function tabContents(s: Session, tabId: unknown): WebContents {
    const workspaceId = env.workspaceOf(s);
    const contents = typeof tabId === "number" ? webContents.fromId(tabId) : undefined;
    if (!workspaceId || !contents || contents.isDestroyed() || contents.session !== s || !env.tabs(workspaceId).includes(contents.id)) throw err(`No tab with id: ${tabId}.`);
    return contents;
  }

  function activeContents(s: Session) {
    const workspaceId = env.workspaceOf(s);
    const id = workspaceId ? env.active(workspaceId) : null;
    const contents = id === null ? undefined : webContents.fromId(id);
    return contents && !contents.isDestroyed() ? contents : null;
  }

  const canSee = (s: Session, id: string, contents: WebContents) => {
    const url = contents.getURL();
    return hasPermission(s, id, "tabs") || hostAccess(s, id, url) || env.hasActiveTab(s, id, contents.id) || url.startsWith(`chrome-extension://${id}/`);
  };

  function tabObject(s: Session, id: string, contents: WebContents) {
    const workspaceId = env.workspaceOf(contents.session) ?? "";
    const list = env.tabs(workspaceId);
    const index = list.indexOf(contents.id);
    const active = env.active(workspaceId) === contents.id;
    const bounds = env.window()?.getContentBounds();
    const tab: Record<string, unknown> = {
      id: contents.id,
      index: index === -1 ? list.length : index,
      windowId: windowId(),
      active,
      highlighted: active,
      selected: active,
      pinned: false,
      audible: contents.isCurrentlyAudible(),
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      mutedInfo: { muted: contents.isAudioMuted() },
      incognito: false,
      status: contents.isLoading() ? "loading" : "complete",
      groupId: -1,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
      lastAccessed: Date.now(),
    };
    if (canSee(s, id, contents)) {
      tab.url = contents.getURL();
      tab.title = contents.getTitle();
      const icon = favicons.get(contents.id);
      if (icon) tab.favIconUrl = icon;
    }
    return tab;
  }

  const tabsIn = (s: Session) => {
    const workspaceId = env.workspaceOf(s);
    if (!workspaceId) return [];
    return env
      .tabs(workspaceId)
      .map((tabId) => webContents.fromId(tabId))
      .filter((c): c is WebContents => !!c && !c.isDestroyed() && c.session === s);
  };

  const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

  function query(s: Session, id: string, q: Record<string, unknown>) {
    let list = tabsIn(s).map((c) => tabObject(s, id, c));
    if (q.currentWindow === false || q.lastFocusedWindow === false || q.windowId === -1) return [];
    if (typeof q.active === "boolean") list = list.filter((t) => t.active === q.active);
    if (typeof q.highlighted === "boolean") list = list.filter((t) => t.highlighted === q.highlighted);
    if (typeof q.audible === "boolean") list = list.filter((t) => t.audible === q.audible);
    if (typeof q.muted === "boolean") list = list.filter((t) => (t.mutedInfo as { muted: boolean }).muted === q.muted);
    if (q.pinned === true || q.discarded === true || q.frozen === true || q.autoDiscardable === false) return [];
    if (typeof q.status === "string") list = list.filter((t) => t.status === q.status);
    if (typeof q.index === "number") list = list.filter((t) => t.index === q.index);
    if (typeof q.groupId === "number") list = list.filter((t) => t.groupId === q.groupId);
    if (typeof q.windowType === "string" && q.windowType !== "normal") return [];
    if (typeof q.title === "string") {
      const re = glob(q.title);
      list = list.filter((t) => typeof t.title === "string" && re.test(t.title));
    }
    if (q.url !== undefined) {
      const patterns = (Array.isArray(q.url) ? q.url : [q.url]).filter((p): p is string => typeof p === "string");
      const matchers = patterns.map((p) => matchPattern(p));
      if (matchers.some((m) => !m)) throw err(`Invalid url pattern '${patterns.find((_, i) => !matchers[i])}'`);
      list = list.filter((t) => typeof t.url === "string" && matchers.some((m) => m!(t.url as string)));
    }
    return list;
  }

  /** A URL an extension may open: the web, or its own pages (relative to its root). */
  function openableUrl(id: string, url: unknown) {
    if (url === undefined || url === null || url === "" || url === "chrome://newtab/" || url === "chrome://newtab") return "";
    if (typeof url !== "string") throw err("Invalid url");
    const resolved = new URL(url, `chrome-extension://${id}/`).href;
    if (/^https?:/i.test(resolved) || resolved === "about:blank" || resolved.startsWith(`chrome-extension://${id}/`)) return resolved;
    throw err(`Cannot navigate to ${url}`);
  }

  async function waitForContents(tabId: number | null) {
    if (tabId === null) return null;
    for (let i = 0; i < 50; i++) {
      const c = webContents.fromId(tabId);
      if (c && !c.isDestroyed()) return c;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async function openTab(s: Session, id: string, url: string, active: boolean) {
    const workspaceId = env.workspaceOf(s);
    if (!workspaceId) throw err("No window");
    const tabId = await env.requestTab({ action: "open", workspaceId, url, active });
    const contents = await waitForContents(tabId);
    if (!contents) throw err("Couldn't open the tab");
    return tabObject(s, id, contents);
  }

  function windowObject(s: Session, id: string, populate: boolean) {
    const win = env.window();
    const b = win?.getBounds();
    return {
      id: windowId(),
      focused: win?.isFocused() ?? false,
      top: b?.y ?? 0,
      left: b?.x ?? 0,
      width: b?.width ?? 0,
      height: b?.height ?? 0,
      incognito: false,
      type: "normal",
      state: win?.isFullScreen() ? "fullscreen" : win?.isMaximized() ? "maximized" : win?.isMinimized() ? "minimized" : "normal",
      alwaysOnTop: false,
      ...(populate ? { tabs: tabsIn(s).map((c) => tabObject(s, id, c)) } : {}),
    };
  }

  // --- Toolbar button ---------------------------------------------------------------------------

  function actionValue(s: Session, id: string, key: keyof ActionState, value: unknown): ActionState[keyof ActionState] {
    switch (key) {
      case "title":
      case "badge":
        return String(value ?? "");
      case "badgeColor": {
        const c = parseColor(value);
        if (!c) throw err("Invalid color");
        return c;
      }
      case "badgeTextColor": {
        if (value == null) return null;
        const c = parseColor(value);
        if (!c) throw err("Invalid color");
        return c;
      }
      case "popup": {
        if (!value) return "";
        const url = String(value);
        if (!url.startsWith(`chrome-extension://${id}/`)) throw err("The popup has to be a page of the extension");
        return url;
      }
      case "icon": {
        if (typeof value !== "string" || !value) return null;
        if (value.startsWith("data:image/")) return value;
        const prefix = `chrome-extension://${id}/`;
        if (!value.startsWith(prefix)) throw err("Invalid icon");
        const dir = s.extensions.getExtension(id)?.path;
        const icon = dir ? imageDataUrl(dir, decodeURIComponent(new URL(value).pathname)) : null;
        if (!icon) throw err("Could not load action icon");
        return icon;
      }
      case "enabled":
        return value !== false;
    }
  }

  // --- Context menus ----------------------------------------------------------------------------

  const MENU_KEYS: (keyof MenuItem)[] = ["id", "parentId", "title", "type", "checked", "enabled", "visible", "contexts", "documentUrlPatterns", "targetUrlPatterns"];
  const cleanMenu = (props: Record<string, unknown>) => {
    const item: Record<string, unknown> = {};
    for (const k of MENU_KEYS) if (props[k] !== undefined) item[k] = props[k];
    return item as Partial<MenuItem>;
  };

  // --- The calls ----------------------------------------------------------------------------------

  type Handler = (ctx: Context, ...args: any[]) => unknown;

  const handlers: Record<string, Handler> = {
    hello: () => ({}),
    listen: (ctx, name: string) => {
      if (typeof name !== "string") return;
      env.contexts.listened(ctx, name);
      const state = env.state(ctx.session, ctx.extensionId);
      if (!ctx.worker || !state) return;
      state.backgroundEvents.add(name);
      // The emulated runtime.onInstalled / onStartup, once its worker listens: the answer fires it.
      if (state.lifecycle?.event === name) {
        const { details } = state.lifecycle;
        state.lifecycle = null;
        return { fire: details ? [details] : [] };
      }
    },
    unlisten: (ctx, name: string) => void ctx.events.delete(name),
    unsupported: (_ctx, name: string) => {
      throw err(`${name} isn't supported in NathApp`);
    },

    // chrome.action
    "action.set": (ctx, tabId: number | null, key: keyof ActionState, value: unknown) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state || !(key in state.action)) throw err("Unknown property");
      const v = actionValue(ctx.session, ctx.extensionId, key, value);
      if (tabId === null) (state.action as unknown as Record<string, unknown>)[key] = v;
      else {
        tabContents(ctx.session, tabId);
        state.tabActions.set(tabId, { ...state.tabActions.get(tabId), [key]: v });
      }
      env.actionsChanged(ctx.session);
    },
    "action.get": (ctx, tabId: number | null, key: keyof ActionState) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state) throw err("Unknown extension");
      if (tabId !== null) tabContents(ctx.session, tabId);
      return state.actionFor(tabId)[key];
    },
    "action.userSettings": (ctx) => ({ isOnToolbar: entryOf(ctx.extensionId)?.pinned ?? false }),
    "action.openPopup": (ctx) => {
      if (!env.openPopup(ctx.session, ctx.extensionId)) throw err("Failed to open popup.");
    },

    // chrome.tabs
    "tabs.get": (ctx, tabId: number) => tabObject(ctx.session, ctx.extensionId, tabContents(ctx.session, tabId)),
    "tabs.getCurrent": (ctx) => {
      const c = ctx.contents;
      if (!c || !ctx.frame || ctx.frame.parent) return undefined;
      const workspaceId = env.workspaceOf(ctx.session);
      return workspaceId && env.tabs(workspaceId).includes(c.id) ? tabObject(ctx.session, ctx.extensionId, c) : undefined;
    },
    "tabs.query": (ctx, q: Record<string, unknown>) => query(ctx.session, ctx.extensionId, q ?? {}),
    "tabs.create": (ctx, props: { url?: string; active?: boolean; selected?: boolean }) =>
      openTab(ctx.session, ctx.extensionId, openableUrl(ctx.extensionId, props?.url), props?.active ?? props?.selected ?? true),
    "tabs.update": async (ctx, tabId: number | null, props: { url?: string; active?: boolean; highlighted?: boolean; selected?: boolean; muted?: boolean }) => {
      const contents = tabId === null ? activeContents(ctx.session) : tabContents(ctx.session, tabId);
      if (!contents) throw err("No active tab");
      if (props.url !== undefined) {
        const url = openableUrl(ctx.extensionId, props.url);
        if (url) void contents.loadURL(url).catch(() => {});
      }
      if (typeof props.muted === "boolean") contents.setAudioMuted(props.muted);
      if (props.active || props.highlighted || props.selected) {
        await env.requestTab({ action: "select", workspaceId: env.workspaceOf(ctx.session) ?? "", tabId: contents.id });
      }
      return tabObject(ctx.session, ctx.extensionId, contents);
    },
    "tabs.remove": async (ctx, ids: number[]) => {
      for (const tabId of ids) tabContents(ctx.session, tabId);
      for (const tabId of ids) await env.requestTab({ action: "close", workspaceId: env.workspaceOf(ctx.session) ?? "", tabId });
    },
    "tabs.reload": (ctx, tabId: number | null, props: { bypassCache?: boolean }) => {
      const contents = tabId === null ? activeContents(ctx.session) : tabContents(ctx.session, tabId);
      if (!contents) throw err("No active tab");
      if (props?.bypassCache) contents.reloadIgnoringCache();
      else contents.reload();
    },
    "tabs.duplicate": (ctx, tabId: number) => openTab(ctx.session, ctx.extensionId, tabContents(ctx.session, tabId).getURL(), true),
    "tabs.highlight": async (ctx, info: { tabs: number | number[] }) => {
      const first = Array.isArray(info.tabs) ? info.tabs[0] : info.tabs;
      const contents = tabsIn(ctx.session)[typeof first === "number" ? first : -1];
      if (!contents) throw err(`No tab at index: ${first}.`);
      await env.requestTab({ action: "select", workspaceId: env.workspaceOf(ctx.session) ?? "", tabId: contents.id });
      return windowObject(ctx.session, ctx.extensionId, true);
    },
    "tabs.move": (ctx, ids: number[]) => {
      const list = ids.map((tabId) => tabObject(ctx.session, ctx.extensionId, tabContents(ctx.session, tabId)));
      return list.length === 1 ? list[0] : list;
    },
    "tabs.goBack": (ctx, tabId: number | null) => {
      const contents = tabId === null ? activeContents(ctx.session) : tabContents(ctx.session, tabId);
      if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    },
    "tabs.goForward": (ctx, tabId: number | null) => {
      const contents = tabId === null ? activeContents(ctx.session) : tabContents(ctx.session, tabId);
      if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    },
    "tabs.captureVisibleTab": async (ctx, options: { format?: string; quality?: number }) => {
      const contents = activeContents(ctx.session);
      if (!contents) throw err("No active tab");
      if (!env.hasActiveTab(ctx.session, ctx.extensionId, contents.id) && !hostAccess(ctx.session, ctx.extensionId, contents.getURL())) {
        throw err("Either the '<all_urls>' or 'activeTab' permission is required.");
      }
      const image = await contents.capturePage();
      if (options?.format === "png") return image.toDataURL();
      return `data:image/jpeg;base64,${image.toJPEG(Math.max(0, Math.min(100, options?.quality ?? 92))).toString("base64")}`;
    },

    // chrome.windows
    "windows.get": (ctx, _id: number, opts: { populate?: boolean }) => windowObject(ctx.session, ctx.extensionId, opts?.populate === true),
    "windows.getAll": (ctx, opts: { populate?: boolean }) => [windowObject(ctx.session, ctx.extensionId, opts?.populate === true)],
    "windows.create": async (ctx, data: { url?: string | string[]; focused?: boolean; tabId?: number }) => {
      const urls = data?.url === undefined ? [""] : Array.isArray(data.url) ? data.url : [data.url];
      for (const [i, url] of urls.entries()) await openTab(ctx.session, ctx.extensionId, openableUrl(ctx.extensionId, url), i === 0);
      return windowObject(ctx.session, ctx.extensionId, true);
    },

    // chrome.commands
    "commands.getAll": (ctx) => env.commandsOf(ctx.extensionId),

    // chrome.contextMenus
    "menus.create": (ctx, props: Record<string, unknown>) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state) throw err("Unknown extension");
      const item = cleanMenu(props) as MenuItem;
      if (state.menus.some((m) => m.id === item.id)) throw err(`Cannot create item with duplicate id ${item.id}`);
      if (item.parentId !== undefined && !state.menus.some((m) => m.id === item.parentId)) throw err(`Cannot find menu item with id ${item.parentId}`);
      state.menus.push(item);
      state.save();
    },
    "menus.update": (ctx, id: string | number, props: Record<string, unknown>) => {
      const state = env.state(ctx.session, ctx.extensionId);
      const item = state?.menus.find((m) => m.id === id);
      if (!state || !item) throw err(`Cannot find menu item with id ${id}`);
      const { id: _ignored, ...change } = cleanMenu(props);
      Object.assign(item, change);
      state.save();
    },
    "menus.remove": (ctx, id: string | number) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state || !state.menus.some((m) => m.id === id)) throw err(`Cannot find menu item with id ${id}`);
      const gone = new Set<string | number>([id]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const m of state.menus) {
          if (m.parentId !== undefined && gone.has(m.parentId) && !gone.has(m.id)) {
            gone.add(m.id);
            changed = true;
          }
        }
      }
      state.menus = state.menus.filter((m) => !gone.has(m.id));
      state.save();
    },
    "menus.removeAll": (ctx) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state) return;
      state.menus = [];
      state.save();
    },

    // chrome.permissions
    "permissions.contains": (ctx, p: { permissions?: string[]; origins?: string[] }) => contains(ctx.session, ctx.extensionId, p),
    "permissions.getAll": (ctx) => allPermissions(ctx.session, ctx.extensionId),
    "permissions.request": async (ctx, p: { permissions?: string[]; origins?: string[] }) => {
      const s = ctx.session;
      const id = ctx.extensionId;
      if (contains(s, id, p)) return true;
      const m = manifestOf(s, id);
      const optional = (m.optional_permissions ?? []).filter((x): x is string => typeof x === "string");
      const optionalHosts = [...(m.optional_host_permissions ?? []), ...optional].filter((x): x is string => typeof x === "string" && (x === "<all_urls>" || x.includes("://")));
      const all = allPermissions(s, id);
      const permissions = (p.permissions ?? []).filter((x) => !all.permissions.includes(x));
      const origins = (p.origins ?? []).filter((o) => !covers(all.origins, o));
      if (permissions.some((x) => !optional.includes(x)) || origins.some((o) => !covers(optionalHosts, o))) {
        throw err("Only permissions specified in the manifest may be requested.");
      }
      if (!(await env.requestPermission(s, id, permissions, origins))) return false;
      const g = granted(id);
      env.registry.update(id, { granted: { permissions: [...new Set([...g.permissions, ...permissions])], origins: [...new Set([...g.origins, ...origins])] } });
      for (const session of env.sessions()) void dispatch(env.contexts, env.state(session, id), session, id, "permissions.onAdded", [{ permissions, origins }]);
      return true;
    },
    "permissions.remove": (ctx, p: { permissions?: string[]; origins?: string[] }) => {
      const id = ctx.extensionId;
      const r = required(ctx.session, id);
      if ((p.permissions ?? []).some((x) => r.permissions.includes(x)) || (p.origins ?? []).some((o) => r.origins.includes(o))) {
        throw err("You cannot remove required permissions.");
      }
      const g = granted(id);
      env.registry.update(id, {
        granted: { permissions: g.permissions.filter((x) => !(p.permissions ?? []).includes(x)), origins: g.origins.filter((o) => !(p.origins ?? []).includes(o)) },
      });
      for (const session of env.sessions()) void dispatch(env.contexts, env.state(session, id), session, id, "permissions.onRemoved", [{ permissions: p.permissions ?? [], origins: p.origins ?? [] }]);
      return true;
    },

    // chrome.storage.sync
    "sync.get": (ctx, keys: unknown) => {
      const data = sync.data(ctx.extensionId);
      const copy = (v: unknown) => (v === undefined ? undefined : structuredClone(v));
      if (keys === null) return structuredClone(data);
      if (typeof keys === "string") return keys in data ? { [keys]: copy(data[keys]) } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => typeof k === "string" && k in data).map((k) => [k, copy(data[k])]));
      if (keys && typeof keys === "object") return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? copy(data[k]) : d]));
      return {};
    },
    "sync.keys": (ctx) => Object.keys(sync.data(ctx.extensionId)),
    "sync.set": (ctx, items: Record<string, unknown>) => {
      const id = ctx.extensionId;
      const data = sync.data(id);
      const next = { ...data, ...items };
      for (const [k, v] of Object.entries(items)) if (itemSize(k, v) > SYNC_ITEM_QUOTA) throw err("QUOTA_BYTES_PER_ITEM quota exceeded");
      if (Object.keys(next).length > SYNC_MAX_ITEMS) throw err("MAX_ITEMS quota exceeded");
      if (Object.entries(next).reduce((n, [k, v]) => n + itemSize(k, v), 0) > SYNC_QUOTA) throw err("QUOTA_BYTES quota exceeded");
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        if (JSON.stringify(data[k]) === JSON.stringify(v)) continue;
        changes[k] = { ...(k in data ? { oldValue: data[k] } : {}), newValue: v };
        data[k] = v;
      }
      sync.save(id);
      syncChanged(id, changes);
    },
    "sync.remove": (ctx, keys: string[]) => {
      const id = ctx.extensionId;
      const data = sync.data(id);
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const k of keys) {
        if (!(k in data)) continue;
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      sync.save(id);
      syncChanged(id, changes);
    },
    "sync.clear": (ctx) => {
      const id = ctx.extensionId;
      const data = sync.data(id);
      const changes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { oldValue: v }]));
      for (const k of Object.keys(data)) delete data[k];
      sync.save(id);
      syncChanged(id, changes);
    },
    "sync.bytes": (ctx, keys: unknown) => {
      const data = sync.data(ctx.extensionId);
      const names = keys === null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      return names.filter((k) => k in data).reduce((n, k) => n + itemSize(k, data[k]), 0);
    },

    // chrome.webNavigation
    "nav.getFrame": (ctx, d: { tabId: number; frameId: number }) => {
      const contents = tabContents(ctx.session, d?.tabId);
      const frame = frameOf(contents, d.frameId);
      return frame ? frameDetails(frame) : null;
    },
    "nav.getAllFrames": (ctx, d: { tabId: number }) => tabContents(ctx.session, d?.tabId).mainFrame.framesInSubtree.map(frameDetails),

    // chrome.cookies
    "cookies.get": async (ctx, d: { url: string; name: string }) => {
      if (!hostAccess(ctx.session, ctx.extensionId, d.url)) throw err(`No host permissions for cookies at url: "${d.url}".`);
      const list = await ctx.session.cookies.get({ url: d.url, name: d.name });
      return list[0] ? cookieObject(list[0]) : null;
    },
    "cookies.getAll": async (ctx, d: { url?: string; name?: string; domain?: string; path?: string; secure?: boolean; session?: boolean }) => {
      const filter: Electron.CookiesGetFilter = {};
      if (d.url) filter.url = d.url;
      if (d.name) filter.name = d.name;
      if (d.domain) filter.domain = d.domain;
      if (d.path) filter.path = d.path;
      if (typeof d.secure === "boolean") filter.secure = d.secure;
      if (typeof d.session === "boolean") filter.session = d.session;
      const list = await ctx.session.cookies.get(filter);
      return list.filter((c) => hostAccess(ctx.session, ctx.extensionId, cookieUrl(c))).map(cookieObject);
    },
    "cookies.set": async (ctx, d: Electron.CookiesSetDetails) => {
      if (!hostAccess(ctx.session, ctx.extensionId, d.url)) throw err(`No host permissions for cookies at url: "${d.url}".`);
      await ctx.session.cookies.set(d);
      const list = await ctx.session.cookies.get({ url: d.url, name: d.name ?? "" });
      return list[0] ? cookieObject(list[0]) : null;
    },
    "cookies.remove": async (ctx, d: { url: string; name: string }) => {
      if (!hostAccess(ctx.session, ctx.extensionId, d.url)) throw err(`No host permissions for cookies at url: "${d.url}".`);
      await ctx.session.cookies.remove(d.url, d.name);
      return { url: d.url, name: d.name, storeId: "0" };
    },
    "cookies.stores": (ctx) => [{ id: "0", tabIds: tabsIn(ctx.session).map((c) => c.id) }],

    // chrome.notifications
    "notifications.create": (ctx, id: string, o: NotificationOptions) => {
      const notificationId = id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      showNotification(ctx, notificationId, o);
      return notificationId;
    },
    "notifications.update": (ctx, id: string, o: NotificationOptions) => {
      if (!notifications.has(`${ctx.extensionId}:${id}`)) return false;
      showNotification(ctx, id, o);
      return true;
    },
    "notifications.clear": (ctx, id: string) => {
      const n = notifications.get(`${ctx.extensionId}:${id}`);
      if (!n) return false;
      notifications.delete(`${ctx.extensionId}:${id}`);
      n.close();
      return true;
    },
    "notifications.getAll": (ctx) =>
      Object.fromEntries([...notifications.keys()].filter((k) => k.startsWith(`${ctx.extensionId}:`)).map((k) => [k.slice(ctx.extensionId.length + 1), true])),

    // chrome.runtime
    "runtime.openOptionsPage": async (ctx) => {
      const page = optionsPageOf(manifestOf(ctx.session, ctx.extensionId));
      if (!page) throw err("Could not create an options page.");
      const url = `chrome-extension://${ctx.extensionId}/${page.replace(/^\/+/, "")}`;
      const open = tabsIn(ctx.session).find((c) => c.getURL().split("#")[0] === url);
      const workspaceId = env.workspaceOf(ctx.session) ?? "";
      if (open) await env.requestTab({ action: "select", workspaceId, tabId: open.id });
      else await env.requestTab({ action: "open", workspaceId, url, active: true });
    },
    "runtime.reload": (ctx) => env.reload(ctx.session, ctx.extensionId),
    "native.send": (ctx, application: string, message: unknown) => {
      if (!hasPermission(ctx.session, ctx.extensionId, "nativeMessaging")) throw err("Access to native messaging requires the 'nativeMessaging' permission.");
      return sendNativeMessage(String(application), ctx.extensionId, message);
    },
    "native.connect": (ctx, portId: string, application: string) => {
      const key = `${ctx.key}|${portId}`;
      if (!hasPermission(ctx.session, ctx.extensionId, "nativeMessaging")) {
        setTimeout(() => ctx.send("native.disconnect", [portId, "Access to native messaging requires the 'nativeMessaging' permission."]), 0);
        return;
      }
      const port = connectNative(
        String(application),
        ctx.extensionId,
        (message) => (ctx.alive() ? ctx.send("native.message", [portId, message]) : port.close()),
        (error) => {
          nativePorts.delete(key);
          if (ctx.alive()) ctx.send("native.disconnect", [portId, error]);
        },
      );
      nativePorts.set(key, port);
      if (ctx.worker) keepWorker(ctx);
    },
    "native.post": (ctx, portId: string, message: unknown) => {
      nativePorts.get(`${ctx.key}|${portId}`)?.post(message);
      if (ctx.worker) keepWorker(ctx);
    },
    "native.disconnect": (ctx, portId: string) => {
      const key = `${ctx.key}|${portId}`;
      nativePorts.get(key)?.close();
      nativePorts.delete(key);
    },

    // The rest
    "idle.queryState": (_ctx, seconds: number) => powerMonitor.getSystemIdleState(Math.max(15, Number(seconds) || 60)),
    "management.getSelf": (ctx) => managementInfo(ctx.session, ctx.extensionId),
    "management.get": (ctx, id: string) => {
      if (!ctx.session.extensions.getExtension(id)) throw err(`Failed to find extension with id ${id}.`);
      return managementInfo(ctx.session, id);
    },
    "management.getAll": (ctx) => ctx.session.extensions.getAllExtensions().filter((e) => env.registry.get(e.id)).map((e) => managementInfo(ctx.session, e.id)),
    "dnr.shouldReset": async (ctx) => {
      // Rulesets can only be changed once the extension finished loading.
      await env.whenLoaded(ctx.session, ctx.extensionId);
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state?.resetRulesets) return false;
      state.resetRulesets = false;
      return true;
    },
    "rules.get": (ctx) => env.rules(ctx.session),
    "rules.applied": () => undefined,
  };

  /** A worker with an open native port stays up (Chrome keeps it alive while connected). */
  function keepWorker(ctx: Context) {
    if (ctx.worker) keepAlive(ctx.worker);
  }

  function syncChanged(id: string, changes: Record<string, unknown>) {
    if (!Object.keys(changes).length) return;
    for (const s of env.sessions()) void dispatch(env.contexts, env.state(s, id), s, id, "storage.sync.onChanged", [changes]);
  }

  function managementInfo(s: Session, id: string) {
    const ext = s.extensions.getExtension(id);
    const m = (ext?.manifest ?? {}) as Manifest;
    const entry = entryOf(id);
    let name = ext?.name ?? id;
    let description = "";
    try {
      if (ext) ({ name, description } = readManifest(ext.path));
    } catch {
      // keep Electron's
    }
    const options = optionsPageOf(m);
    return {
      id,
      name,
      shortName: name,
      description,
      version: ext?.version ?? "",
      mayDisable: true,
      enabled: true,
      installType: entry?.source.kind === "unpacked" ? "development" : "normal",
      type: "extension",
      offlineEnabled: false,
      optionsUrl: options ? `chrome-extension://${id}/${options.replace(/^\/+/, "")}` : "",
      permissions: permissionsOf(m),
      hostPermissions: hostPermissionsOf(m),
      icons: Object.entries(m.icons ?? {}).map(([size, path]) => ({ size: Number(size), url: `chrome-extension://${id}/${String(path).replace(/^\/+/, "")}` })),
      updateUrl: m.update_url,
    };
  }

  interface NotificationOptions {
    title?: string;
    message?: string;
    contextMessage?: string;
    iconUrl?: string;
    silent?: boolean;
    requireInteraction?: boolean;
  }

  function showNotification(ctx: Context, id: string, o: NotificationOptions) {
    if (!Notification.isSupported()) return;
    const key = `${ctx.extensionId}:${id}`;
    const old = notifications.get(key);
    const dir = ctx.session.extensions.getExtension(ctx.extensionId)?.path;
    let icon: Electron.NativeImage | undefined;
    if (o.iconUrl?.startsWith("data:")) icon = nativeImage.createFromDataURL(o.iconUrl);
    else if (dir && o.iconUrl?.startsWith(`chrome-extension://${ctx.extensionId}/`)) {
      const file = extensionFile(dir, decodeURIComponent(new URL(o.iconUrl).pathname));
      if (file) icon = nativeImage.createFromPath(file);
    }
    const n = new Notification({
      title: o.title ?? "",
      body: [o.message, o.contextMessage].filter(Boolean).join("\n"),
      ...(icon && !icon.isEmpty() ? { icon } : {}),
      silent: o.silent === true,
      ...(o.requireInteraction ? { timeoutType: "never" as const } : {}),
    });
    const s = ctx.session;
    const extId = ctx.extensionId;
    n.on("click", () => void dispatch(env.contexts, env.state(s, extId), s, extId, "notifications.onClicked", [id]));
    n.on("close", () => {
      if (notifications.get(key) !== n) return;
      notifications.delete(key);
      void dispatch(env.contexts, env.state(s, extId), s, extId, "notifications.onClosed", [id, true]);
    });
    notifications.set(key, n);
    old?.close();
    n.show();
  }

  async function handle(ctx: Context, method: string, args: unknown[]) {
    const handler = handlers[method];
    if (!handler) return { error: `${method} isn't supported in NathApp` };
    try {
      return { value: await handler(ctx, ...(Array.isArray(args) ? args : [])) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --- Events from web tabs ---------------------------------------------------------------------------

  /** Every extension (but NathApp's own) in a session that some context listens to `event` for. */
  function* listeners(s: Session, event: string) {
    const ids = new Set<string>();
    for (const ctx of env.contexts.inSession(s)) if (ctx.events.has(event)) ids.add(ctx.extensionId);
    for (const ext of s.extensions.getAllExtensions()) if (env.state(s, ext.id)?.backgroundEvents.has(event)) ids.add(ext.id);
    for (const id of ids) yield id;
  }

  const emit = (s: Session, event: string, args: (id: string) => unknown[] | null) => {
    for (const id of listeners(s, event)) {
      const a = args(id);
      if (a) void dispatch(env.contexts, env.state(s, id), s, id, event, a);
    }
  };

  const frameIdOf = (frame: WebFrameMain | null | undefined) => (!frame || !frame.parent ? 0 : frame.frameTreeNodeId);
  const frameOf = (contents: WebContents, frameId: number) => (frameId === 0 ? contents.mainFrame : contents.mainFrame.framesInSubtree.find((f) => f.frameTreeNodeId === frameId));
  const frameDetails = (frame: WebFrameMain) => ({
    frameId: frameIdOf(frame),
    parentFrameId: frame.parent ? frameIdOf(frame.parent) : -1,
    url: frame.url,
    errorOccurred: false,
    processId: frame.processId,
    frameType: frame.parent ? "sub_frame" : "outermost_frame",
    documentLifecycle: "active",
  });

  /** Follows a web tab for chrome.tabs and chrome.webNavigation events. */
  function trackGuest(contents: WebContents) {
    const s = contents.session;
    const tabId = contents.id;
    const updated = (change: Record<string, unknown>, visible: boolean) =>
      emit(s, "tabs.onUpdated", (id) => {
        const see = canSee(s, id, contents);
        if (visible && !see) return null;
        return [tabId, change, tabObject(s, id, contents)];
      });
    const nav = (event: string, details: (id: string) => Record<string, unknown>) =>
      emit(s, `webNavigation.${event}`, (id) => (hasPermission(s, id, "webNavigation") ? [{ tabId, timeStamp: Date.now(), ...details(id) }] : null));
    const frameFrom = (processId: number, routingId: number) => webFrameMain.fromId(processId, routingId) ?? null;
    const lastUrl = new Map<number, string>();

    contents.on("did-start-loading", () => updated({ status: "loading" }, false));
    contents.on("did-stop-loading", () => updated({ status: "complete" }, false));
    contents.on("page-title-updated", (_e, title) => updated({ title }, true));
    contents.on("page-favicon-updated", (_e, icons) => {
      if (!icons[0]) return;
      favicons.set(tabId, icons[0]);
      updated({ favIconUrl: icons[0] }, true);
    });
    contents.on("audio-state-changed", (e) => updated({ audible: e.audible }, false));
    contents.on("did-navigate", (_e, url) => {
      // Values set for one page don't carry over to the next (like Chrome).
      for (const ext of s.extensions.getAllExtensions()) {
        const state = env.state(s, ext.id);
        if (state?.tabActions.delete(tabId)) env.actionsChanged(s);
      }
      updated({ url }, true);
    });
    contents.on("did-navigate-in-page", (_e, url, isMainFrame, processId, routingId) => {
      if (isMainFrame) updated({ url }, true);
      const frame = frameFrom(processId, routingId);
      const frameId = frameIdOf(frame);
      const before = lastUrl.get(frameId);
      lastUrl.set(frameId, url);
      const fragmentOnly = before !== undefined && before.split("#")[0] === url.split("#")[0];
      nav(fragmentOnly ? "onReferenceFragmentUpdated" : "onHistoryStateUpdated", () => ({ frameId, url, processId, transitionType: "link", transitionQualifiers: [] }));
    });
    contents.on("did-start-navigation", (details) => {
      if (details.isSameDocument) return;
      const frameId = frameIdOf(details.frame);
      nav("onBeforeNavigate", () => ({ frameId, parentFrameId: details.frame?.parent ? frameIdOf(details.frame.parent) : -1, url: details.url, processId: -1, frameType: details.isMainFrame ? "outermost_frame" : "sub_frame", documentLifecycle: "active" }));
    });
    contents.on("did-frame-navigate", (_e, url, _code, _text, _main, processId, routingId) => {
      const frameId = frameIdOf(frameFrom(processId, routingId));
      lastUrl.set(frameId, url);
      nav("onCommitted", () => ({ frameId, url, processId, transitionType: "link", transitionQualifiers: [] }));
    });
    contents.on("dom-ready", () => nav("onDOMContentLoaded", () => ({ frameId: 0, url: contents.getURL(), processId: contents.mainFrame.processId })));
    contents.on("did-frame-finish-load", (_e, isMainFrame, processId, routingId) => {
      const frame = frameFrom(processId, routingId);
      const frameId = frameIdOf(frame);
      const url = frame?.url ?? contents.getURL();
      if (!isMainFrame) nav("onDOMContentLoaded", () => ({ frameId, url, processId }));
      nav("onCompleted", () => ({ frameId, url, processId }));
    });
    contents.on("did-fail-load", (_e, code, description, url, _main, processId, routingId) => {
      const frameId = frameIdOf(frameFrom(processId, routingId));
      nav("onErrorOccurred", () => ({ frameId, url, processId, error: `net::${description || code}` }));
    });
    contents.once("destroyed", () => favicons.delete(tabId));
  }

  /** The tabs list changed: created, removed and activated events. */
  function tabsChanged(s: Session, before: { tabs: number[]; active: number | null }, after: { tabs: number[]; active: number | null }) {
    const win = windowId();
    for (const tabId of after.tabs.filter((t) => !before.tabs.includes(t))) {
      const contents = webContents.fromId(tabId);
      if (contents && !contents.isDestroyed()) emit(s, "tabs.onCreated", (id) => [tabObject(s, id, contents)]);
    }
    for (const tabId of before.tabs.filter((t) => !after.tabs.includes(t))) {
      emit(s, "tabs.onRemoved", () => [tabId, { windowId: win, isWindowClosing: false }]);
      for (const ext of s.extensions.getAllExtensions()) env.state(s, ext.id)?.tabActions.delete(tabId);
    }
    if (after.active !== null && after.active !== before.active) {
      emit(s, "tabs.onActivated", () => [{ tabId: after.active, windowId: win }]);
      emit(s, "tabs.onHighlighted", () => [{ tabIds: [after.active], windowId: win }]);
      emit(s, "tabs.onActiveChanged", () => [after.active, { windowId: win }]);
      emit(s, "tabs.onSelectionChanged", () => [after.active, { windowId: win }]);
    }
  }

  /** Cookie changes for the extensions allowed to see them. */
  function watchCookies(s: Session) {
    const causes: Record<string, string> = { "expired-overwrite": "expired_overwrite", inserted: "explicit", "inserted-no-change-overwrite": "overwrite", "inserted-no-value-change-overwrite": "overwrite" };
    s.cookies.on("changed", (_e, cookie, cause, removed) => {
      const url = cookieUrl(cookie);
      emit(s, "cookies.onChanged", (id) => (hasPermission(s, id, "cookies") && hostAccess(s, id, url) ? [{ removed, cookie: cookieObject(cookie), cause: causes[cause] ?? cause }] : null));
    });
  }

  // --- Context menu items in web tabs ----------------------------------------------------------------

  /** The extensions' items for a context menu in a web tab (or on its toolbar button: "action"). */
  function menuItems(s: Session, contents: WebContents | null, params: Partial<ContextMenuParams> & { pageURL?: string }, only?: string): MenuItemConstructorOptions[] {
    const out: MenuItemConstructorOptions[] = [];
    const contexts = new Set<string>(["all"]);
    if (only) contexts.add("action").add("browser_action").add("page_action");
    else {
      if (params.selectionText) contexts.add("selection");
      if (params.linkURL) contexts.add("link");
      if (params.isEditable) contexts.add("editable");
      if (params.mediaType === "image") contexts.add("image");
      if (params.mediaType === "video") contexts.add("video");
      if (params.mediaType === "audio") contexts.add("audio");
      if (params.frameURL) contexts.add("frame");
      if (contexts.size === 1) contexts.add("page");
    }
    const pageUrl = params.pageURL ?? contents?.getURL() ?? "";
    for (const ext of s.extensions.getAllExtensions()) {
      if (only && ext.id !== only) continue;
      const state = env.state(s, ext.id);
      if (!state?.menus.length) continue;
      const visible = (m: MenuItem) => {
        if (m.visible === false) return false;
        const ctxs = m.contexts ?? ["page"];
        if (!ctxs.some((c) => contexts.has(c))) return false;
        // "all" items show everywhere but on the toolbar button.
        if (only && !ctxs.some((c) => c === "action" || c === "browser_action" || c === "page_action")) return false;
        if (m.documentUrlPatterns?.length && !matchesAny(m.documentUrlPatterns, pageUrl)) return false;
        const target = params.linkURL || params.srcURL;
        if (m.targetUrlPatterns?.length && target && !matchesAny(m.targetUrlPatterns, target)) return false;
        return true;
      };
      const click = (m: MenuItem, checked?: boolean) => {
        const tabId = contents?.id;
        const info: Record<string, unknown> = {
          menuItemId: m.id,
          ...(m.parentId !== undefined ? { parentMenuItemId: m.parentId } : {}),
          editable: params.isEditable ?? false,
          pageUrl,
          frameId: 0,
          ...(params.frameURL ? { frameUrl: params.frameURL } : {}),
          ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
          ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
          ...(params.mediaType && params.mediaType !== "none" ? { mediaType: params.mediaType } : {}),
          ...(params.selectionText ? { selectionText: params.selectionText } : {}),
          ...(m.type === "checkbox" || m.type === "radio" ? { wasChecked: !!m.checked, checked: checked ?? !m.checked } : {}),
        };
        if (m.type === "checkbox") m.checked = !m.checked;
        if (m.type === "radio") {
          for (const other of state.menus) if (other.type === "radio" && other.parentId === m.parentId) other.checked = other.id === m.id;
        }
        if (m.type === "checkbox" || m.type === "radio") state.save();
        env.grantActiveTab(s, ext.id, tabId ?? null);
        const tab = contents && !contents.isDestroyed() ? tabObject(s, ext.id, contents) : undefined;
        void dispatch(env.contexts, state, s, ext.id, "contextMenus.onClicked", [info, tab]);
      };
      const build = (parent: string | number | undefined): MenuItemConstructorOptions[] =>
        state.menus
          .filter((m) => m.parentId === parent && visible(m))
          .map((m): MenuItemConstructorOptions => {
            if (m.type === "separator") return { type: "separator" };
            const children = build(m.id);
            const label = (m.title ?? "").replace(/%s/g, (params.selectionText ?? "").slice(0, 100)).replace(/&/g, "&&");
            if (children.length) return { label, enabled: m.enabled !== false, submenu: children };
            return {
              label,
              enabled: m.enabled !== false,
              ...(m.type === "checkbox" || m.type === "radio" ? { type: m.type, checked: !!m.checked } : {}),
              click: () => click(m),
            };
          });
      const items = build(undefined);
      if (!items.length) continue;
      if (only || items.length === 1) out.push(...items);
      else {
        let name = ext.name;
        try {
          name = readManifest(ext.path).name;
        } catch {
          // Electron's name
        }
        const dir = ext.path;
        const icon = imageDataUrl(dir, iconPath((ext.manifest as Manifest).icons, 16));
        out.push({ label: name.replace(/&/g, "&&"), submenu: items, ...(icon ? { icon: nativeImage.createFromDataURL(icon).resize({ width: 16, height: 16 }) } : {}) });
      }
    }
    return out;
  }

  return { handle, tabObject, trackGuest, tabsChanged, watchCookies, menuItems, forgetSync: (id: string) => sync.forget(id) };
}

const cookieUrl = (c: Electron.Cookie) => `${c.secure ? "https" : "http"}://${(c.domain ?? "").replace(/^\./, "")}${c.path ?? "/"}`;

function cookieObject(c: Electron.Cookie) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? "",
    hostOnly: c.hostOnly ?? false,
    path: c.path ?? "/",
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite,
    session: c.session ?? false,
    ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
    storeId: "0",
  };
}

