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
  relaunch: (safeMode) => ipcRenderer.send("nathapp:relaunch", safeMode),
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
  },
};

contextBridge.exposeInMainWorld("nathapp", bridge);
