// WebSocket hub at /api/ws. Clients (renderer, custom components, backends)
// subscribe to topics; the server broadcasts data changes, channel messages and
// backend status on them. The renderer also answers RPC requests from the
// server, which is how the website agent reaches pages open in web tabs.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { ClientMessage, ServerMessage } from "../sdk/gapp";

export interface SocketData {
  /** The renderer handles RPC requests; everything else is a plain client. */
  renderer: boolean;
  /** Set for sockets proxied to an app backend: the backend's ws:// URL. */
  upstream?: string;
  /** The connection to the backend, for proxied sockets. */
  backend?: WebSocket;
  /** Messages from the client received before the backend connection opened. */
  queued?: (string | Uint8Array<ArrayBuffer>)[];
}

type WS = ServerWebSocket<SocketData>;

let server: Server<SocketData> | undefined;
const renderers: WS[] = [];
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }>();
let nextRpcId = 0;

export const topics = {
  app: (appId: string) => `app:${appId}`,
  channel: (appId: string, name: string) => `channel:${appId}:${name}`,
  backend: (appId: string) => `backend:${appId}`,
  /** Site customizations for web tabs changed. */
  sites: "sites",
};

const validTopic = (topic: unknown): topic is string =>
  typeof topic === "string" && topic.length < 300 && (/^(app|channel|backend):/.test(topic) || topic === topics.sites);

export function attachHub(s: Server<SocketData>) {
  server = s;
}

type Outgoing = ServerMessage extends infer M ? (M extends { topic: string } ? M : never) : never;

export function publish(msg: Outgoing) {
  server?.publish(msg.topic, JSON.stringify(msg));
}

export function dataChanged(appId: string, tables: string[]) {
  publish({ type: "change", topic: topics.app(appId), appId, tables });
}

export function specChanged(appId: string) {
  publish({ type: "spec", topic: topics.app(appId), appId });
}

export function siteChanged(host: string) {
  publish({ type: "site", topic: topics.sites, host });
}

export const websocket: WebSocketHandler<SocketData> = {
  idleTimeout: 120,
  sendPings: true,
  open(ws) {
    if (ws.data.upstream) return openProxy(ws);
    if (ws.data.renderer) renderers.push(ws);
  },
  message(ws, raw) {
    if (ws.data.upstream) {
      const backend = ws.data.backend;
      const data = typeof raw === "string" ? raw : new Uint8Array(raw as Uint8Array<ArrayBuffer>);
      if (backend?.readyState === WebSocket.OPEN) backend.send(data);
      else ws.data.queued?.push(data);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "subscribe":
        if (validTopic(msg.topic)) ws.subscribe(msg.topic);
        break;
      case "unsubscribe":
        if (validTopic(msg.topic)) ws.unsubscribe(msg.topic);
        break;
      case "publish":
        // Clients may only talk on channels; data and backend topics are the server's.
        if (validTopic(msg.topic) && msg.topic.startsWith("channel:")) {
          ws.publish(msg.topic, JSON.stringify({ type: "message", topic: msg.topic, data: msg.data } satisfies ServerMessage));
        }
        break;
      case "rpc-result": {
        if (!ws.data.renderer) break;
        const call = pending.get(msg.id);
        if (!call) break;
        pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error !== undefined) call.reject(new Error(msg.error));
        else call.resolve(msg.result);
        break;
      }
    }
  },
  close(ws, code, reason) {
    if (ws.data.upstream) {
      ws.data.backend?.close(code === 1005 ? 1000 : code, reason);
      return;
    }
    const i = renderers.indexOf(ws);
    if (i !== -1) renderers.splice(i, 1);
  },
};

/** Pipes a client socket to an app backend's WebSocket endpoint. */
function openProxy(ws: WS) {
  ws.data.queued = [];
  const backend = new WebSocket(ws.data.upstream!);
  backend.binaryType = "arraybuffer";
  ws.data.backend = backend;
  backend.onopen = () => {
    for (const msg of ws.data.queued!.splice(0)) backend.send(msg);
  };
  backend.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
  backend.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1011 : e.code, e.reason);
  backend.onerror = () => ws.close(1011, "Backend connection failed");
}

/** Asks the gApp window to do something (e.g. run JS in a web tab) and waits for the answer. */
export function rpc<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
  const renderer = renderers.at(-1);
  if (!renderer) return Promise.reject(new Error("The gApp window is not connected"));
  const id = ++nextRpcId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    renderer.send(JSON.stringify({ type: "rpc", id, method, params } satisfies ServerMessage));
  });
}
