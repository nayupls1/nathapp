// Web tabs and app previews: pages shown in <webview> guests. They get no
// preload and no Node. The web tabs of a workspace share one session (each
// workspace has its own cookies and logins); every app preview gets a session
// of its own (apps all run on 127.0.0.1, and cookies don't separate
// ports). Popups become new tabs, browser shortcuts are forwarded to the NathApp
// window, and the renderer can screenshot them and use DevTools on them for
// the agents. Web tab sessions
// run the installed Chrome extensions (see extensions/).
import {
  app,
  clipboard,
  ipcMain,
  Menu,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { APP_PARTITION_PATTERN, DEFAULT_WORKSPACE, WEB_PARTITION, WEB_PARTITION_PATTERN, webPartition, type WebShortcut } from "../shared/api";
import { setupExtensions } from "./extensions";
import { setupDevtools } from "./devtools";
import { setupNetwork } from "./network";

const isWebUrl = (url: string) => /^https?:/i.test(url);
/** Where NathApp serves apps (see the server's runtime). */
const isAppUrl = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/i.test(url);

// Websites get the harmless permissions only (no camera, location, notifications…).
const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

function shortcutFor(input: Input): WebShortcut | undefined {
  if (input.type !== "keyDown") return;
  const mod = input.control || input.meta;
  const key = input.key.toLowerCase();
  if (mod && !input.shift && !input.alt) {
    if (key === "k") return "command-bar";
    if (key === "j") return "toggle-agent";
    if (key === "l") return "focus-address";
    if (key === "r") return "reload";
    if (key === "t") return "new-tab";
  }
  if (mod && !input.shift && !input.alt && key === "w") return "close-tab";
  if (mod && input.shift && !input.alt && key === "b") return "toggle-sidebar";
  if (mod && input.shift && !input.alt && key === "t") return "reopen-tab";
  // Ctrl+Alt+1…9: the workspace in that place (by the key's position, whatever the layout types).
  const digit = /^Digit([1-9])$/.exec(input.code ?? "");
  if (mod && input.alt && !input.shift && digit) return `workspace-${Number(digit[1])}`;
  if (key === "f5" && !mod) return "reload";
  if (input.alt && !mod && key === "arrowleft") return "back";
  if (input.alt && !mod && key === "arrowright") return "forward";
}

export function setupWebTabs(getWindow: () => BrowserWindow | undefined) {
  const send = (channel: string, ...args: unknown[]) => getWindow()?.webContents.send(channel, ...args);
  const extensions = setupExtensions({
    getWindow,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    workspaceOf: (s) => webSessions.get(s),
  });
  /** Websites, and the pages of the extensions running in that session. */
  const isTabUrl = (s: Electron.Session, url: string) => isWebUrl(url) || extensions.isExtensionPage(s, url);
  const openTab = (s: Electron.Session, url: string) => isTabUrl(s, url) && send("nathapp:open-tab", url);
  const network = setupNetwork({
    getWindow,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    workspaceOf: (s) => webSessions.get(s),
    applyRules: (rules) => extensions.setNetworkRules(rules),
  });

  const devtools = setupDevtools({ getWindow, isWebTab: (contents) => webSessions.has(contents.session) });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, prefs, params) => {
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      const src = params.src ?? "";
      const partition = params.partition ?? "";
      const isWeb = WEB_PARTITION_PATTERN.test(partition);
      const web = isWeb && (isWebUrl(src) || src === "about:blank" || extensions.isExtensionPage(webSession(partition), src));
      const preview = APP_PARTITION_PATTERN.test(partition) && (isAppUrl(src) || src === "about:blank");
      if (!web && !preview) return event.preventDefault();
      if (web) {
        webSession(partition);
        // Extension pages in iframes (password managers' fill-in menus…) get the extension APIs too.
        prefs.nodeIntegrationInSubFrames = true;
      } else lockDown(session.fromPartition(partition));
    });
    if (contents.getType() === "webview") setupGuest(contents);
  });

  function setupGuest(contents: WebContents) {
    const isPreview = () => !webSessions.has(contents.session);
    // Traffic and console of app previews too: their agents debug with them (main/devtools.ts).
    network.watch(contents);
    devtools.track(contents);
    if (!isPreview()) extensions.trackGuest(contents);
    contents.setWindowOpenHandler(({ url }) => {
      openTab(contents.session, url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      // App previews stay on the app; links elsewhere open as web tabs.
      if (isPreview() ? isAppUrl(url) : isTabUrl(contents.session, url) || url.startsWith("about:")) return;
      event.preventDefault();
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
      else openTab(contents.session, url);
    });
    contents.on("before-input-event", (event, input) => {
      const name = shortcutFor(input);
      if (name) {
        event.preventDefault();
        send("nathapp:shortcut", name);
      } else if (!isPreview() && extensions.handleInput(contents.session, input)) {
        event.preventDefault();
      }
    });
    contents.on("context-menu", (_event, params) => {
      Menu.buildFromTemplate(contextMenu(contents, params)).popup({ window: getWindow() });
    });
  }

  function contextMenu(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [];
    const history = contents.navigationHistory;
    if (params.linkURL && isWebUrl(params.linkURL)) {
      items.push(
        { label: "Open link in new tab", click: () => openTab(contents.session, params.linkURL) },
        { label: "Open link in browser", click: () => shell.openExternal(params.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.mediaType === "image" && params.srcURL) {
      items.push(
        { label: "Open image in new tab", click: () => openTab(contents.session, params.srcURL) },
        { label: "Copy image", click: () => contents.copyImageAt(params.x, params.y) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(
        { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { label: "Select all", click: () => contents.selectAll() },
        { type: "separator" },
      );
    } else if (params.selectionText) {
      items.push({ label: "Copy", click: () => contents.copy() }, { type: "separator" });
    }
    const fromExtensions = extensions.menuItems(contents, params);
    if (fromExtensions.length) items.push(...fromExtensions, { type: "separator" });
    items.push(
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => contents.reload() },
      { type: "separator" },
      { label: "Open page in browser", click: () => shell.openExternal(contents.getURL()) },
      { label: "Inspect element", click: () => contents.inspectElement(params.x, params.y) },
    );
    return items;
  }

  const lockedDown = new WeakSet<Electron.Session>();
  function lockDown(s: Electron.Session) {
    if (lockedDown.has(s)) return;
    lockedDown.add(s);
    // Extension pages also get what their manifest asks for (clipboardRead, notifications).
    const allowed = (permission: string, url: string | undefined) => allowedPermissions.has(permission) || (webSessions.has(s) && extensions.allowsPermission(s, permission, url));
    s.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
    s.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  }

  /** The session of a workspace's web tabs, set up on first use. Maps to the workspace. */
  const webSessions = new WeakMap<Electron.Session, string>();
  function webSession(partition: string) {
    const s = session.fromPartition(partition);
    if (webSessions.has(s)) return s;
    webSessions.set(s, partition === WEB_PARTITION ? DEFAULT_WORKSPACE : partition.slice(WEB_PARTITION.length + 1));
    lockDown(s);
    void extensions.attach(s);
    // A plain Chrome user agent: some sites turn away unknown browsers. Google's
    // sign-in gets Electron's instead (see signInRule).
    s.setUserAgent(app.userAgentFallback.replace(/ (nathapp|Electron)\/\S+/gi, ""));
    return s;
  }

  // A deleted workspace's cookies, logins and cache go with it.
  ipcMain.handle("nathapp:clear-workspace", async (event, workspaceId: unknown) => {
    if (event.sender !== getWindow()?.webContents || typeof workspaceId !== "string" || !/^[\w-]+$/.test(workspaceId)) return;
    const s = session.fromPartition(webPartition(workspaceId));
    await extensions.detach(s);
    await s.clearStorageData();
    await s.clearCache();
  });

  ipcMain.on("nathapp:open-external", (event, url: unknown) => {
    if (event.sender !== getWindow()?.webContents) return;
    if (typeof url === "string" && isWebUrl(url)) void shell.openExternal(url);
  });

  ipcMain.handle("nathapp:capture", async (event, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) {
      throw new Error("Unknown page");
    }
    const image = await target.capturePage();
    const scaled = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
    return scaled.toJPEG(75).toString("base64");
  });

  return {
    /** A key pressed in the NathApp window: an extension's shortcut (for the workspace on screen) runs. */
    windowInput: (input: Input) => extensions.handleInput(null, input),
  };
}

/** Keeps the NathApp window on NathApp: links open as web tabs instead. */
export function guardWindow(win: BrowserWindow, rendererOrigin: string, onInput?: (input: Input) => boolean) {
  const send = (channel: string, ...args: unknown[]) => win.webContents.send(channel, ...args);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) send("nathapp:open-tab", url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === rendererOrigin) return;
    event.preventDefault();
    if (isWebUrl(url)) send("nathapp:open-tab", url);
  });
  // Ctrl+R / F5 reload the current web tab rather than NathApp itself.
  win.webContents.on("before-input-event", (event, input) => {
    if (shortcutFor(input) === "reload") {
      event.preventDefault();
      send("nathapp:shortcut", "reload");
    } else if (onInput?.(input)) {
      event.preventDefault();
    }
  });
}
