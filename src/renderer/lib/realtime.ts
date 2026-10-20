// The renderer's realtime connection to the server: data change notifications
// for open apps, and RPC requests from the server (used by the website agent).
import { createSignal } from "solid-js";
import { Socket, type ServerMessage } from "../../sdk/gapp";

const socket = new Socket(`${window.gapp.serverUrl.replace(/^http/, "ws")}/api/ws?role=renderer`);

const [connected, setConnected] = createSignal(false);
socket.onConnection(setConnected);
export { connected as realtimeConnected };

/** Calls `onChange` with changed table names (or "spec") for an app. Returns an unsubscribe function. */
export function watchApp(appId: string, handlers: { tables: (tables: string[]) => void; spec?: () => void }) {
  return socket.subscribe(`app:${appId}`, (msg: ServerMessage) => {
    if (msg.type === "change") handlers.tables(msg.tables);
    else if (msg.type === "spec") handlers.spec?.();
  });
}

export function watchTopic(topic: string, fn: (msg: ServerMessage) => void) {
  return socket.subscribe(topic, fn);
}

type RpcHandler = (params: any) => unknown;
const rpcHandlers = new Map<string, RpcHandler>();

/** Registers a handler for server → renderer requests. */
export function handleRpc(method: string, fn: RpcHandler) {
  rpcHandlers.set(method, fn);
}

socket.onRpc = (method, params) => {
  const fn = rpcHandlers.get(method);
  if (!fn) throw new Error(`Unknown request: ${method}`);
  return fn(params);
};
