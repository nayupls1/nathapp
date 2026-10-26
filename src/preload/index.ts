import { contextBridge, ipcRenderer } from "electron";
import type { NathAppBridge } from "../shared/api";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const listen =
  <T>(channel: string) =>
  (fn: (value: T) => void) => {
    const handler = (_event: unknown, value: T) => fn(value);
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
  };

const bridge: NathAppBridge = {
  serverUrl: arg("nathapp-server-url"),
  token: arg("nathapp-token"),
  safeMode: arg("nathapp-safe-mode") === "1",
  offscreen: arg("nathapp-offscreen") === "1",
  relaunch: (safeMode) => ipcRenderer.send("nathapp:relaunch", safeMode),
  window: {
    platform: process.platform,
    minimize: () => ipcRenderer.send("nathapp:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("nathapp:window", "toggle-maximize"),
    close: () => ipcRenderer.send("nathapp:window", "close"),
    onMaximized: listen("nathapp:maximized"),
  },
  pickFolder: (title) => ipcRenderer.invoke("nathapp:pick-folder", title),
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  web: {
    clearWorkspace: (workspaceId) => ipcRenderer.invoke("nathapp:clear-workspace", workspaceId),
    onOpenTab: listen("nathapp:open-tab"),
    onShortcut: listen("nathapp:shortcut"),
    capture: (webContentsId) => ipcRenderer.invoke("nathapp:capture", webContentsId),
    openExternal: (url) => ipcRenderer.send("nathapp:open-external", url),
    network: {
      list: (webContentsId, filter) => ipcRenderer.invoke("nathapp:network-list", webContentsId, filter),
      get: (webContentsId, id, reveal) => ipcRenderer.invoke("nathapp:network-get", webContentsId, id, reveal),
      clear: (webContentsId) => ipcRenderer.invoke("nathapp:network-clear", webContentsId),
      replay: (target, overrides, reveal) => ipcRenderer.invoke("nathapp:network-replay", target, overrides, reveal),
      draft: (webContentsId, id) => ipcRenderer.invoke("nathapp:network-draft", webContentsId, id),
      setRules: (rules) => ipcRenderer.send("nathapp:network-rules", rules),
      setRecording: (enabled) => ipcRenderer.send("nathapp:network-recording", enabled),
      onChanged: listen("nathapp:network-changed"),
    },
  },
  extensions: {
    list: () => ipcRenderer.invoke("nathapp:extensions-list"),
    prepare: (workspaceId) => ipcRenderer.invoke("nathapp:extensions-prepare", workspaceId),
    actions: (workspaceId, webContentsId) => ipcRenderer.invoke("nathapp:extensions-actions", workspaceId, webContentsId),
    click: (workspaceId, extensionId) => ipcRenderer.invoke("nathapp:extensions-click", workspaceId, extensionId),
    actionMenu: (workspaceId, extensionId) => ipcRenderer.invoke("nathapp:extensions-action-menu", workspaceId, extensionId),
    detectBrowsers: () => ipcRenderer.invoke("nathapp:extensions-detect"),
    import: (request) => ipcRenderer.invoke("nathapp:extensions-import", request),
    install: (input) => ipcRenderer.invoke("nathapp:extensions-install", input),
    loadUnpacked: () => ipcRenderer.invoke("nathapp:extensions-load-unpacked"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("nathapp:extensions-set-enabled", id, enabled),
    setPinned: (id, pinned) => ipcRenderer.invoke("nathapp:extensions-set-pinned", id, pinned),
    remove: (id) => ipcRenderer.invoke("nathapp:extensions-remove", id),
    setAutoUpdate: (enabled) => ipcRenderer.invoke("nathapp:extensions-set-auto-update", enabled),
    update: () => ipcRenderer.invoke("nathapp:extensions-update"),
    setTabs: (tabs) => ipcRenderer.send("nathapp:extensions-tabs", tabs),
    reply: (requestId, value) => ipcRenderer.send("nathapp:extensions-reply", requestId, value),
    onChanged: listen("nathapp:extensions-changed"),
    onActionsChanged: listen("nathapp:extensions-actions-changed"),
    onTabRequest: listen("nathapp:extensions-tab"),
    onPermissionRequest: listen("nathapp:extensions-permission"),
    onPopup: listen("nathapp:extensions-popup"),
    onManage: listen("nathapp:extensions-manage"),
  },
};

contextBridge.exposeInMainWorld("nathapp", bridge);
