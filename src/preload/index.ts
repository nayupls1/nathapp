import { contextBridge } from "electron";
import type { GappBridge } from "../shared/api";

const serverArg = process.argv.find((arg) => arg.startsWith("--gapp-server-url="));

const bridge: GappBridge = {
  serverUrl: serverArg?.slice("--gapp-server-url=".length) ?? "",
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
};

contextBridge.exposeInMainWorld("gapp", bridge);
