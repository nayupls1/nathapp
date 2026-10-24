// The HTTP API (for the renderer), the hub WebSocket and the MCP endpoint.
import { Data, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  appOfTarget,
  appTarget,
  providerIds,
  workspaceOfScope,
  workspaceScope,
  type AppActionInfo,
  type AppActionResult,
  type AppDetail,
  type AppSummary,
  type HealthResponse,
  type PermissionAction,
  type ProviderId,
  type SecretsOverview,
} from "../shared/api";
import { topics } from "../shared/hub";
import { Settings as SettingsSchema, WorkspaceSettings } from "../shared/settings";
import { Agent } from "./agent/Agent";
import { Mcp } from "./agent/Mcp";
import { PageContextInput } from "./agent/prompts";
import { Ai, type AiEvent } from "./ai/Ai";
import { AiTokens } from "./ai/AiTokens";
import { Audit } from "./security/Audit";
import { Permissions, WEBSITE_AGENT } from "./security/Permissions";
import { Secrets } from "./security/Secrets";
import { ServerConfig } from "./Config";
import { Apps } from "./db/Apps";
import { Settings } from "./db/Settings";
import { Sites } from "./db/Sites";
import { Workspaces } from "./db/Workspaces";
import { History, type By } from "./history/History";
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
 * Only NathApp's renderer may use the API. Requests need the token Electron gave
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
        yield* snapshot("settings", "Changed settings", true);
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

/** A snapshot of something the user changed in the UI (folded together while they keep changing it). */
const snapshot = (target: "settings" | "sites" | `app:${string}`, summary: string, coalesce = false) =>
  Effect.gen(function* () {
    const history = yield* History;
    const by: By = { actor: "user", actorLabel: "You", summary, coalesceMs: coalesce ? 10 * 60 * 1000 : undefined };
    yield* history.record(target, by);
  });

