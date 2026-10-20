// gApp realtime SDK. One dependency-free file used by:
//   - the gApp renderer (live data in generated apps)
//   - custom components (served as /sdk/gapp.js to their iframes)
//   - custom app backends (copied next to their code as ./gapp.ts)
//
// Reads and writes go over HTTP; every write is broadcast over a WebSocket so
// live queries everywhere update immediately. Channels carry ephemeral
// messages (presence, cursors, notifications) between all connected clients.

export type Value = string | number | boolean | null;
export type Where = Record<string, Value>;
export type Row = { id: number; created_at: string } & Record<string, Value>;

export interface QueryOptions {
  where?: Where;
  sort?: { column: string; dir?: "asc" | "desc" };
  limit?: number;
}

export interface AggregateOptions {
  aggregate: "count" | "sum" | "avg" | "min" | "max";
  column?: string;
  where?: Where;
  groupBy?: string;
  bucket?: "day" | "week" | "month" | "year";
  seriesBy?: string;
}

export type Group = { key: Value; series?: Value; value: number | null };

// --- Wire protocol (shared with the gApp server) ------------------------------

/** Topics: `app:<id>` data/spec changes, `channel:<id>:<name>` messages, `backend:<id>` backend status/logs. */
export type ClientMessage =
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "publish"; topic: string; data: unknown }
  | { type: "rpc-result"; id: number; result?: unknown; error?: string };

export type ServerMessage =
  | { type: "change"; topic: string; appId: string; tables: string[] }
  | { type: "spec"; topic: string; appId: string }
  | { type: "message"; topic: string; data: unknown }
  | { type: "backend"; topic: string; appId: string; status?: unknown; log?: string }
  | { type: "rpc"; id: number; method: string; params: unknown };

// --- Socket ----------------------------------------------------------------------

type Handler = (msg: ServerMessage) => void;

/** A WebSocket to the gApp server that reconnects and re-subscribes on its own. */
export class Socket {
  private ws: WebSocket | undefined;
  private handlers = new Map<string, Set<Handler>>();
  private queue: ClientMessage[] = [];
  private retry = 0;
  private closed = false;
  private listeners = new Set<(connected: boolean) => void>();
  onRpc: ((method: string, params: unknown) => unknown) | undefined;
  connected = false;

  constructor(private url: string) {
    this.open();
  }

