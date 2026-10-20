import type { Server } from "bun";
import { z } from "zod";
import { efforts, type AppDetail, type ChatEvent, type ChatRequest, type DataRequest, type HealthResponse } from "../shared/api";
import { CATALOG_APP_ID, catalogSeed, catalogSpec } from "../shared/catalog";
import { Settings } from "../shared/settings";
import { AppSpec, checkReferences } from "../shared/spec";
import { isRunning, runChat, stopChat } from "./agent";
import {
  BackendError,
  backendLogs,
  backendStatus,
  backendUrl,
  copyBackend,
  deleteBackend,
  deleteBackendFile,
  hasBackend,
  listFiles,
  readBackendFile,
  restartBackend,
  setGappUrl,
  startBackend,
  stopAllBackends,
  stopBackend,
  writeBackendFile,
} from "./backends";
import { copyAppData, DataError, deleteAppData, migrate, onDataChange, resetAppData, runData } from "./appdata";
import { dataDir } from "./config";
import {
  addMessage,
  clearMessages,
  createApp,
  deleteApp,
  duplicateApp,
  getApp,
  getSettings,
  listApps,
  listMessages,
  saveSettings,
  updateApp,
} from "./db";
import { clearFrameErrors, findCustom, frameHtml, frameErrors, reportFrameError } from "./frames";
import { attachHub, dataChanged, specChanged, websocket, type SocketData } from "./hub";
import { isIcon } from "./icons";
import { listModels } from "./models";
import { sdkJs } from "./sdk";

// Every write to app data is broadcast to realtime subscribers.
onDataChange(dataChanged);

// The Catalog page renders its examples against a demo app, reset on every start.
resetAppData(CATALOG_APP_ID, catalogSpec, catalogSeed);

// The Electron main process picks a free port and passes it in. When running
// the server standalone (`bun run server`) it falls back to 3000.
const port = Number(process.env.PORT ?? 3000);

// Only the app's own renderer may call the API from a browser context.
const allowedOrigin = process.env.GAPP_ALLOWED_ORIGIN ?? "http://localhost:5173";
// Pages served by this server itself (custom components) are trusted too.
const trustedOrigins = new Set([allowedOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);

/**
 * Websites open in web tabs can reach 127.0.0.1 too. Browsers always send an
 * Origin header on cross-origin writes and WebSocket handshakes, so anything
 * with a foreign Origin is refused. Local processes (backends, curl) send none.
 */
const foreignOrigin = (req: Request) => {
  const origin = req.headers.get("origin");
  return origin !== null && !trustedOrigins.has(origin);
};

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json<T>(data: T, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { ...corsHeaders, ...init?.headers } });
}

const noContent = () => new Response(null, { status: 204, headers: corsHeaders });
const notFound = () => json({ error: "Not found" }, { status: 404 });
const badRequest = (error: string) => json({ error }, { status: 400 });

type Handler<P extends string> = (
  req: Bun.BunRequest<P>,
  server: Server<SocketData>,
) => Response | Promise<Response | undefined> | undefined;
type Route<P extends string> = Handler<P> | Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler<P>>>;

/** Applies the origin check to every non-GET handler. */
function guarded<R extends Record<string, unknown>>(routes: { [P in keyof R & string]: Route<P> }) {
  const guard = (fn: Handler<string>): Handler<string> => (req, server) =>
    req.method !== "GET" && foreignOrigin(req) ? json({ error: "Forbidden" }, { status: 403 }) : fn(req, server);
  return Object.fromEntries(
    Object.entries(routes as Record<string, Route<string>>).map(([path, route]) => [
      path,
      typeof route === "function"
        ? guard(route)
        : Object.fromEntries(Object.entries(route).map(([method, fn]) => [method, guard(fn!)])),
    ]),
  ) as unknown as Bun.Serve.Routes<SocketData, string>;
}

/** Validates a spec (shape, references, icons) and returns it or a list of problems. */
export function validateSpec(input: unknown): { spec: AppSpec } | { problems: string } {
  const parsed = AppSpec.safeParse(input);
  if (!parsed.success) return { problems: z.prettifyError(parsed.error) };
  const problems = checkReferences(parsed.data, { isIcon });
  if (problems.length) return { problems: problems.map((p) => `- ${p}`).join("\n") };
  return { spec: parsed.data };
}

