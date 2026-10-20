// WebSocket hub at /api/ws. Clients (renderer, custom components, backends)
// subscribe to topics; the server broadcasts data changes, channel messages and
// backend status on them. The renderer also answers RPC requests from the
// server, which is how the website agent reaches pages open in web tabs.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { ClientMessage, ServerMessage } from "../sdk/gapp";

export interface SocketData {
  /** The renderer handles RPC requests; everything else is a plain client. */
  renderer: boolean;
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
};

const validTopic = (topic: unknown): topic is string =>
  typeof topic === "string" && topic.length < 300 && /^(app|channel|backend):/.test(topic);

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

export const websocket: WebSocketHandler<SocketData> = {
  idleTimeout: 120,
  sendPings: true,
  open(ws) {
    if (ws.data.renderer) renderers.push(ws);
  },
  message(ws, raw) {
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
  close(ws) {
    const i = renderers.indexOf(ws);
    if (i !== -1) renderers.splice(i, 1);
  },
};

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
