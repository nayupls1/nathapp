import { z } from "zod";
import { efforts, type AppDetail, type ChatEvent, type ChatRequest, type DataRequest, type HealthResponse } from "../shared/api";
import { CATALOG_APP_ID, catalogSeed, catalogSpec } from "../shared/catalog";
import { Settings } from "../shared/settings";
import { isRunning, runChat, stopChat } from "./agent";
import { copyAppData, DataError, deleteAppData, resetAppData, runData } from "./appdata";
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
import { dataDir } from "./config";
import { listModels } from "./models";

// The Catalog page renders its examples against a demo app, reset on every start.
resetAppData(CATALOG_APP_ID, catalogSpec, catalogSeed);

// The Electron main process picks a free port and passes it in. When running
// the server standalone (`bun run server`) it falls back to 3000.
const port = Number(process.env.PORT ?? 3000);

// Only the app's own renderer may call the API from a browser context.
const allowedOrigin = process.env.GAPP_ALLOWED_ORIGIN ?? "http://localhost:5173";

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json<T>(data: T, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { ...corsHeaders, ...init?.headers } });
}

const notFound = () => json({ error: "Not found" }, { status: 404 });
const badRequest = (error: string) => json({ error }, { status: 400 });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Agent runs stream for a long time with quiet stretches; don't cut them off.
  idleTimeout: 0,
  routes: {
    "/api/health": () => json<HealthResponse>({ ok: true, uptime: process.uptime(), bun: Bun.version, dataDir }),

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
        return new Response(null, { status: 204, headers: corsHeaders });
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
        return json(copy, { status: 201 });
      },
    },

    "/api/apps/:id/messages": {
      DELETE: (req) => {
        if (!getApp(req.params.id)) return notFound();
        if (isRunning(req.params.id)) return json({ error: "Stop the agent before clearing the chat" }, { status: 409 });
        clearMessages(req.params.id);
        return new Response(null, { status: 204, headers: corsHeaders });
      },
    },

    "/api/apps/:id/stop": {
      POST: (req) => {
        stopChat(req.params.id);
        return json({ ok: true });
      },
    },

    "/api/apps/:id/data": {
      POST: async (req) => {
        const spec = req.params.id === CATALOG_APP_ID ? catalogSpec : getApp(req.params.id)?.spec;
        if (!spec) return notFound();
        try {
          return json(runData(req.params.id, spec, (await req.json()) as DataRequest));
        } catch (err) {
          if (err instanceof DataError) return badRequest(err.message);
          throw err;
        }
      },
    },
  },
  fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    return notFound();
  },
  error(err) {
    console.error("[server]", err);
    return json({ error: err.message }, { status: 500 });
  },
});

console.log(`[server] listening on ${server.url}`);

// When spawned by Electron, stdin is a pipe owned by the main process. If the
// app dies without shutting us down cleanly, the pipe closes and we exit too.
if (process.env.GAPP_PARENT === "electron") {
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
