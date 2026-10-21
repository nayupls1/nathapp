import { contextBridge, ipcRenderer } from "electron";
import { WEB_PARTITION, type GappBridge } from "../shared/api";

const serverArg = process.argv.find((arg) => arg.startsWith("--gapp-server-url="));

const listen =
  <T>(channel: string) =>
  (fn: (value: T) => void) => {
    const handler = (_event: unknown, value: T) => fn(value);
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
  };

const bridge: GappBridge = {
  serverUrl: serverArg?.slice("--gapp-server-url=".length) ?? "",
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
  },
};

contextBridge.exposeInMainWorld("gapp", bridge);