/** Forwards a request (or WebSocket) under /api/apps/:id/backend to the app's backend. */
async function proxyToBackend(req: Bun.BunRequest<"/api/apps/:id/backend/*">, server: Server<SocketData>) {
  const appId = req.params.id;
  if (foreignOrigin(req)) return json({ error: "Forbidden" }, { status: 403 });
  const base = await backendUrl(appId).catch(() => null);
  if (!base) {
    return hasBackend(appId)
      ? json({ error: "The app's backend isn't running; check its logs" }, { status: 502 })
      : json({ error: "This app has no backend" }, { status: 404 });
  }
  const url = new URL(req.url);
  const marker = `/api/apps/${appId}/backend`;
  const target = `${base}${url.pathname.slice(marker.length) || "/"}${url.search}`;

  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (server.upgrade(req, { data: { renderer: false, upstream: target.replace(/^http/, "ws") } })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  const headers = new Headers(req.headers);
  headers.delete("host");
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    const out = new Headers(res.headers);
    // fetch already decoded the body.
    out.delete("content-encoding");
    out.delete("content-length");
    for (const [k, v] of Object.entries(corsHeaders)) out.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (err) {
    return json({ error: `Backend request failed: ${err instanceof Error ? err.message : err}` }, { status: 502 });
  }
}

/** The file path after /files/ in a backend file URL. */
const filePath = (req: Request) => decodeURIComponent(new URL(req.url).pathname.replace(/^\/api\/apps\/[^/]+\/files\//, ""));

const specFor = (appId: string) => (appId === CATALOG_APP_ID ? catalogSpec : getApp(appId)?.spec);

const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port,
  // Agent runs stream for a long time with quiet stretches; don't cut them off.
  idleTimeout: 0,
  websocket,
  routes: guarded({
    "/api/health": () => json<HealthResponse>({ ok: true, uptime: process.uptime(), bun: Bun.version, dataDir }),

    "/api/ws": (req, server) => {
      if (foreignOrigin(req)) return new Response("Forbidden", { status: 403 });
      const renderer = new URL(req.url).searchParams.get("role") === "renderer" && req.headers.get("origin") === allowedOrigin;
      if (server.upgrade(req, { data: { renderer } })) return undefined;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },

    // The realtime SDK for custom components: import { connect } from "/sdk/gapp.js"
    "/sdk/gapp.js": () => new Response(sdkJs, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),

    // A custom component's page, shown in an iframe by the renderer.
    "/frame/:appId/:name": (req) => {
      const spec = specFor(req.params.appId);
      const node = spec && findCustom(spec, req.params.name);
      if (!node) return new Response("Unknown component", { status: 404 });
      return new Response(frameHtml(req.params.appId, node), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    },

    "/api/apps/:id/frame-errors": {
      GET: (req) => json(frameErrors(req.params.id)),
      POST: async (req) => {
        const body = (await req.json()) as { component?: unknown; message?: unknown };
        if (typeof body.message !== "string") return badRequest("message is required");
        reportFrameError(req.params.id, String(body.component ?? "?"), body.message);
        return noContent();
      },
      DELETE: (req) => {
        clearFrameErrors(req.params.id);
        return noContent();
      },
    },

    "/api/models": async () => {
      try {
        return json(await listModels());
      } catch (err) {
        return json({ error: `Could not load models: ${err instanceof Error ? err.message : err}` }, { status: 502 });
      }
    },

    "/api/settings": {
      GET: () => json(getSettings()),
      PUT: async (req) => {
        const parsed = Settings.safeParse(await req.json());
        if (!parsed.success) return badRequest(z.prettifyError(parsed.error));
        saveSettings(parsed.data);
        return json(parsed.data);
      },
    },

    "/api/apps": {
      GET: () => json(listApps()),
      POST: () => json(createApp(), { status: 201 }),
    },

    "/api/apps/:id": {
      GET: (req) => {
        const app = getApp(req.params.id);
        if (!app) return notFound();
        const { sessionId, ...rest } = app;
        if (getSettings().backends.autoStart && hasBackend(app.id) && backendStatus(app.id).state === "stopped") {
          startBackend(app.id).catch((err) => console.error(`[backend ${app.id}]`, err));
        }
        return json<AppDetail>({ ...rest, messages: listMessages(app.id), running: isRunning(app.id) });
      },
      PATCH: async (req) => {
        const body = (await req.json()) as { name?: unknown };
        if (typeof body.name !== "string" || !body.name.trim()) return badRequest("name is required");
        const app = updateApp(req.params.id, { name: body.name.trim() });
        return app ? json(app) : notFound();
      },
      DELETE: (req) => {
        stopChat(req.params.id);
        deleteApp(req.params.id);
        deleteAppData(req.params.id);
        deleteBackend(req.params.id);
        return noContent();
      },
    },

    // Replaces an app's spec directly (import, tests). The agent uses update_app.
    "/api/apps/:id/spec": {
      PUT: async (req) => {
        const appId = req.params.id;
        if (!getApp(appId)) return notFound();
        const result = validateSpec(await req.json());
        if ("problems" in result) return badRequest(`Invalid spec:\n${result.problems}`);
        migrate(appId, result.spec);
        const app = updateApp(appId, { spec: result.spec, name: result.spec.name, icon: result.spec.icon ?? null });
        specChanged(appId);
        return json(app);
      },
    },

    "/api/apps/:id/chat": {
      POST: async (req) => {
        const appId = req.params.id;
        if (!getApp(appId)) return notFound();
        if (isRunning(appId)) return json({ error: "The agent is already working on this app" }, { status: 409 });
        const body = (await req.json()) as Partial<ChatRequest>;
        if (typeof body.prompt !== "string" || !body.prompt.trim()) return badRequest("prompt is required");
        if (body.model !== undefined && typeof body.model !== "string") return badRequest("invalid model");
        if (body.effort !== undefined && !efforts.includes(body.effort)) return badRequest("invalid effort");
        const prompt = body.prompt.trim();
        const options = { model: body.model || undefined, effort: body.effort };
        updateApp(appId, { model: options.model ?? null, effort: options.effort ?? null });

        // NDJSON stream of ChatEvents. The run continues even if the client
        // goes away; everything important is persisted as it happens.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let open = true;
            const emit = (event: ChatEvent) => {
              if (!open) return;
              try {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              } catch {
                open = false;
              }
            };
            runChat(appId, prompt, emit, options)
              .catch((err) => emit({ type: "message", message: addMessage(appId, "error", String(err)) }))
              .finally(() => {
                if (open) controller.close();
                open = false;
              });
          },
        });
        return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "application/x-ndjson" } });
      },
    },

    "/api/apps/:id/duplicate": {
      POST: (req) => {
        const copy = duplicateApp(req.params.id);
        if (!copy) return notFound();
        copyAppData(req.params.id, copy.id);
        copyBackend(req.params.id, copy.id);
        return json(copy, { status: 201 });
      },
    },

    "/api/apps/:id/messages": {
      DELETE: (req) => {
        if (!getApp(req.params.id)) return notFound();
        if (isRunning(req.params.id)) return json({ error: "Stop the agent before clearing the chat" }, { status: 409 });
        clearMessages(req.params.id);
        return noContent();
      },
    },

    "/api/apps/:id/stop": {
      POST: (req) => {
        stopChat(req.params.id);
        return json({ ok: true });
      },
    },

    // The app's custom backend, proxied (HTTP and WebSocket). Started on demand.
    "/api/apps/:id/backend": proxyToBackend,
    "/api/apps/:id/backend/*": proxyToBackend,

    "/api/apps/:id/runtime": {
      GET: (req) =>
        json({ status: backendStatus(req.params.id), logs: backendLogs(req.params.id, 300), files: listFiles(req.params.id) }),
      POST: async (req) => {
        const { action } = (await req.json()) as { action?: string };
        try {
          if (action === "stop") stopBackend(req.params.id);
          else if (action === "start") await startBackend(req.params.id);
          else if (action === "restart") await restartBackend(req.params.id);
          else return badRequest('action must be "start", "stop" or "restart"');
        } catch (err) {
          if (err instanceof BackendError) return badRequest(err.message);
          throw err;
        }
        return json(backendStatus(req.params.id));
      },
    },

    "/api/apps/:id/files/*": {
      GET: (req) => {
        try {
          return new Response(readBackendFile(req.params.id, filePath(req)), {
            headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
          });
        } catch (err) {
          if (err instanceof BackendError) return json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      PUT: async (req) => {
        if (!getApp(req.params.id)) return notFound();
        try {
          writeBackendFile(req.params.id, filePath(req), await req.text());
          return noContent();
        } catch (err) {
          if (err instanceof BackendError) return badRequest(err.message);
          throw err;
        }
      },
      DELETE: (req) => {
        try {
          deleteBackendFile(req.params.id, filePath(req));
          return noContent();
        } catch (err) {
          if (err instanceof BackendError) return json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
    },

    "/api/apps/:id/data": {
      POST: async (req) => {
        const spec = specFor(req.params.id);
        if (!spec) return notFound();
        try {
          return json(runData(req.params.id, spec, (await req.json()) as DataRequest));
        } catch (err) {
          if (err instanceof DataError) return badRequest(err.message);
          if (err instanceof SyntaxError) return badRequest("Invalid JSON");
          throw err;
        }
      },
    },
  }),
  fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    return notFound();
  },
  error(err) {
    console.error("[server]", err);
    return json({ error: err.message }, { status: 500 });
  },
});

attachHub(server);
setGappUrl(server.url.toString());
console.log(`[server] listening on ${server.url}`);

// When spawned by Electron, stdin is a pipe owned by the main process. If the
// app dies without shutting us down cleanly, the pipe closes and we exit too.
if (process.env.GAPP_PARENT === "electron") {
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}

// Backends are child processes; don't leave them running.
process.on("exit", stopAllBackends);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
