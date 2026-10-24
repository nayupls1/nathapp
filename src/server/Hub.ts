// The hub: WebSocket clients subscribe to topics and the server pushes chat
// events, runtime status, logs and other changes on them. The renderer also
// answers RPC requests, which is how agents reach pages open in its tabs.
import { Context, Data, Effect, Layer } from "effect";
import type { Socket } from "effect/socket";
import { isValidTopic, type ClientMessage, type ServerMessage, type TopicMessage } from "../shared/hub";

export class RpcError extends Data.TaggedError("RpcError")<{ readonly message: string }> {}

interface Client {
  readonly renderer: boolean;
  readonly topics: Set<string>;
  readonly send: (text: string) => void;
}

export interface HubShape {
  readonly publish: (msg: TopicMessage) => Effect.Effect<void>;
  /** Fire-and-forget publish for non-Effect callers (process output handlers). */
  readonly publishUnsafe: (msg: TopicMessage) => void;
  /** Asks the NathApp window to do something (e.g. run JS in a page) and waits for the answer. */
  readonly rpc: <T>(method: string, params: unknown, timeoutMs?: number) => Effect.Effect<T, RpcError>;
  /** Serves one WebSocket connection until it closes. */
  readonly serve: (socket: Socket.Socket, options: { renderer: boolean }) => Effect.Effect<void>;
  readonly rendererConnected: Effect.Effect<boolean>;
}

export class Hub extends Context.Service<Hub, HubShape>()("nathapp/Hub") {}

export const make = Effect.sync((): HubShape => {
  const clients = new Set<Client>();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextRpcId = 0;

  const publishUnsafe = (msg: TopicMessage) => {
    const text = JSON.stringify(msg);
    for (const client of clients) if (client.topics.has(msg.topic)) client.send(text);
  };

  const renderer = () => [...clients].reverse().find((c) => c.renderer);

  const onMessage = (client: Client, raw: string) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "subscribe":
        if (isValidTopic(msg.topic)) client.topics.add(msg.topic);
        break;
      case "unsubscribe":
        client.topics.delete(msg.topic);
        break;
      case "rpc-result": {
        if (!client.renderer) break;
        const call = pending.get(msg.id);
        if (!call) break;
        pending.delete(msg.id);
        if (msg.error !== undefined) call.reject(new Error(msg.error));
        else call.resolve(msg.result);
        break;
      }
    }
  };

  const decoder = new TextDecoder();

  return {
    publish: (msg) => Effect.sync(() => publishUnsafe(msg)),
    publishUnsafe,
    rendererConnected: Effect.sync(() => !!renderer()),

    rpc: <T>(method: string, params: unknown, timeoutMs = 30_000) =>
      Effect.callback<T, RpcError>((resume) => {
        const target = renderer();
        if (!target) return resume(Effect.fail(new RpcError({ message: "The NathApp window is not connected" })));
        const id = ++nextRpcId;
        const timer = setTimeout(() => {
          pending.delete(id);
          resume(Effect.fail(new RpcError({ message: `${method} timed out after ${timeoutMs / 1000}s` })));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resume(Effect.succeed(v as T))),
          reject: (e) => (clearTimeout(timer), resume(Effect.fail(new RpcError({ message: e.message })))),
        });
        target.send(JSON.stringify({ type: "rpc", id, method, params } satisfies ServerMessage));
        return Effect.sync(() => {
          clearTimeout(timer);
          pending.delete(id);
        });
      }),

    serve: (socket, options) =>
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const client: Client = {
          renderer: options.renderer,
          topics: new Set(),
          send: (text) => Effect.runFork(Effect.ignore(writer.write(text))),
        };
        clients.add(client);
        yield* Effect.addFinalizer(() => Effect.sync(() => clients.delete(client)));
        const reader = yield* socket.reader;
        for (;;) {
          const batch = yield* reader.pull;
          for (const chunk of batch) onMessage(client, typeof chunk === "string" ? chunk : decoder.decode(chunk));
        }
      }).pipe(Effect.scoped, Effect.ignore),
  };
});

export const layer = Layer.effect(Hub, make);