/** Deletes a tab with everything that belongs to it: chat, project folder, secrets, permissions, history. */
const removeApp = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* Apps;
    const agent = yield* Agent;
    const runtime = yield* Runtime;
    const workspace = yield* Workspace;
    const secrets = yield* Secrets;
    const permissions = yield* Permissions;
    const hub = yield* Hub;
    yield* agent.stop(id);
    yield* runtime.forget(id);
    yield* apps.remove(id);
    yield* workspace.remove(id);
    yield* secrets.removeScope(id);
    yield* permissions.forget(id);
    yield* (yield* History).forget(appTarget(id));
    yield* hub.publish({ type: "app-deleted", topic: topics.apps, appId: id });
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
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(
          Schema.Struct({
            kind: Schema.optionalKey(Schema.Literals(["app", "web"])),
            url: Schema.optionalKey(str(8000).check(Schema.isPattern(/^https?:\/\//i, { message: "url must be an http(s) URL" }))),
            workspaceId: Schema.optionalKey(str(100)),
          }),
        );
        const space = input.workspaceId ? yield* workspaces.get(input.workspaceId) : yield* workspaces.first();
        if (!space) return yield* fail(404, "No such workspace");
        const kind = input.kind ?? "app";
        const app = yield* apps.create(space.id, kind, kind === "web" ? (input.url ?? null) : null);
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
      yield* removeApp(yield* param("id"));
      return noContent;
    }),
  ),

  // Moving a tab to another workspace: it gets that workspace's secrets and permissions.
  HttpRouter.route(
    "POST",
    "/api/apps/:id/move",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const runtime = yield* Runtime;
        const id = yield* param("id");
        const { workspaceId } = yield* decodeBody(Schema.Struct({ workspaceId: str(100) }));
        const target = yield* workspaces.get(workspaceId);
        if (!target) return yield* fail(404, "No such workspace");
        const app = yield* apps.get(id);
        if (!app) return yield* fail(404, "Not found");
        if (app.workspaceId === workspaceId) return json(app);
        const moved = yield* apps.move(id, workspaceId);
        yield* youDid(id, "tab.move", target.name);
        yield* publishApp(moved);
        if (app.kind === "app") {
          const status = yield* runtime.status(id);
          if (status.state !== "stopped" && status.state !== "crashed") yield* Effect.forkDetach(runtime.restart(id));
        }
        return json(moved);
      }),
    ),
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
        yield* youDid(id, `runtime.${action}`, null);
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
        yield* youDid(id, "runtime.mode", mode);
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
        yield* snapshot(appTarget(id), `Started from the ${preset} template`);
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
        yield* snapshot("sites", `Changed the customizations of ${saved.host}`, true);
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
      yield* snapshot("sites", `Removed the customizations of ${host}`);
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
    return yield* fail(403, "AI requests must come from the app's server, not from the browser. Call your server, and let it call NathApp.");
  }
  const appId = tokens.appFor(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  if (!appId) return yield* fail(401, "Missing or invalid NATHAPP_AI_TOKEN");
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

// --- App actions (command bar) ----------------------------------------------------------------

const actionRoutes = HttpRouter.addAll([
  // Every app's actions, from their nathapp.json.
  HttpRouter.route(
    "GET",
    "/api/actions",
    Effect.gen(function* () {
      const apps = yield* Apps;
      const workspace = yield* Workspace;
      const list: AppActionInfo[] = [];
      for (const app of yield* apps.list()) {
        if (app.kind !== "app") continue;
        const manifest = yield* workspace.manifest(app.id).pipe(Effect.orElseSucceed(() => null));
        for (const action of manifest?.actions ?? []) {
          list.push({ appId: app.id, workspaceId: app.workspaceId, appName: app.name, appIcon: app.icon, action });
        }
      }
      return json(list);
    }),
  ),
  // Runs an endpoint action: POSTs { input } to the app's own server (started if needed).
  HttpRouter.route(
    "POST",
    "/api/apps/:id/actions/:action",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspace = yield* Workspace;
        const runtime = yield* Runtime;
        const audit = yield* Audit;
        const id = yield* param("id");
        const actionId = yield* param("action");
        const { input } = yield* decodeBody(Schema.Struct({ input: Schema.optionalKey(Schema.NullOr(str(4000))) }));
        const app = yield* apps.get(id);
        if (!app || app.kind !== "app") return yield* fail(404, "Not found");
        const manifest = yield* workspace.manifest(id).pipe(Effect.orElseSucceed(() => null));
        const action = manifest?.actions?.find((a) => a.id === actionId);
        if (!action) return yield* fail(404, "The app doesn't offer this action (anymore)");
        if (!action.endpoint) return yield* fail(400, "This action opens the app; it isn't run");
        yield* runtime.ensure(id);
        const status = yield* runtime.settled(id, 90_000);
        if (status.state !== "running" || !status.url) return yield* fail(409, `${app.name} isn't running${status.error ? `: ${status.error}` : ""}`);
        const response = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${status.url}${action.endpoint}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ input: input ?? null }),
              signal: AbortSignal.timeout(30_000),
            });
            const text = (await res.text()).slice(0, 8000);
            let message = text.trim();
            try {
              const body = JSON.parse(text) as { message?: unknown; error?: unknown };
              if (typeof body.message === "string") message = body.message;
              else if (typeof body.error === "string") message = body.error;
            } catch {
              // plain text
            }
            return { ok: res.ok, status: res.status, message: message.slice(0, 500) } satisfies AppActionResult;
          },
          catch: (err) => new HttpFail({ status: 502, message: `${app.name} didn't answer: ${err instanceof Error ? err.message : String(err)}` }),
        });
        yield* audit.record({
          actor: "user",
          actorLabel: "You",
          tabId: id,
          action: "app.action",
          target: action.title,
          outcome: response.ok ? "ok" : "error",
          detail: response.ok ? null : `HTTP ${response.status}`,
        });
        return json(response);
      }),
    ),
  ),
]);

