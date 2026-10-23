import { contextBridge, ipcRenderer } from "electron";
import { WEB_PARTITION, type GappBridge } from "../shared/api";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const listen =
  <T>(channel: string) =>
  (fn: (value: T) => void) => {
    const handler = (_event: unknown, value: T) => fn(value);
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
  };

const bridge: GappBridge = {
  serverUrl: arg("gapp-server-url"),
  token: arg("gapp-token"),
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  web: {
    partition: WEB_PARTITION,
    onOpenTab: listen("gapp:open-tab"),
    onShortcut: listen("gapp:shortcut"),
    capture: (webContentsId) => ipcRenderer.invoke("gapp:capture", webContentsId),
    openExternal: (url) => ipcRenderer.send("gapp:open-external", url),
  },
};

contextBridge.exposeInMainWorld("gapp", bridge);
