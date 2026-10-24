// The HTTP API (for the renderer), the hub WebSocket and the MCP endpoint.
import { Data, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { providerIds, type AppDetail, type AppSummary, type HealthResponse, type ProviderId } from "../shared/api";
import { topics } from "../shared/hub";
import { Settings as SettingsSchema } from "../shared/settings";
import { Agent } from "./agent/Agent";
import { Mcp } from "./agent/Mcp";
import { PageContextInput } from "./agent/prompts";
import { Ai, type AiEvent } from "./ai/Ai";
import { AiTokens } from "./ai/AiTokens";
import { ServerConfig } from "./Config";
import { Apps } from "./db/Apps";
import { Settings } from "./db/Settings";
import { Sites } from "./db/Sites";
import { Hub } from "./Hub";
import { Providers } from "./providers/Providers";
import { presetInfo, presets } from "./workspace/presets";
import { Runtime } from "./workspace/Runtime";
import { Workspace } from "./workspace/Workspace";

class HttpFail extends Data.TaggedError("HttpFail")<{ readonly status: number; readonly message: string }> {}

const fail = (status: number, message: string) => Effect.fail(new HttpFail({ status, message }));
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const noContent = HttpServerResponse.empty({ status: 204 });

/** Turns HttpFail (and other expected failures) into JSON error responses. */
const handle = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpFail, R>) =>
  effect.pipe(Effect.catchTag("HttpFail", (e) => Effect.succeed(json({ error: e.message }, e.status))));

const param = (name: string) =>
  Effect.map(HttpRouter.params, (params) => params[name] ?? "");

const body = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* req.text.pipe(Effect.orElseSucceed(() => ""));
  if (!text.trim()) return {} as unknown;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return yield* fail(400, "Invalid JSON");
  }
});

/** The request body decoded with a schema (400 with the problems otherwise). */
const decodeBody = <S extends Schema.Codec<unknown>>(schema: S) =>
  Effect.flatMap(body, (input) => {
    try {
      return Effect.succeed(Schema.decodeUnknownSync(schema)(input) as S["Type"]);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  });

const str = (max: number) => Schema.String.check(Schema.isMaxLength(max));

// --- Auth ----------------------------------------------------------------------------

/**
 * Only gApp's renderer may use the API. Requests need the token Electron gave
 * the renderer, and browsers must come from the renderer's origin: websites in
 * web tabs and apps in previews can reach 127.0.0.1 too.
 */
const guard = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.url, "http://localhost");
      // MCP and AI have tokens of their own (per agent turn, per app).
      if (req.method === "OPTIONS" || url.pathname === "/api/health" || url.pathname.startsWith("/mcp/") || url.pathname.startsWith("/ai/")) {
        return yield* effect;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.allowedOrigin) return json({ error: "Forbidden" }, 403);
      if (config.token) {
        const given = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
        if (given !== config.token) return json({ error: "Unauthorized" }, 401);
      }
      return yield* effect;
    }),
  { global: true },
);

// --- Routes ----------------------------------------------------------------------------

const health = HttpRouter.add(
  "GET",
  "/api/health",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return json({ ok: true, uptime: process.uptime(), bun: Bun.version, dataDir: config.dataDir } satisfies HealthResponse);
  }),
);

const ws = HttpRouter.add(
  "GET",
  "/api/ws",
  Effect.gen(function* () {
    const hub = yield* Hub;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(req.url, "http://localhost");
    const socket = yield* req.upgrade.pipe(Effect.orElseSucceed(() => null));
    if (!socket) return json({ error: "Expected a WebSocket upgrade" }, 426);
    yield* hub.serve(socket, { renderer: url.searchParams.get("role") === "renderer" });
    return noContent;
  }),
);

const mcp = HttpRouter.add(
  "*",
  "/mcp/:token",
  Effect.gen(function* () {
    const server = yield* Mcp;
    const req = yield* HttpServerRequest.HttpServerRequest;
    // Streamable HTTP: we only answer POSTs (with JSON); no server-initiated streams.
    if (req.method === "GET") return HttpServerResponse.empty({ status: 405 });
    if (req.method === "DELETE") return noContent;
    if (req.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const token = yield* param("token");
    const input = yield* req.json.pipe(Effect.orElseSucceed(() => null));
    if (input === null) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const result = yield* server.handle(token, input).pipe(Effect.orElseSucceed(() => "unknown" as const));
    if (result === "unknown") return json({ error: "Unknown session" }, 404);
    return result === null ? HttpServerResponse.empty({ status: 202 }) : json(result);
  }),
);

const providerRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/providers",
    Effect.gen(function* () {
      const providers = yield* Providers;
      return json(yield* providers.list);
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/providers/refresh",
    handle(
      Effect.gen(function* () {
        const providers = yield* Providers;
        const { id } = yield* decodeBody(Schema.Struct({ id: Schema.optionalKey(Schema.Literals(providerIds)) }));
        return json(yield* providers.refresh(id));
      }),
    ),
  ),
]);

const settingsRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/settings",
    Effect.gen(function* () {
      const settings = yield* Settings;
      return json(yield* settings.get());
    }),
  ),
  HttpRouter.route(
    "PUT",
    "/api/settings",
    handle(
      Effect.gen(function* () {
        const settings = yield* Settings;
        const providers = yield* Providers;
        const previous = yield* settings.get();
        const next = yield* decodeBody(SettingsSchema);
        yield* settings.save(next);
        // Re-check providers that were turned on/off or moved.
        for (const id of providerIds) {
          if (JSON.stringify(previous.providers[id]) !== JSON.stringify(next.providers[id])) yield* Effect.forkDetach(providers.refresh(id));
        }
        return json(next);
      }),
    ),
  ),
]);

const presetsRoute = HttpRouter.add("GET", "/api/presets", Effect.succeed(json(presets.map(presetInfo))));

/** An app with everything the renderer shows for it. */
const detail = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* Apps;
    const agent = yield* Agent;
    const workspace = yield* Workspace;
    const runtime = yield* Runtime;
    const app = yield* apps.get(id);
    if (!app) return yield* fail(404, "Not found");
    const { nameLocked: _, session: __, mode: ___, ...summary } = app;
    const isApp = app.kind === "app";
    return {
      ...summary,
      messages: yield* apps.messages(id),
      running: yield* agent.isRunning(id),
      agent: app.agent,
      project: isApp ? yield* workspace.info(id) : null,
      runtime: isApp ? { ...(yield* runtime.status(id)), mode: app.mode } : null,
    } satisfies AppDetail;
  });

const publishApp = (summary: AppSummary | null) =>
  Effect.gen(function* () {
    const hub = yield* Hub;
    if (summary) yield* hub.publish({ type: "app", topic: topics.apps, app: summary });
  });

const appRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/apps",
    Effect.gen(function* () {
      const apps = yield* Apps;
      return json(yield* apps.list());
    }),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const input = yield* decodeBody(
          Schema.Struct({
            kind: Schema.optionalKey(Schema.Literals(["app", "web"])),
            url: Schema.optionalKey(str(8000).check(Schema.isPattern(/^https?:\/\//i, { message: "url must be an http(s) URL" }))),
          }),
        );
        const kind = input.kind ?? "app";
        const app = yield* apps.create(kind, kind === "web" ? (input.url ?? null) : null);
        yield* publishApp(app);
        return json(app, 201);
      }),
    ),
  ),

  HttpRouter.route(
    "GET",
    "/api/apps/:id",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const result = yield* detail(id);
        const settings = yield* Settings;
        // Opening an app starts it (in its mode).
        if (result.kind === "app" && result.project && (yield* settings.get()).apps.autoStart) {
          const runtime = yield* Runtime;
          yield* Effect.forkDetach(runtime.ensure(id));
        }
        return json(result);
      }),
    ),
  ),

  HttpRouter.route(
    "PATCH",
    "/api/apps/:id",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const { name } = yield* decodeBody(Schema.Struct({ name: str(200) }));
        if (!name.trim()) return yield* fail(400, "name is required");
        const app = yield* apps.rename(yield* param("id"), name.trim());
        if (!app) return yield* fail(404, "Not found");
        yield* publishApp(app);
        return json(app);
      }),
    ),
  ),

  HttpRouter.route(
    "DELETE",
    "/api/apps/:id",
    Effect.gen(function* () {
      const id = yield* param("id");
      const apps = yield* Apps;
      const agent = yield* Agent;
      const runtime = yield* Runtime;
      const workspace = yield* Workspace;
      const hub = yield* Hub;
      yield* agent.stop(id);
      yield* runtime.forget(id);
      yield* apps.remove(id);
      yield* workspace.remove(id);
      yield* hub.publish({ type: "app-deleted", topic: topics.apps, appId: id });
      return noContent;
    }),
  ),

  // Web tabs report navigation: URL, page title (renames the tab) and favicon.
  HttpRouter.route(
    "PATCH",
    "/api/apps/:id/page",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const page = yield* decodeBody(
          Schema.Struct({
            url: Schema.optionalKey(str(8000)),
            title: Schema.optionalKey(str(1000)),
            favicon: Schema.optionalKey(Schema.NullOr(str(8000))),
          }),
        );
        const tab = yield* apps.updateWebTab(yield* param("id"), page);
        if (!tab) return yield* fail(404, "Not found");
        return json(tab);
      }),
    ),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/duplicate",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspace = yield* Workspace;
        const id = yield* param("id");
        const copy = yield* apps.duplicate(id);
        if (!copy) return yield* fail(404, "Not found");
        if (copy.kind === "app") yield* workspace.duplicate(id, copy.id);
        yield* publishApp(copy);
        return json(copy, 201);
      }),
    ),
  ),

  HttpRouter.route(
    "DELETE",
    "/api/apps/:id/messages",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const agent = yield* Agent;
        const id = yield* param("id");
        if (!(yield* apps.get(id))) return yield* fail(404, "Not found");
        if (yield* agent.isRunning(id)) return yield* fail(409, "Stop the agent before clearing the chat");
        yield* apps.clearMessages(id);
        return noContent;
      }),
    ),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/chat",
    handle(
      Effect.gen(function* () {
        const agent = yield* Agent;
        const request = yield* decodeBody(
          Schema.Struct({
            prompt: str(100_000),
            agent: Schema.optionalKey(
              Schema.Struct({
                provider: Schema.optionalKey(Schema.Literals(providerIds)),
                model: Schema.optionalKey(Schema.NullOr(str(300))),
                effort: Schema.optionalKey(Schema.NullOr(str(50))),
              }),
            ),
            page: Schema.optionalKey(PageContextInput),
          }),
        );
        if (!request.prompt.trim()) return yield* fail(400, "prompt is required");
        yield* agent
          .start(yield* param("id"), {
            prompt: request.prompt.trim(),
            agent: request.agent as { provider?: ProviderId; model?: string | null; effort?: string | null } | undefined,
            page: request.page as never,
          })
          .pipe(Effect.catchTag("AgentError", (e) => fail(e.status, e.message)));
        return json({ ok: true }, 202);
      }),
    ),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/stop",
    Effect.gen(function* () {
      const agent = yield* Agent;
      yield* agent.stop(yield* param("id"));
      return json({ ok: true });
    }),
  ),
]);

const runtimeRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/apps/:id/runtime",
    Effect.gen(function* () {
      const runtime = yield* Runtime;
      const apps = yield* Apps;
      const id = yield* param("id");
      const app = yield* apps.get(id);
      return json({ status: { ...(yield* runtime.status(id)), mode: app?.mode ?? "dev" }, logs: runtime.logs(id, 500) });
    }),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/runtime",
    handle(
      Effect.gen(function* () {
        const runtime = yield* Runtime;
        const id = yield* param("id");
        const { action } = yield* decodeBody(Schema.Struct({ action: Schema.Literals(["start", "stop", "restart"]) }));
        if (action === "stop") yield* runtime.stop(id);
        else if (action === "start") yield* runtime.ensure(id);
        else yield* runtime.restart(id);
        return json(yield* runtime.status(id));
      }),
    ),
  ),

  // dev: being edited (dev server). live: done (built, start command).
  HttpRouter.route(
    "POST",
    "/api/apps/:id/mode",
    handle(
      Effect.gen(function* () {
        const runtime = yield* Runtime;
        const apps = yield* Apps;
        const id = yield* param("id");
        const { mode } = yield* decodeBody(Schema.Struct({ mode: Schema.Literals(["dev", "live"]) }));
        if (!(yield* apps.get(id))) return yield* fail(404, "Not found");
        return json(yield* runtime.setMode(id, mode));
      }),
    ),
  ),

  // Sets up the project from a preset without the agent (tests, "start from a preset").
  HttpRouter.route(
    "POST",
    "/api/apps/:id/project",
    handle(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const runtime = yield* Runtime;
        const apps = yield* Apps;
        const id = yield* param("id");
        const { preset, name } = yield* decodeBody(Schema.Struct({ preset: str(50), name: Schema.optionalKey(str(80)) }));
        const app = yield* apps.get(id);
        if (!app || app.kind !== "app") return yield* fail(404, "Not found");
        const project = yield* workspace.scaffold(id, preset, name ?? app.name).pipe(Effect.catchTag("WorkspaceError", (e) => fail(400, e.message)));
        if (name) yield* publishApp(yield* apps.setInfo(id, { name }));
        yield* runtime.setMode(id, "dev");
        return json(project, 201);
      }),
    ),
  ),
]);

const siteRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/sites",
    Effect.gen(function* () {
      const sites = yield* Sites;
      return json(yield* sites.list());
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/sites/:host",
    Effect.gen(function* () {
      const sites = yield* Sites;
      return json(yield* sites.get(yield* param("host")));
    }),
  ),
  HttpRouter.route(
    "PUT",
    "/api/sites/:host",
    handle(
      Effect.gen(function* () {
        const sites = yield* Sites;
        const hub = yield* Hub;
        const fields = yield* decodeBody(
          Schema.Struct({
            css: Schema.optionalKey(str(200_000)),
            js: Schema.optionalKey(str(200_000)),
            enabled: Schema.optionalKey(Schema.Boolean),
          }),
        );
        const saved = yield* sites.save(yield* param("host"), fields);
        yield* hub.publish({ type: "site", topic: topics.sites, host: saved.host });
        return json(saved);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/sites/:host",
    Effect.gen(function* () {
      const sites = yield* Sites;
      const hub = yield* Hub;
      const host = yield* param("host");
      yield* sites.remove(host);
      yield* hub.publish({ type: "site", topic: topics.sites, host });
      return noContent;
    }),
  ),
]);

// --- AI for apps ------------------------------------------------------------------------

/** The app making an AI request: from its token, and only from its server (never a browser). */
const aiApp = Effect.gen(function* () {
  const tokens = yield* AiTokens;
  const req = yield* HttpServerRequest.HttpServerRequest;
  if (req.headers.origin !== undefined) {
    return yield* fail(403, "AI requests must come from the app's server, not from the browser. Call your server, and let it call gApp.");
  }
  const appId = tokens.appFor(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  if (!appId) return yield* fail(401, "Missing or invalid GAPP_AI_TOKEN");
  return appId;
});

const AiChatBody = Schema.Struct({
  prompt: Schema.optionalKey(str(200_000)),
  messages: Schema.optionalKey(
    Schema.Array(Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: str(200_000) })).check(Schema.isMaxLength(200)),
  ),
  system: Schema.optionalKey(str(50_000)),
  model: Schema.optionalKey(str(300)),
  effort: Schema.optionalKey(str(50)),
  json: Schema.optionalKey(Schema.Boolean),
  stream: Schema.optionalKey(Schema.Boolean),
});

/** The reply as JSON, if it is JSON (models like to wrap it in code fences). */
function parseJson(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

const aiRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/ai/v1/models",
    handle(
      Effect.gen(function* () {
        const appId = yield* aiApp;
        const ai = yield* Ai;
        return json(yield* ai.info(appId));
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/ai/v1/chat",
    handle(
      Effect.gen(function* () {
        const appId = yield* aiApp;
        const ai = yield* Ai;
        const input = yield* decodeBody(AiChatBody);
        const messages = input.messages ?? (input.prompt !== undefined ? [{ role: "user" as const, content: input.prompt }] : []);
        const request = { messages, system: input.system, model: input.model, effort: input.effort, json: input.json };
        const stream = yield* ai.chat(appId, request).pipe(Effect.catchTag("AiError", (e) => fail(e.status, e.message)));

        if (input.stream) {
          // Newline-delimited JSON: {"type":"delta","text"}…, then {"type":"done",…} or {"type":"error",…}.
          const lines = stream.pipe(
            Stream.map((event) => (event.type === "done" && input.json ? { ...event, json: parseJson(event.text) } : event)),
            Stream.catchTag("AiError", (e) => Stream.make({ type: "error", status: e.status, message: e.message })),
            Stream.map((event) => `${JSON.stringify(event)}\n`),
            Stream.encodeText,
          );
          return HttpServerResponse.stream(lines, { contentType: "application/x-ndjson" });
        }

        const done = yield* stream.pipe(
          Stream.runFold(
            () => null as Extract<AiEvent, { type: "done" }> | null,
            (last, event) => (event.type === "done" ? event : last),
          ),
          Effect.catchTag("AiError", (e) => fail(e.status, e.message)),
        );
        if (!done) return yield* fail(503, "No answer");
        return json({ text: done.text, ...(input.json ? { json: parseJson(done.text) } : {}), provider: done.provider, model: done.model });
      }),
    ),
  ),
]);

export const routes = Layer.mergeAll(health, ws, mcp, providerRoutes, settingsRoutes, presetsRoute, appRoutes, runtimeRoutes, siteRoutes, aiRoutes, guard);

export const cors = (allowedOrigin: string) =>
  HttpRouter.cors({
    allowedOrigins: [allowedOrigin],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  });