// --- History -------------------------------------------------------------------------------

const historyTarget = Schema.Union([
  Schema.Literals(["sites", "settings"]),
  str(200).check(Schema.isPattern(/^app:[\w-]+$/, { message: "target must be sites, settings or app:<id>" })),
]);

/** Restoring an app while its agent works on it would pull the files from under it. */
const ensureAgentIdle = (target: string) =>
  Effect.gen(function* () {
    const appId = appOfTarget(target);
    if (appId && (yield* (yield* Agent).isRunning(appId))) return yield* fail(409, "Stop the agent before restoring");
  });

const historyRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/history",
    Effect.gen(function* () {
      const history = yield* History;
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(
        yield* history.list({
          target: params.get("target") ?? undefined,
          workspaceId: params.get("workspace") ?? undefined,
          before: params.get("before") ? Number(params.get("before")) : undefined,
          limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        }),
      );
    }),
  ),
  // A snapshot right now (e.g. before trying something by hand).
  HttpRouter.route(
    "POST",
    "/api/history",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const { target } = yield* decodeBody(Schema.Struct({ target: historyTarget }));
        const entry = yield* history.record(target as `app:${string}`, { actor: "user", actorLabel: "You", summary: "Saved a snapshot" });
        return entry ? json(entry, 201) : noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/history/:id",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const detail = yield* history.detail(Number(yield* param("id"))).pipe(Effect.catchTag("HistoryError", (e) => fail(e.status, e.message)));
        return json(detail);
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/history/:id/restore",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const { data } = yield* decodeBody(Schema.Struct({ data: Schema.optionalKey(Schema.Boolean) }));
        const entry = yield* history.entry(Number(yield* param("id"))).pipe(Effect.catchTag("HistoryError", (e) => fail(e.status, e.message)));
        yield* ensureAgentIdle(entry.target);
        // The data goes back only when asked: what was added since would be lost.
        yield* history.restore(entry.id, { data: data ?? false }).pipe(Effect.catchTag("HistoryError", (e) => fail(e.status, e.message)));
        yield* youDid(entry.tabId, "history.restore", entry.summary, `${entry.target} · ${entry.at}${data ? " · with its data" : ""}`);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/history/:id/undo",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const { data } = yield* decodeBody(Schema.Struct({ data: Schema.optionalKey(Schema.Boolean) }));
        const entry = yield* history.entry(Number(yield* param("id"))).pipe(Effect.catchTag("HistoryError", (e) => fail(e.status, e.message)));
        yield* ensureAgentIdle(entry.target);
        const result = yield* history.undo(entry.id, { data: data ?? false }).pipe(Effect.catchTag("HistoryError", (e) => fail(e.status, e.message)));
        yield* youDid(entry.tabId, "history.undo", entry.summary, `${entry.target}${data ? " · with its data" : ""}`);
        return json(result);
      }),
    ),
  ),
]);

// --- Workspaces ----------------------------------------------------------------------------

const publishWorkspace = (id: string) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const hub = yield* Hub;
    const space = yield* workspaces.get(id);
    if (space) yield* hub.publish({ type: "workspace", topic: topics.workspaces, workspace: space });
    return space;
  });

const workspaceName = str(80).check(Schema.isPattern(/\S/, { message: "name is required" }));

const workspaceRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/workspaces",
    Effect.gen(function* () {
      const workspaces = yield* Workspaces;
      return json(yield* workspaces.list());
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/workspaces",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(Schema.Struct({ name: workspaceName, icon: Schema.optionalKey(Schema.NullOr(str(80))) }));
        const created = yield* workspaces.create(input.name.trim(), input.icon ?? null);
        yield* publishWorkspace(created.id);
        yield* snapshot("settings", `Created the workspace ${created.name}`);
        return json(created, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/workspaces/:id",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(
          Schema.Struct({
            name: Schema.optionalKey(workspaceName),
            icon: Schema.optionalKey(Schema.NullOr(str(80))),
            settings: Schema.optionalKey(WorkspaceSettings),
          }),
        );
        const id = yield* param("id");
        const updated = yield* workspaces.update(id, { ...input, name: input.name?.trim() });
        if (!updated) return yield* fail(404, "Not found");
        yield* snapshot("settings", `Changed the workspace ${updated.name}`, true);
        return json(yield* publishWorkspace(id));
      }),
    ),
  ),
  // Deletes the workspace with its tabs (and their data), its secrets and its permissions.
  HttpRouter.route(
    "DELETE",
    "/api/workspaces/:id",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const secrets = yield* Secrets;
        const permissions = yield* Permissions;
        const hub = yield* Hub;
        const id = yield* param("id");
        const space = yield* workspaces.get(id);
        if (!space) return yield* fail(404, "Not found");
        if ((yield* workspaces.count()) <= 1) return yield* fail(400, "The last workspace can't be deleted");
        for (const appId of yield* workspaces.appIds(id)) yield* removeApp(appId);
        yield* secrets.removeScope(workspaceScope(id));
        yield* permissions.forget(workspaceScope(id));
        yield* workspaces.remove(id);
        yield* youDid(null, "workspace.delete", space.name);
        yield* snapshot("settings", `Deleted the workspace ${space.name}`);
        yield* hub.publish({ type: "workspace-deleted", topic: topics.workspaces, workspaceId: id });
        return noContent;
      }),
    ),
  ),
]);

// --- Secrets, permissions and the audit log ----------------------------------------------

/**
 * An audit entry for something the user did in the UI. `where`: a tab id, a
 * secret scope or permission subject ("global", "workspace:<id>",
 * "website-agent"), or null.
 */
const youDid = (where: string | null, action: string, target: string | null, detail: string | null = null) =>
  Effect.gen(function* () {
    const audit = yield* Audit;
    const workspaceId = where ? workspaceOfScope(where) : null;
    const tabId = where && !workspaceId && where !== "global" && where !== WEBSITE_AGENT ? where : null;
    yield* audit.record({ actor: "user", actorLabel: "You", tabId, workspaceId, action, target, detail });
  });

/** "global KEY", "workspace KEY", "app KEY" for the audit log. */
const secretLabel = (scope: string, name: string) => `${scope === "global" ? "global" : workspaceOfScope(scope) ? "workspace" : "app"} ${name}`;

/**
 * Running apps that use a secret get restarted, so their environment changes
 * right away. `scope`: the secret's scope, or the subject of a permission.
 */
const restartUsers = (scope: string, name: string) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const permissions = yield* Permissions;
    const apps = yield* Apps;
    const workspaces = yield* Workspaces;
    const space = workspaceOfScope(scope);
    let appIds: string[];
    if (scope === "global") {
      appIds = [];
      for (const app of yield* apps.list()) {
        if (app.kind === "app" && (yield* permissions.decision(app.id, "app.secret", name)) === "allow") appIds.push(app.id);
      }
    } else appIds = space ? yield* workspaces.appIds(space) : [scope];
    for (const id of appIds) {
      const status = yield* runtime.status(id);
      if (status.state !== "stopped" && status.state !== "crashed") yield* Effect.forkDetach(runtime.restart(id));
    }
  });

const secretRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/secrets",
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const scope = new URL(req.url, "http://localhost").searchParams.get("scope") ?? undefined;
      return json({ protection: secrets.protection, secrets: yield* secrets.list(scope) } satisfies SecretsOverview);
    }),
  ),
  HttpRouter.route(
    "PUT",
    "/api/secrets",
    handle(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(Schema.Struct({ scope: str(150), name: str(100), value: str(70_000) }));
        const space = workspaceOfScope(input.scope);
        if (space) {
          if (!(yield* workspaces.get(space))) return yield* fail(404, "No such workspace");
        } else if (input.scope !== "global") {
          const app = yield* apps.get(input.scope);
          if (!app || app.kind !== "app") return yield* fail(404, "No such app");
        }
        const existed = (yield* secrets.list(input.scope)).some((x) => x.name === input.name);
        const saved = yield* secrets.set(input.scope, input.name, input.value).pipe(Effect.catchTag("SecretError", (e) => fail(400, e.message)));
        yield* youDid(input.scope, existed ? "secret.replace" : "secret.create", secretLabel(input.scope, input.name));
        yield* restartUsers(input.scope, input.name);
        return json(saved);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/secrets/:id",
    handle(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const removed = yield* secrets.remove(yield* param("id"));
        if (!removed) return yield* fail(404, "Not found");
        yield* youDid(removed.scope, "secret.delete", secretLabel(removed.scope, removed.name));
        yield* restartUsers(removed.scope, removed.name);
        return noContent;
      }),
    ),
  ),
]);

const permissionActions = ["app.ai", "app.secret", "agent.site"] as const satisfies readonly PermissionAction[];

const permissionRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/permissions",
    Effect.gen(function* () {
      const permissions = yield* Permissions;
      return json(yield* permissions.list);
    }),
  ),
  // Granting from the UI (e.g. letting an app use a global secret).
  HttpRouter.route(
    "PUT",
    "/api/permissions",
    handle(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        const input = yield* decodeBody(
          Schema.Struct({ subject: str(100), action: Schema.Literals(permissionActions), resource: str(300), decision: Schema.Literals(["allow", "deny"]) }),
        );
        yield* permissions.set(input.subject, input.action, input.resource, input.decision);
        yield* youDid(input.subject, `permission.${input.decision}`, `${input.action}${input.resource ? ` ${input.resource}` : ""}`);
        if (input.action === "app.secret") yield* restartUsers(input.subject, input.resource);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/permissions/:id",
    handle(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        const id = Number(yield* param("id"));
        const revoked = yield* permissions.revoke(id);
        if (!revoked) return yield* fail(404, "Not found");
        yield* youDid(revoked.subject, "permission.revoke", `${revoked.action}${revoked.resource ? ` ${revoked.resource}` : ""}`, revoked.subjectName);
        if (revoked.action === "app.secret") yield* restartUsers(revoked.subject, revoked.resource);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/permissions/pending",
    Effect.gen(function* () {
      const permissions = yield* Permissions;
      return json(yield* permissions.pending);
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/permissions/pending/:id",
    handle(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        // remember: true (this app or agent) or "workspace" (every app in its workspace).
        const { allow, remember } = yield* decodeBody(
          Schema.Struct({ allow: Schema.Boolean, remember: Schema.Union([Schema.Boolean, Schema.Literal("workspace")]) }),
        );
        const scope = remember === "workspace" ? "workspace" : remember ? "subject" : false;
        if (!(yield* permissions.answer(yield* param("id"), allow, scope))) return yield* fail(404, "The request is no longer waiting");
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/audit",
    Effect.gen(function* () {
      const audit = yield* Audit;
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      const actor = params.get("actor");
      return json(
        yield* audit.list({
          tabId: params.get("tab") ?? undefined,
          workspaceId: params.get("workspace") ?? undefined,
          actor: actor === "user" || actor === "agent" || actor === "app" || actor === "nathapp" ? actor : undefined,
          before: params.get("before") ? Number(params.get("before")) : undefined,
          limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        }),
      );
    }),
  ),
]);

export const routes = Layer.mergeAll(health, ws, mcp, providerRoutes, settingsRoutes, presetsRoute, appRoutes, workspaceRoutes, historyRoutes, actionRoutes, runtimeRoutes, siteRoutes, aiRoutes, secretRoutes, permissionRoutes, guard);

export const cors = (allowedOrigin: string) =>
  HttpRouter.cors({
    allowedOrigins: [allowedOrigin],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  });