  private open() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      for (const topic of this.handlers.keys()) this.raw({ type: "subscribe", topic });
      for (const msg of this.queue.splice(0)) this.raw(msg);
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      if (msg.type === "rpc") return void this.answer(msg.id, msg.method, msg.params);
      for (const fn of this.handlers.get(msg.topic) ?? []) fn(msg);
    };
    ws.onclose = () => {
      this.setConnected(false);
      if (this.closed) return;
      const delay = Math.min(250 * 2 ** this.retry++, 5000);
      setTimeout(() => this.open(), delay);
    };
  }

  private setConnected(value: boolean) {
    this.connected = value;
    for (const fn of this.listeners) fn(value);
  }

  /** Called with true/false whenever the connection opens or drops. */
  onConnection(fn: (connected: boolean) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private async answer(id: number, method: string, params: unknown) {
    try {
      if (!this.onRpc) throw new Error("This client doesn't handle requests");
      this.raw({ type: "rpc-result", id, result: await this.onRpc(method, params) });
    } catch (err) {
      this.raw({ type: "rpc-result", id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private raw(msg: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === 1) this.raw(msg);
    else this.queue.push(msg);
  }

  subscribe(topic: string, fn: Handler): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
      this.raw({ type: "subscribe", topic });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.handlers.get(topic) === set) {
        this.handlers.delete(topic);
        this.raw({ type: "unsubscribe", topic });
      }
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

// --- Client ------------------------------------------------------------------------

export interface ConnectOptions {
  /** gApp server URL. Default: $GAPP_URL in backends, the page origin in custom components. */
  url?: string;
  /** App id. Default: $GAPP_APP_ID in backends, the embedding app in custom components. */
  appId?: string;
}

declare const process: { env: Record<string, string | undefined> } | undefined;

function defaults(): { url?: string; appId?: string } {
  const injected = (globalThis as { GAPP?: { url?: string; appId?: string } }).GAPP;
  if (injected) return injected;
  if (typeof process !== "undefined" && process?.env) return { url: process.env.GAPP_URL, appId: process.env.GAPP_APP_ID };
  if (typeof location !== "undefined") return { url: location.origin };
  return {};
}

/** Connects to an app's data. */
export function connect(options: ConnectOptions = {}) {
  const url = (options.url ?? defaults().url)?.replace(/\/$/, "");
  const appId = options.appId ?? defaults().appId;
  if (!url || !appId) throw new Error("gapp.connect: url and appId are required");

  let socket: Socket | undefined;
  const ws = () => (socket ??= new Socket(`${url.replace(/^http/, "ws")}/api/ws`));
  const appTopic = `app:${appId}`;

  async function data<T>(body: unknown): Promise<T> {
    const res = await fetch(`${url}/api/apps/${appId}/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
    return json;
  }

  const client = {
    url,
    appId,

    /** Rows of a table, newest first unless `sort` says otherwise. */
    query: async (table: string, opts: QueryOptions = {}) =>
      (
        await data<{ rows: Row[] }>({
          op: "query",
          table,
          ...opts,
          sort: opts.sort ? { dir: "asc", ...opts.sort } : { column: "created_at", dir: "desc" },
        })
      ).rows,

    /** A single number, or groups when `groupBy` is set. */
    aggregate: async (table: string, opts: AggregateOptions): Promise<number | null | Group[]> => {
      const res = await data<{ value?: number | null; groups?: Group[] }>({ op: "aggregate", table, ...opts });
      return res.groups ?? res.value ?? null;
    },

    /** Inserts one row or several; returns how many were inserted. */
    insert: async (table: string, values: Record<string, Value> | Record<string, Value>[]) => {
      let n = 0;
      for (const v of Array.isArray(values) ? values : [values]) {
        n += (await data<{ changes: number }>({ op: "action", action: { type: "insert", table, values: v } })).changes;
      }
      return n;
    },

    /** Updates rows matching `where`; returns how many changed. */
    update: async (table: string, where: Where, values: Record<string, Value>) =>
      (await data<{ changes: number }>({ op: "action", action: { type: "update", table, where, values } })).changes,

    /** Deletes rows matching `where` (an empty object deletes all); returns how many. */
    delete: async (table: string, where: Where) =>
      (await data<{ changes: number }>({ op: "action", action: { type: "delete", table, where } })).changes,

    /**
     * Live query: calls `callback` with the rows now and again whenever the
     * table changes (from the UI, the agent, a backend, anywhere). Returns a
     * function that stops it.
     */
    live(table: string, opts: QueryOptions, callback: (rows: Row[]) => void, onError?: (err: Error) => void) {
      let stopped = false;
      let running = false;
      let again = false;
      const run = async () => {
        if (running) return void (again = true);
        running = true;
        try {
          do {
            again = false;
            const rows = await client.query(table, opts);
            if (!stopped) callback(rows);
          } while (again && !stopped);
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        } finally {
          running = false;
        }
      };
      const unsubscribe = client.onChange((tables) => {
        if (tables.includes(table)) void run();
      });
      void run();
      return () => {
        stopped = true;
        unsubscribe();
      };
    },

    /** Called with the changed table names after every write to this app. */
    onChange(callback: (tables: string[]) => void) {
      return ws().subscribe(appTopic, (msg) => {
        if (msg.type === "change") callback(msg.tables);
      });
    },

    /** Ephemeral pub/sub between everything connected to this app (not stored). */
    channel(name: string) {
      const topic = `channel:${appId}:${name}`;
      return {
        /** Sends to every other subscriber of the channel. */
        send: (data: unknown) => ws().send({ type: "publish", topic, data }),
        on: (callback: (data: unknown) => void) =>
          ws().subscribe(topic, (msg) => {
            if (msg.type === "message") callback(msg.data);
          }),
      };
    },

    /** The app's custom backend (if it has one), reached through the gApp server. */
    backend: {
      /** fetch() against the backend, e.g. backend.fetch("/api/summary"). */
      fetch: (path: string, init?: RequestInit) =>
        fetch(`${url}/api/apps/${appId}/backend${path.startsWith("/") ? path : `/${path}`}`, init),
      /** GET + parse JSON, throwing on HTTP errors. */
      json: async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
        const res = await client.backend.fetch(path, init);
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return (await res.json()) as T;
      },
    },

    /** Closes the realtime connection. */
    close: () => socket?.close(),
  };
  return client;
}

export type Gapp = ReturnType<typeof connect>;
