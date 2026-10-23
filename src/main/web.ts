// Web tabs and app previews: pages shown in <webview> guests. They get no
// preload and no Node. Websites share one session; every app preview gets a
// session of its own (apps all run on 127.0.0.1, and cookies don't separate
// ports). Popups become new tabs, browser shortcuts are forwarded to the gApp
// window, and the renderer can screenshot them for the agents.
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
import { APP_PARTITION_PATTERN, WEB_PARTITION, type WebShortcut } from "../shared/api";

const isWebUrl = (url: string) => /^https?:/i.test(url);
/** Where gApp serves apps (see the server's runtime). */
const isAppUrl = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/i.test(url);

// Websites get the harmless permissions only (no camera, location, notifications…).
const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

function shortcutFor(input: Input): WebShortcut | undefined {
  if (input.type !== "keyDown") return;
  const mod = input.control || input.meta;
  const key = input.key.toLowerCase();
  if (mod && !input.shift && !input.alt) {
    if (key === "j") return "toggle-agent";
    if (key === "l") return "focus-address";
    if (key === "r") return "reload";
    if (key === "t") return "new-tab";
  }
  if (key === "f5" && !mod) return "reload";
  if (input.alt && !mod && key === "arrowleft") return "back";
  if (input.alt && !mod && key === "arrowright") return "forward";
}

export function setupWebTabs(getWindow: () => BrowserWindow | undefined) {
  const send = (channel: string, ...args: unknown[]) => getWindow()?.webContents.send(channel, ...args);
  const openTab = (url: string) => isWebUrl(url) && send("gapp:open-tab", url);

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
      const web = partition === WEB_PARTITION && (isWebUrl(src) || src === "about:blank");
      const preview = APP_PARTITION_PATTERN.test(partition) && (isAppUrl(src) || src === "about:blank");
      if (!web && !preview) return event.preventDefault();
      if (preview) lockDown(session.fromPartition(partition));
    });
    if (contents.getType() === "webview") setupGuest(contents);
  });

  function setupGuest(contents: WebContents) {
    const isPreview = () => contents.session !== web;
    contents.setWindowOpenHandler(({ url }) => {
      openTab(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      // App previews stay on the app; links elsewhere open as web tabs.
      if (isPreview() ? isAppUrl(url) : isWebUrl(url) || url.startsWith("about:")) return;
      event.preventDefault();
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
      else openTab(url);
    });
    contents.on("before-input-event", (event, input) => {
      const name = shortcutFor(input);
      if (!name) return;
      event.preventDefault();
      send("gapp:shortcut", name);
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
        { label: "Open link in new tab", click: () => openTab(params.linkURL) },
        { label: "Open link in browser", click: () => shell.openExternal(params.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.mediaType === "image" && params.srcURL) {
      items.push(
        { label: "Open image in new tab", click: () => openTab(params.srcURL) },
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
    s.setPermissionRequestHandler((_contents, permission, callback) => callback(allowedPermissions.has(permission)));
    s.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));
  }

  const web = session.fromPartition(WEB_PARTITION);
  lockDown(web);
  // A plain Chrome user agent: some sites turn away unknown browsers.
  web.setUserAgent(app.userAgentFallback.replace(/ (gapp|Electron)\/\S+/gi, ""));

  ipcMain.on("gapp:open-external", (event, url: unknown) => {
    if (event.sender !== getWindow()?.webContents) return;
    if (typeof url === "string" && isWebUrl(url)) void shell.openExternal(url);
  });

  ipcMain.handle("gapp:capture", async (event, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) {
      throw new Error("Unknown page");
    }
    const image = await target.capturePage();
    const scaled = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
    return scaled.toJPEG(75).toString("base64");
  });
}

/** Keeps the gApp window on gApp: links open as web tabs instead. */
export function guardWindow(win: BrowserWindow, rendererOrigin: string) {
  const send = (channel: string, ...args: unknown[]) => win.webContents.send(channel, ...args);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) send("gapp:open-tab", url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === rendererOrigin) return;
    event.preventDefault();
    if (isWebUrl(url)) send("gapp:open-tab", url);
  });
  // Ctrl+R / F5 reload the current web tab rather than gApp itself.
  win.webContents.on("before-input-event", (event, input) => {
    if (shortcutFor(input) !== "reload") return;
    event.preventDefault();
    send("gapp:shortcut", "reload");
  });
}
