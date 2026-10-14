// Types shared between the Bun server, the Electron main/preload and the renderer.

export interface HealthResponse {
  ok: true;
  uptime: number;
  bun: string;
}

export interface HelloResponse {
  message: string;
  time: string;
}

/** API exposed on `window.gapp` by the preload script. */
export interface GappBridge {
  serverUrl: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}
