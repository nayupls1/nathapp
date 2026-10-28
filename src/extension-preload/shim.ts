// The chrome.* APIs Electron leaves out or only stubs, for extension pages and
// service workers. This function runs in the extension's own world (injected
// by the preload with contextBridge.executeInMainWorld), so it can't use
// anything from outside itself: it gets the bridge to Rune Browser's main process as
// an argument. Calls go to main/extensions/apis.ts; events come back by name.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ShimBridge {
  call: (method: string, args: unknown[]) => Promise<{ value?: unknown; error?: string }>;
  onEvent: (fn: (name: string, args: unknown[]) => void) => void;
}

export interface ShimInfo {
  id: string;
  worker: boolean;
  /** Rune Browser's own network-rules extension. */
  builtin: boolean;
}

export function shim(bridge: ShimBridge, info: ShimInfo) {
  const g: any = globalThis;
  const c: any = g.chrome;
  if (!c?.runtime || g.__runeShim) return;
  g.__runeShim = true;

  const call = (method: string, ...args: unknown[]): Promise<any> =>
    bridge.call(method, args).then((r) => {
      if (r && r.error !== undefined) throw new Error(r.error);
      return r ? r.value : undefined;
    });

  /** Runs a callback with chrome.runtime.lastError set, like Chrome does when a call fails. */
  const withLastError = (message: string, fn: () => void) => {
    try {
      Object.defineProperty(c.runtime, "lastError", { value: { message }, configurable: true, enumerable: true });
    } catch {
      // keep going without it
    }
    try {
      fn();
    } finally {
      try {
        delete c.runtime.lastError;
      } catch {
        // ignore
      }
    }
  };

  /** An API function: promise style, or with a callback as the last argument. */
  const api =
    (method: string, prepare?: (args: any[]) => any[] | Promise<any[]>, after?: (value: any) => any) =>
    (...args: any[]) => {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      const p = Promise.resolve(prepare ? prepare(args) : args)
        .then((a) => call(method, ...a))
        .then((v) => (after ? after(v) : v));
      if (!cb) return p;
      p.then(
        (v) => cb(v),
        (e) => withLastError(e?.message ?? String(e), () => cb()),
      );
      return undefined;
    };

  /** An API function that just answers. */
  const resolved =
    <T>(value: T) =>
    (...args: any[]) => {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      if (!cb) return Promise.resolve(value);
      queueMicrotask(() => cb(value));
      return undefined;
    };

  // --- Events ------------------------------------------------------------------------

  const events = new Map<string, Ev>();
  const internal = new Map<string, (args: any[]) => void>();

  class Ev {
    private listeners: { fn: (...args: any[]) => any; filter?: any }[] = [];
    constructor(
      private name: string,
      private matches?: (filter: any, args: any[]) => boolean,
    ) {}
    addListener(fn: (...args: any[]) => any, filter?: any) {
      if (typeof fn !== "function") throw new TypeError("The listener has to be a function");
      if (this.listeners.some((l) => l.fn === fn)) return;
      this.listeners.push({ fn, filter });
      if (this.listeners.length === 1 && this.name) {
        // The answer can carry the event itself (runtime.onInstalled / onStartup).
        void call("listen", this.name).then(
          (r: any) => r?.fire && setTimeout(() => this.dispatch(r.fire), 0),
          () => {},
        );
      }
    }
    removeListener(fn: (...args: any[]) => any) {
      const before = this.listeners.length;
      this.listeners = this.listeners.filter((l) => l.fn !== fn);
      if (before && !this.listeners.length && this.name) void call("unlisten", this.name).catch(() => {});
    }
    hasListener(fn: (...args: any[]) => any) {
      return this.listeners.some((l) => l.fn === fn);
    }
    hasListeners() {
      return this.listeners.length > 0;
    }
    dispatch(args: any[]) {
      for (const l of this.listeners.slice()) {
        if (l.filter && this.matches && !this.matches(l.filter, args)) continue;
        try {
          l.fn(...args);
        } catch (err) {
          console.error(err);
        }
      }
    }
    // Declarative events (not used by these APIs).
    addRules(_rules: unknown, cb?: () => void) {
      cb?.();
    }
    getRules(_ids: unknown, cb?: (rules: unknown[]) => void) {
      (typeof _ids === "function" ? (_ids as any) : cb)?.([]);
    }
    removeRules(_ids: unknown, cb?: () => void) {
      (typeof _ids === "function" ? (_ids as any) : cb)?.();
    }
  }

  const ev = (name: string, matches?: (filter: any, args: any[]) => boolean) => {
    const existing = events.get(name);
    if (existing) return existing;
    const e = new Ev(name, matches);
    events.set(name, e);
    return e;
  };
  /** An event only this context dispatches (ports). */
  const localEv = () => new Ev("");

  bridge.onEvent((name, args) => {
    internal.get(name)?.(args);
    events.get(name)?.dispatch(args);
  });

  // What was changed, to do the same to the `browser` namespace (a separate object in Electron).
  const defined: [any, string, unknown][] = [];
  const define = (target: any, name: string, value: unknown) => {
    defined.push([target, name, value]);
    defineOn(target, name, value);
  };
  const defineOn = (target: any, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: true });
    } catch {
      try {
        target[name] = value;
      } catch {
        // read-only: keep Electron's
      }
    }
  };

  void call("hello").catch(() => {});

  // --- Rune Browser's network rules extension ------------------------------------------------

  if (info.builtin) {
    const dnr = c.declarativeNetRequest;
    let applying = Promise.resolve();
    const apply = () => {
      applying = applying.then(async () => {
        try {
          const rules = (await call("rules.get")) ?? [];
          const existing: { id: number }[] = await dnr.getSessionRules();
          await dnr.updateSessionRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
          await call("rules.applied");
        } catch (err) {
          console.error("Rune Browser's network rules:", err);
        }
      });
    };
    internal.set("rules.changed", apply);
    apply();
    return;
  }

  const manifest: any = c.runtime.getManifest?.() ?? {};

  // --- declarativeNetRequest: the manifest's rulesets ---------------------------------------
  // Electron doesn't turn on the rulesets a manifest enables, so that's done
  // here when the extension is installed or updated, before the extension
  // itself looks at them.
  const dnr = c.declarativeNetRequest;
  const resources: { id: string; enabled?: boolean }[] = manifest.declarative_net_request?.rule_resources ?? [];
  if (dnr?.updateEnabledRulesets && resources.length) {
    const update = dnr.updateEnabledRulesets.bind(dnr);
    const enableDefaults = () =>
      update({
        enableRulesetIds: resources.filter((r) => r.enabled).map((r) => r.id),
        disableRulesetIds: resources.filter((r) => !r.enabled).map((r) => r.id),
      });
    const ready: Promise<unknown> = call("dnr.shouldReset")
      .then((reset) => (reset ? enableDefaults() : undefined))
      .catch((err) => console.error("Enabling the extension's rulesets:", err));
    // Never holds the extension up for long.
    const settled = Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    for (const name of ["getEnabledRulesets", "updateEnabledRulesets", "updateStaticRules", "getDisabledRuleIds", "getAvailableStaticRuleCount"]) {
      const original = dnr[name];
      if (typeof original !== "function") continue;
      define(dnr, name, (...args: any[]) => {
        const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
        const p = settled.then(() => original.apply(dnr, args));
        if (!cb) return p;
        p.then(
          (v: unknown) => cb(v),
          (e: any) => withLastError(e?.message ?? String(e), () => cb()),
        );
        return undefined;
      });
    }
  }
  const permissions: string[] = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].filter((p: unknown) => typeof p === "string");
  const has = (p: string) => permissions.includes(p);
  const base = `chrome-extension://${info.id}/`;
  const here = () => {
    try {
      return String(g.location?.href ?? base);
    } catch {
      return base;
    }
  };
  const absolute = (path: string) => new URL(path, here()).href;

  // --- chrome.action (and MV2's browserAction / pageAction) ----------------------------------

  const ICON_SIZE = 32;
  const pickSize = (sizes: string[]) => {
    const n = sizes.map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const best = n.find((x) => x >= ICON_SIZE) ?? n[n.length - 1];
    return best === undefined ? sizes[0] : String(best);
  };

  async function imageDataUrl(image: any): Promise<string> {
    const canvas = new g.OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d").putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(s)}`;
  }

  const isImageData = (x: any) => x && typeof x.width === "number" && typeof x.height === "number" && x.data;

  async function iconOf(details: any): Promise<string | null> {
    if (details.imageData) {
      const img = details.imageData;
      if (isImageData(img)) return imageDataUrl(img);
      const key = pickSize(Object.keys(img));
      return key === undefined ? null : imageDataUrl(img[key]);
    }
    if (details.path) {
      const p = details.path;
      if (typeof p === "string") return absolute(p);
      const key = pickSize(Object.keys(p));
      return key === undefined ? null : absolute(p[key]);
    }
    return null;
  }

  const tabOf = (d: any) => (d && typeof d.tabId === "number" ? d.tabId : null);
  const actionOnClicked = ev("action.onClicked");

  const action = {
    setTitle: api("action.set", ([d]) => [tabOf(d), "title", String(d?.title ?? "")]),
    getTitle: api("action.get", ([d]) => [tabOf(d), "title"]),
    setBadgeText: api("action.set", ([d]) => [tabOf(d), "badge", d?.text == null ? "" : String(d.text)]),
    getBadgeText: api("action.get", ([d]) => [tabOf(d), "badge"]),
    setBadgeBackgroundColor: api("action.set", ([d]) => [tabOf(d), "badgeColor", d?.color]),
    getBadgeBackgroundColor: api("action.get", ([d]) => [tabOf(d), "badgeColor"]),
    setBadgeTextColor: api("action.set", ([d]) => [tabOf(d), "badgeTextColor", d?.color]),
    getBadgeTextColor: api("action.get", ([d]) => [tabOf(d), "badgeTextColor"]),
    setPopup: api("action.set", ([d]) => [tabOf(d), "popup", d?.popup ? absolute(String(d.popup)) : ""]),
    getPopup: api("action.get", ([d]) => [tabOf(d), "popup"]),
    setIcon: api("action.set", async ([d]) => [tabOf(d), "icon", await iconOf(d ?? {})]),
    enable: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", true]),
    disable: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", false]),
    isEnabled: api("action.get", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled"]),
    show: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", true]),
    hide: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", false]),
    getUserSettings: api("action.userSettings"),
    openPopup: api("action.openPopup"),
    onClicked: actionOnClicked,
    onUserSettingsChanged: ev("action.onUserSettingsChanged"),
  };
  if (manifest.action || manifest.manifest_version === 3) define(c, "action", action);
  if (manifest.browser_action) define(c, "browserAction", action);
  if (manifest.page_action) define(c, "pageAction", action);

  // --- chrome.tabs ---------------------------------------------------------------------------

  const nativeTabs: any = c.tabs ?? {};
  const bindNative = (name: string) => (typeof nativeTabs[name] === "function" ? nativeTabs[name].bind(nativeTabs) : api(`tabs.${name}`));
  const tabs = {
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
    get: api("tabs.get"),
    getCurrent: api("tabs.getCurrent"),
    query: api("tabs.query", ([q]) => [q ?? {}]),
    create: api("tabs.create", ([p]) => [p ?? {}]),
    update: api("tabs.update", (args) => (typeof args[0] === "number" ? [args[0], args[1] ?? {}] : [null, args[0] ?? {}])),
    remove: api("tabs.remove", ([ids]) => [Array.isArray(ids) ? ids : [ids]]),
    reload: api("tabs.reload", (args) => (typeof args[0] === "number" ? [args[0], args[1] ?? {}] : [null, args[0] ?? {}])),
    duplicate: api("tabs.duplicate"),
    highlight: api("tabs.highlight", ([i]) => [i ?? {}]),
    move: api("tabs.move", ([ids, props]) => [Array.isArray(ids) ? ids : [ids], props ?? {}]),
    discard: api("tabs.get", ([id]) => [id ?? null]),
    goBack: api("tabs.goBack", ([id]) => [typeof id === "number" ? id : null]),
    goForward: api("tabs.goForward", ([id]) => [typeof id === "number" ? id : null]),
    captureVisibleTab: api("tabs.captureVisibleTab", (args) => (typeof args[0] === "number" || args[0] == null ? [args[1] ?? {}] : [args[0] ?? {}])),
    detectLanguage: resolved("und"),
    group: api("unsupported", () => ["tabs.group"]),
    ungroup: api("unsupported", () => ["tabs.ungroup"]),
    getSelected: api("tabs.query", () => [{ active: true, currentWindow: true }], (list: any[]) => list[0]),
    getAllInWindow: api("tabs.query", ([windowId]) => [typeof windowId === "number" ? { windowId } : { currentWindow: true }]),
    sendMessage: bindNative("sendMessage"),
    connect: bindNative("connect"),
    executeScript: bindNative("executeScript"),
    insertCSS: bindNative("insertCSS"),
    removeCSS: bindNative("removeCSS"),
    setZoom: bindNative("setZoom"),
    getZoom: bindNative("getZoom"),
    setZoomSettings: bindNative("setZoomSettings"),
    getZoomSettings: bindNative("getZoomSettings"),
    onActivated: ev("tabs.onActivated"),
    onActiveChanged: ev("tabs.onActiveChanged"),
    onSelectionChanged: ev("tabs.onSelectionChanged"),
    onHighlighted: ev("tabs.onHighlighted"),
    onHighlightChanged: ev("tabs.onHighlightChanged"),
    onUpdated: ev("tabs.onUpdated"),
    onCreated: ev("tabs.onCreated"),
    onRemoved: ev("tabs.onRemoved"),
    onReplaced: ev("tabs.onReplaced"),
    onMoved: ev("tabs.onMoved"),
    onAttached: ev("tabs.onAttached"),
    onDetached: ev("tabs.onDetached"),
    onZoomChange: nativeTabs.onZoomChange ?? ev("tabs.onZoomChange"),
  };
  define(c, "tabs", tabs);

  // --- chrome.windows ---------------------------------------------------------------------------

  define(c, "windows", {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: api("windows.get", ([id, opts]) => [id, opts ?? {}]),
    getCurrent: api("windows.get", ([opts]) => [-2, opts ?? {}]),
    getLastFocused: api("windows.get", ([opts]) => [-2, opts ?? {}]),
    getAll: api("windows.getAll", ([opts]) => [opts ?? {}]),
    create: api("windows.create", ([data]) => [data ?? {}]),
    update: api("windows.get", ([id]) => [id, {}]),
    remove: resolved(undefined),
    onCreated: ev("windows.onCreated"),
    onRemoved: ev("windows.onRemoved"),
    onFocusChanged: ev("windows.onFocusChanged"),
    onBoundsChanged: ev("windows.onBoundsChanged"),
  });

  // --- chrome.commands ---------------------------------------------------------------------------

  define(c, "commands", { getAll: api("commands.getAll"), onCommand: ev("commands.onCommand"), onChanged: ev("commands.onChanged") });

  // --- chrome.contextMenus / chrome.menus ----------------------------------------------------------

  if (has("contextMenus") || has("menus")) {
    let next = 1;
    const onclicks = new Map<string, (info: any, tab: any) => void>();
    const strip = (props: any) => {
      const { onclick, ...rest } = props ?? {};
      return { rest, onclick: typeof onclick === "function" ? onclick : null };
    };
    const onClicked = ev("contextMenus.onClicked");
    internal.set("contextMenus.onClicked", ([clickInfo, tab]) => {
      const fn = onclicks.get(String(clickInfo?.menuItemId));
      if (fn) {
        try {
          fn(clickInfo, tab);
        } catch (err) {
          console.error(err);
        }
      }
    });
    // A local onclick needs the click delivered here too.
    const watchClicks = () => {
      if (onclicks.size === 1) void call("listen", "contextMenus.onClicked").catch(() => {});
    };
    const menus = {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      create(props: any, cb?: () => void) {
        const { rest, onclick } = strip(props);
        const id = rest.id ?? next++;
        if (onclick) {
          onclicks.set(String(id), onclick);
          watchClicks();
        }
        call("menus.create", { ...rest, id }).then(
          () => cb?.(),
          (e) => (cb ? withLastError(e.message, () => cb()) : console.error(`Unchecked runtime.lastError: ${e.message}`)),
        );
        return id;
      },
      update: api("menus.update", ([id, props]) => {
        const { rest, onclick } = strip(props);
        if (onclick) {
          onclicks.set(String(id), onclick);
          watchClicks();
        }
        return [id, rest];
      }),
      remove: api("menus.remove", ([id]) => {
        onclicks.delete(String(id));
        return [id];
      }),
      removeAll: api("menus.removeAll", () => {
        onclicks.clear();
        return [];
      }),
      refresh: resolved(undefined),
      onClicked,
      onShown: ev("contextMenus.onShown"),
      onHidden: ev("contextMenus.onHidden"),
    };
    define(c, "contextMenus", menus);
    if (has("menus")) define(c, "menus", menus);
  }

  // --- chrome.permissions ------------------------------------------------------------------------

  define(c, "permissions", {
    contains: api("permissions.contains", ([p]) => [p ?? {}]),
    getAll: api("permissions.getAll"),
    request: api("permissions.request", ([p]) => [p ?? {}]),
    remove: api("permissions.remove", ([p]) => [p ?? {}]),
    addHostAccessRequest: resolved(undefined),
    removeHostAccessRequest: resolved(undefined),
    onAdded: ev("permissions.onAdded"),
    onRemoved: ev("permissions.onRemoved"),
  });

  // --- chrome.storage.sync ---------------------------------------------------------------------------

  if (c.storage) {
    const syncChanged = ev("storage.sync.onChanged");
    const sync = {
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
      MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
      get: api("sync.get", ([keys]) => [keys === undefined ? null : keys]),
      getKeys: api("sync.keys"),
      set: api("sync.set", ([items]) => [JSON.parse(JSON.stringify(items ?? {}))]),
      remove: api("sync.remove", ([keys]) => [Array.isArray(keys) ? keys : [keys]]),
      clear: api("sync.clear"),
      getBytesInUse: api("sync.bytes", ([keys]) => [keys === undefined ? null : keys]),
      setAccessLevel: resolved(undefined),
      onChanged: syncChanged,
    };
    define(c.storage, "sync", sync);
    // storage.onChanged covers every area: Electron's (local, session) plus sync.
    const native = c.storage.onChanged;
    if (native) {
      const wrapped = new Map<(...args: any[]) => void, (changes: any) => void>();
      define(c.storage, "onChanged", {
        addListener(fn: (changes: any, area: string) => void) {
          native.addListener(fn);
          if (wrapped.has(fn)) return;
          const w = (changes: any) => fn(changes, "sync");
          wrapped.set(fn, w);
          syncChanged.addListener(w);
        },
        removeListener(fn: (changes: any, area: string) => void) {
          native.removeListener(fn);
          const w = wrapped.get(fn);
          if (w) syncChanged.removeListener(w);
          wrapped.delete(fn);
        },
        hasListener: (fn: (changes: any, area: string) => void) => native.hasListener(fn) || wrapped.has(fn),
        hasListeners: () => native.hasListeners() || wrapped.size > 0,
      });
    }
  }

  // --- chrome.runtime ----------------------------------------------------------------------------------

  define(c.runtime, "onInstalled", ev("runtime.onInstalled"));
  define(c.runtime, "onStartup", ev("runtime.onStartup"));
  if (!c.runtime.onUpdateAvailable) define(c.runtime, "onUpdateAvailable", ev("runtime.onUpdateAvailable"));
  define(c.runtime, "openOptionsPage", api("runtime.openOptionsPage"));
  define(c.runtime, "setUninstallURL", resolved(undefined));
  define(c.runtime, "requestUpdateCheck", resolved({ status: "no_update" }));
  define(c.runtime, "reload", () => void call("runtime.reload"));

  if (has("nativeMessaging")) {
    define(c.runtime, "sendNativeMessage", api("native.send"));
    const ports = new Map<string, { onMessage: Ev; onDisconnect: Ev; port: any; open: boolean }>();
    internal.set("native.message", ([id, message]) => ports.get(id)?.onMessage.dispatch([message, ports.get(id)!.port]));
    internal.set("native.disconnect", ([id, error]) => {
      const p = ports.get(id);
      if (!p) return;
      ports.delete(id);
      p.open = false;
      if (error) withLastError(error, () => p.onDisconnect.dispatch([p.port]));
      else p.onDisconnect.dispatch([p.port]);
    });
    define(c.runtime, "connectNative", (application: string) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const onMessage = localEv();
      const onDisconnect = localEv();
      const port = {
        name: String(application),
        onMessage,
        onDisconnect,
        postMessage(message: unknown) {
          if (!entry.open) throw new Error("Attempting to use a disconnected port object");
          void call("native.post", id, JSON.parse(JSON.stringify(message ?? null))).catch(() => {});
        },
        disconnect() {
          if (!entry.open) return;
          entry.open = false;
          ports.delete(id);
          void call("native.disconnect", id).catch(() => {});
        },
      };
      const entry = { onMessage, onDisconnect, port, open: true };
      ports.set(id, entry);
      void call("native.connect", id, String(application)).catch(() => {});
      return port;
    });
  }

  // --- chrome.webNavigation ------------------------------------------------------------------------------

  if (has("webNavigation")) {
    const urlMatches = (f: any, url: string) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return false;
      }
      const host = u.hostname;
      const path = u.pathname;
      const query = u.search.slice(1);
      const whole = url.split("#")[0]!;
      const checks: [string, string, (a: string, b: string) => boolean][] = [];
      const contains = (a: string, b: string) => a.includes(b);
      const equals = (a: string, b: string) => a === b;
      const prefix = (a: string, b: string) => a.startsWith(b);
      const suffix = (a: string, b: string) => a.endsWith(b);
      checks.push(
        ["hostContains", `.${host}`, contains],
        ["hostEquals", host, equals],
        ["hostPrefix", host, prefix],
        ["hostSuffix", host, suffix],
        ["pathContains", path, contains],
        ["pathEquals", path, equals],
        ["pathPrefix", path, prefix],
        ["pathSuffix", path, suffix],
        ["queryContains", query, contains],
        ["queryEquals", query, equals],
        ["queryPrefix", query, prefix],
        ["querySuffix", query, suffix],
        ["urlContains", whole, contains],
        ["urlEquals", whole, equals],
        ["urlPrefix", whole, prefix],
        ["urlSuffix", whole, suffix],
      );
      for (const [key, value, test] of checks) if (typeof f[key] === "string" && !test(value, f[key])) return false;
      try {
        if (typeof f.urlMatches === "string" && !new RegExp(f.urlMatches).test(whole)) return false;
        if (typeof f.originAndPathMatches === "string" && !new RegExp(f.originAndPathMatches).test(u.origin + path)) return false;
      } catch {
        return false;
      }
      if (Array.isArray(f.schemes) && !f.schemes.includes(u.protocol.slice(0, -1))) return false;
      if (Array.isArray(f.ports)) {
        const port = Number(u.port || (u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 0));
        if (!f.ports.some((p: any) => (Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p))) return false;
      }
      return true;
    };
    const byUrl = (filter: any, args: any[]) => !Array.isArray(filter?.url) || filter.url.some((f: any) => urlMatches(f, args[0]?.url ?? ""));
    const names = ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated", "onHistoryStateUpdated", "onTabReplaced"];
    const nav: any = { getFrame: api("nav.getFrame"), getAllFrames: api("nav.getAllFrames") };
    for (const n of names) nav[n] = ev(`webNavigation.${n}`, byUrl);
    define(c, "webNavigation", nav);
  }

  // --- chrome.cookies -------------------------------------------------------------------------------------

  if (has("cookies")) {
    define(c, "cookies", {
      get: api("cookies.get"),
      getAll: api("cookies.getAll", ([d]) => [d ?? {}]),
      set: api("cookies.set"),
      remove: api("cookies.remove"),
      getAllCookieStores: api("cookies.stores"),
      getPartitionKey: resolved({ partitionKey: {} }),
      onChanged: ev("cookies.onChanged"),
    });
  }

  // --- chrome.notifications ----------------------------------------------------------------------------------

  if (has("notifications")) {
    const options = (o: any) => ({
      ...o,
      iconUrl: typeof o?.iconUrl === "string" && o.iconUrl ? absolute(o.iconUrl) : undefined,
      imageUrl: undefined,
      buttons: Array.isArray(o?.buttons) ? o.buttons.map((b: any) => ({ title: String(b?.title ?? "") })) : undefined,
    });
    define(c, "notifications", {
      create: api("notifications.create", (args) => (typeof args[0] === "string" || args[0] == null ? [args[0] ?? "", options(args[1])] : ["", options(args[0])])),
      update: api("notifications.update", ([id, o]) => [id, options(o)]),
      clear: api("notifications.clear"),
      getAll: api("notifications.getAll"),
      getPermissionLevel: resolved("granted"),
      onClicked: ev("notifications.onClicked"),
      onClosed: ev("notifications.onClosed"),
      onButtonClicked: ev("notifications.onButtonClicked"),
      onPermissionLevelChanged: ev("notifications.onPermissionLevelChanged"),
      onShowSettings: ev("notifications.onShowSettings"),
      TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
      PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
    });
  }

  // --- The rest: small ones -------------------------------------------------------------------------------------

  if (has("idle")) {
    define(c, "idle", {
      queryState: api("idle.queryState"),
      setDetectionInterval: () => {},
      getAutoLockDelay: resolved(0),
      onStateChanged: ev("idle.onStateChanged"),
    });
  }

  if (!c.management?.getSelf || !c.management?.getAll) {
    define(c, "management", {
      ...(c.management ?? {}),
      getSelf: api("management.getSelf"),
      get: api("management.get"),
      getAll: api("management.getAll"),
      getPermissionWarningsById: resolved([]),
      setEnabled: api("unsupported", () => ["management.setEnabled"]),
      uninstallSelf: api("unsupported", () => ["management.uninstallSelf"]),
      onInstalled: ev("management.onInstalled"),
      onUninstalled: ev("management.onUninstalled"),
      onEnabled: ev("management.onEnabled"),
      onDisabled: ev("management.onDisabled"),
    });
  }

  // The side panel isn't there; its calls fail instead of crashing the extension.
  if (has("sidePanel") && !c.sidePanel) {
    define(c, "sidePanel", {
      setOptions: resolved(undefined),
      getOptions: resolved({ enabled: false }),
      setPanelBehavior: resolved(undefined),
      getPanelBehavior: resolved({ openPanelOnActionClick: false }),
      open: api("unsupported", () => ["sidePanel.open"]),
    });
  }

  const b: any = g.browser;
  if (b && b !== c) {
    for (const [target, name, value] of defined) {
      const key = target === c ? null : ["runtime", "storage", "declarativeNetRequest"].find((k) => c[k] === target);
      const other = key === null ? b : key ? b[key] : undefined;
      if (other && other !== target) defineOn(other, name, value);
    }
  }
}
