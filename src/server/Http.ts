// The HTTP API (for the renderer), the hub WebSocket and the MCP endpoint.
import { Data, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  appOfTarget,
  appTarget,
  IMAGE_ICON_MAX,
  IMAGE_ICON_PATTERN,
  isEmojiIcon,
  isImageIcon,
  providerIds,
  workspaceOfScope,
  workspaceScope,
  type AppActionInfo,
  type AppActionResult,
  type NetworkRule,
  type ReplayOverrides,
  type ReplayResult,
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
import { MAX_SHARED_TABS, SharedTabInput } from "./agent/sharedTabs";
import { Ai, type AiEvent } from "./ai/Ai";
import { AiTokens } from "./ai/AiTokens";
import { Audit } from "./security/Audit";
import { Permissions, WEBSITE_AGENT } from "./security/Permissions";
import { Secrets } from "./security/Secrets";
import { ServerConfig } from "./Config";
import { Apps } from "./db/Apps";
import { isIcon } from "./icons";
import { Network } from "./db/Network";
import { Settings } from "./db/Settings";
import { PageChanges, pageChangeError } from "./db/PageChanges";
import { ScheduleError, Scheduler } from "./scheduler/Scheduler";
import { Sites } from "./db/Sites";
import { Workspaces } from "./db/Workspaces";
import { History, type By } from "./history/History";
import { Hub } from "./Hub";
import { Providers } from "./providers/Providers";
import { presetInfo, presets } from "./workspace/presets";
import { AppData, type RowQuery } from "./workspace/AppData";
import { AppTools, type ToolCaller } from "./workspace/AppTools";
import { Projects } from "./workspace/Projects";
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
      // MCP, AI and the app API have tokens of their own (per agent turn, per app).
      if (
        req.method === "OPTIONS" ||
        url.pathname === "/api/health" ||
        url.pathname.startsWith("/mcp/") ||
        url.pathname.startsWith("/ai/") ||
        url.pathname.startsWith("/app-api/")
      ) {
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
    yield* (yield* Projects).publish(summary);
  });

/** A snapshot of something the user changed in the UI (folded together while they keep changing it). */
const snapshot = (target: "settings" | "sites" | `app:${string}`, summary: string, coalesce = false) =>
  Effect.gen(function* () {
    const history = yield* History;
    const by: By = { actor: "user", actorLabel: "You", summary, coalesceMs: coalesce ? 10 * 60 * 1000 : undefined };
    yield* history.record(target, by);
  });

/** Deletes a tab with everything that belongs to it (Projects.remove), its agent stopped first. */
const removeApp = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Agent).stop(id);
    yield* (yield* Projects).remove(id);
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
            // Extension pages (options, tabs extensions open) are web tabs too.
            url: Schema.optionalKey(str(8000).check(Schema.isPattern(/^(https?:\/\/|chrome-extension:\/\/[a-p]{32}\/)/i, { message: "url must be an http(s) URL" }))),
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
        // Opening an app starts it (in its mode).
        yield* (yield* Projects).opened(id);
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

  // The tab's own icon (a Lucide name, an emoji or a small image), or null for the default.
  HttpRouter.route(
    "PUT",
    "/api/apps/:id/icon",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const { icon } = yield* decodeBody(Schema.Struct({ icon: Schema.NullOr(str(IMAGE_ICON_MAX)) }));
        if (icon !== null && !(isImageIcon(icon) ? IMAGE_ICON_PATTERN.test(icon) : isIcon(icon) || isEmojiIcon(icon))) {
          return yield* fail(400, "icon must be a Lucide icon name, an emoji or a base64 image data URL");
        }
        const app = yield* apps.setIcon(yield* param("id"), icon);
        if (!app) return yield* fail(404, "Not found");
        yield* publishApp(app);
        return json(app);
      }),
    ),
  ),

  // Pinned tabs stay loaded (the renderer unloads idle tabs, see lib/unload.ts).
  HttpRouter.route(
    "PUT",
    "/api/apps/:id/pinned",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const { pinned } = yield* decodeBody(Schema.Struct({ pinned: Schema.Boolean }));
        const app = yield* apps.setPinned(yield* param("id"), pinned);
        if (!app) return yield* fail(404, "Not found");
        yield* publishApp(app);
        return json(app);
      }),
    ),
  ),

  // Moving a tab to another workspace: it gets that workspace's secrets and permissions.
  HttpRouter.route(
    "POST",
    "/api/apps/:id/move",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const id = yield* param("id");
        const { workspaceId } = yield* decodeBody(Schema.Struct({ workspaceId: str(100) }));
        const target = yield* workspaces.get(workspaceId);
        if (!target) return yield* fail(404, "No such workspace");
        const app = yield* apps.get(id);
        if (!app) return yield* fail(404, "Not found");
        if (app.workspaceId === workspaceId) return json(app);
        const moved = yield* (yield* Projects).move(id, workspaceId);
        yield* youDid(id, "tab.move", target.name);
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
        const copy = yield* (yield* Projects).copy(yield* param("id"));
        if (!copy) return yield* fail(404, "Not found");
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
            shared: Schema.optionalKey(Schema.Array(SharedTabInput).check(Schema.isMaxLength(MAX_SHARED_TABS))),
          }),
        );
        if (!request.prompt.trim()) return yield* fail(400, "prompt is required");
        yield* agent
          .start(yield* param("id"), {
            prompt: request.prompt.trim(),
            agent: request.agent as { provider?: ProviderId; model?: string | null; effort?: string | null } | undefined,
            page: request.page as never,
            shared: request.shared,
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
        const apps = yield* Apps;
        const id = yield* param("id");
        const { preset, name } = yield* decodeBody(Schema.Struct({ preset: str(50), name: Schema.optionalKey(str(80)) }));
        const app = yield* apps.get(id);
        if (!app || app.kind !== "app") return yield* fail(404, "Not found");
        const project = yield* (yield* Projects)
          .create(id, preset, { name, by: { actor: "user", actorLabel: "You" } })
          .pipe(Effect.catchTag("WorkspaceError", (e) => fail(400, e.message)));
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

// --- Page changes (web tabs) -------------------------------------------------------------

export const PageChangeBody = Schema.Struct({
  title: str(120),
  scope: Schema.Struct({ type: Schema.Literals(["page", "site", "pattern"]), value: str(500) }),
  action: Schema.Literals(["hide", "style", "text", "attribute", "insert", "button", "css", "script"]),
  selector: Schema.optionalKey(str(2000)),
  value: Schema.optionalKey(str(100_000)),
  name: Schema.optionalKey(str(200)),
  position: Schema.optionalKey(Schema.Literals(["before", "after", "prepend", "append"])),
  onClick: Schema.optionalKey(str(50_000)),
});

const pageChangeRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/page-changes",
    Effect.gen(function* () {
      return json(yield* (yield* PageChanges).list());
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/page-changes",
    handle(
      Effect.gen(function* () {
        const spec = yield* decodeBody(PageChangeBody);
        const problem = pageChangeError(spec);
        if (problem) return yield* fail(400, problem);
        const change = yield* (yield* PageChanges).create(spec, "user");
        yield* (yield* Hub).publish({ type: "page-changes", topic: topics.sites });
        yield* snapshot("sites", `Added the page change “${change.title}”`);
        return json(change);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/page-changes/:id",
    handle(
      Effect.gen(function* () {
        const { enabled, change: spec } = yield* decodeBody(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean), change: Schema.optionalKey(PageChangeBody) }));
        if (spec) {
          const problem = pageChangeError(spec);
          if (problem) return yield* fail(400, problem);
        }
        const saved = yield* (yield* PageChanges).update(yield* param("id"), { spec, enabled });
        if (!saved) return yield* fail(404, "Not found");
        yield* (yield* Hub).publish({ type: "page-changes", topic: topics.sites });
        const summary = spec ? `Changed the page change “${saved.title}”` : `Turned ${saved.enabled ? "on" : "off"} “${saved.title}”`;
        yield* snapshot("sites", summary, true);
        return json(saved);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/page-changes/:id",
    handle(
      Effect.gen(function* () {
        const changes = yield* PageChanges;
        const change = yield* changes.get(yield* param("id"));
        if (!change) return yield* fail(404, "Not found");
        yield* changes.remove(change.id);
        yield* (yield* Hub).publish({ type: "page-changes", topic: topics.sites });
        yield* snapshot("sites", `Removed the page change “${change.title}”`);
        return noContent;
      }),
    ),
  ),
]);

// --- Schedules -----------------------------------------------------------------------------

export const ScheduleBody = Schema.Struct({
  name: str(100),
  trigger: Schema.Union([
    Schema.Struct({ type: Schema.Literal("once"), at: str(40) }),
    Schema.Struct({ type: Schema.Literal("cron"), cron: str(100) }),
    Schema.Struct({ type: Schema.Literal("event"), event: str(200) }),
  ]),
  task: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("tool"),
      appId: str(64),
      tool: str(80),
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      input: Schema.optionalKey(str(4000)),
    }),
    Schema.Struct({ type: Schema.Literal("command"), appId: str(64), command: str(2000) }),
  ]),
  notify: Schema.Literals(["always", "failure", "never"]),
  timeoutSec: Schema.Finite,
});

const scheduleFail = <A, R>(effect: Effect.Effect<A, ScheduleError, R>) => effect.pipe(Effect.catchTag("ScheduleError", (e) => fail(e.status, e.message)));

const scheduleRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/schedules",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(yield* (yield* Scheduler).list({ workspaceId: params.get("workspace") ?? undefined, appId: params.get("app") ?? undefined }));
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/schedules/runs",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(
        yield* (yield* Scheduler).runs({
          scheduleId: params.get("schedule") ?? undefined,
          workspaceId: params.get("workspace") ?? undefined,
          before: Number(params.get("before")) || undefined,
          limit: Number(params.get("limit")) || undefined,
        }),
      );
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/schedules/upcoming",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(yield* (yield* Scheduler).upcoming({ workspaceId: params.get("workspace") ?? undefined, limit: Number(params.get("limit")) || undefined }));
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/schedules",
    handle(
      Effect.gen(function* () {
        const spec = yield* decodeBody(ScheduleBody);
        const schedule = yield* scheduleFail((yield* Scheduler).create(spec, { by: "user" }));
        yield* youDid(spec.task.appId, "schedule.create", schedule.name);
        return json(schedule);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/schedules/:id",
    handle(
      Effect.gen(function* () {
        const { spec, paused } = yield* decodeBody(Schema.Struct({ spec: Schema.optionalKey(ScheduleBody), paused: Schema.optionalKey(Schema.Boolean) }));
        return json(yield* scheduleFail((yield* Scheduler).update(yield* param("id"), { spec, paused })));
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/schedules/:id",
    handle(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const schedule = yield* scheduler.get(yield* param("id"));
        if (!schedule) return yield* fail(404, "Not found");
        yield* scheduler.remove(schedule.id);
        yield* youDid(schedule.task.appId, "schedule.delete", schedule.name);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/schedules/:id/run",
    handle(
      Effect.gen(function* () {
        return json(yield* scheduleFail((yield* Scheduler).runNow(yield* param("id"))));
      }),
    ),
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

// --- Managed app data -------------------------------------------------------------------------

/** Paging, search, order and filters from the query string (`where.<column>=value`). */
const rowQuery = Effect.gen(function* () {
  const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
  const where: Record<string, string> = {};
  for (const [key, value] of params) if (key.startsWith("where.")) where[key.slice(6)] = value;
  const number = (name: string) => (params.get(name) ? Number(params.get(name)) || 0 : undefined);
  return {
    offset: number("offset"),
    limit: number("limit"),
    search: params.get("search") ?? undefined,
    orderBy: params.get("order") ?? undefined,
    desc: params.get("desc") === "1" || params.get("desc") === "true",
    where,
  } satisfies RowQuery;
});

const requireApp = (id: string) =>
  Effect.gen(function* () {
    const app = yield* (yield* Apps).get(id);
    if (!app || app.kind !== "app") return yield* fail(404, "Not found");
    return app;
  });

const dataRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/apps/:id/data",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        yield* requireApp(id);
        return json(yield* (yield* AppData).overview(id));
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/apps/:id/data/tables/:table",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        yield* requireApp(id);
        const table = decodeURIComponent(yield* param("table"));
        const rows = yield* (yield* AppData).rows(id, table, yield* rowQuery).pipe(Effect.catchTag("AppDataError", (e) => fail(e.status, e.message)));
        return json(rows);
      }),
    ),
  ),
  // Everything the app stored, as a .tar.gz (database, tables as JSON, files).
  HttpRouter.route(
    "GET",
    "/api/apps/:id/data/export",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const app = yield* requireApp(id);
        const bytes = yield* (yield* AppData).exportArchive(id);
        yield* youDid(id, "data.export", app.name, `${bytes.byteLength} bytes`);
        const name = `${app.name.replace(/[^\w .-]/g, "").trim().replace(/\s+/g, "-") || "app"}-data.tar.gz`;
        return HttpServerResponse.uint8Array(bytes, {
          contentType: "application/gzip",
          headers: { "Content-Disposition": `attachment; filename="${name}"` },
        });
      }),
    ),
  ),
  // Deletes the app's database and files. A snapshot first, so History can bring them back.
  HttpRouter.route(
    "DELETE",
    "/api/apps/:id/data",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const app = yield* requireApp(id);
        const runtime = yield* Runtime;
        const history = yield* History;
        if (yield* (yield* Agent).isRunning(id)) return yield* fail(409, "Stop the agent before deleting the app's data");
        yield* history.record(appTarget(id), { actor: "nathapp", actorLabel: "NathApp", summary: "Before deleting the app's data" });
        const status = yield* runtime.status(id);
        yield* runtime.stop(id);
        yield* (yield* AppData).clear(id);
        yield* history.record(appTarget(id), { actor: "user", actorLabel: "You", summary: "Deleted the app's data" });
        yield* youDid(id, "data.delete", app.name);
        runtime.note(id, "Its data was deleted");
        if (status.state !== "stopped") yield* Effect.forkDetach(runtime.restart(id));
        return noContent;
      }),
    ),
  ),
]);

/** The app calling NathApp's app API: from its token, and only from its server (never a browser). */
const apiApp = Effect.gen(function* () {
  const tokens = yield* AiTokens;
  const req = yield* HttpServerRequest.HttpServerRequest;
  if (req.headers.origin !== undefined) return yield* fail(403, "NathApp's app API is for the app's server, not the browser.");
  const appId = tokens.appFor(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  if (!appId) return yield* fail(401, "Missing or invalid NATHAPP_API_TOKEN");
  const app = yield* (yield* Apps).get(appId);
  if (!app) return yield* fail(401, "The app no longer exists");
  return app;
});

/**
 * Whether `appId` may read `targetId`'s data: always its own; another app's in
 * the same workspace once the user allows it (other workspaces stay apart).
 */
const mayRead = (app: { id: string; name: string; workspaceId: string }, targetId: string) =>
  Effect.gen(function* () {
    if (targetId === app.id) return app;
    const target = yield* (yield* Apps).get(targetId);
    if (!target || target.kind !== "app" || target.workspaceId !== app.workspaceId) return yield* fail(404, "No such app in this workspace");
    const permissions = yield* Permissions;
    const allowed = yield* permissions.ask({
      subject: app.id,
      action: "app.data",
      resource: target.id,
      title: `Let "${app.name}" read the data of "${target.name}"?`,
      detail: `Its server wants to read what "${target.name}" stored (its tables). It can't change anything.`,
      timeoutMs: 60_000,
    });
    yield* (yield* Audit).record({
      actor: "app",
      actorLabel: app.name,
      tabId: app.id,
      action: "data.read",
      target: target.name,
      outcome: allowed ? "ok" : "denied",
    });
    if (!allowed) return yield* fail(403, `The user didn't allow reading the data of "${target.name}". It can be allowed in NathApp's Settings → Permissions.`);
    return target;
  });

const appApiRoutes = HttpRouter.addAll([
  // An app tells NathApp something happened ("app:<id>:<name>"); schedules waiting for it run.
  HttpRouter.route(
    "POST",
    "/app-api/v1/events",
    handle(
      Effect.gen(function* () {
        const app = yield* apiApp;
        const { name } = yield* decodeBody(Schema.Struct({ name: str(64) }));
        if (!/^[\w.-]+$/.test(name)) return yield* fail(400, "Event names are letters, digits, _ . and -");
        yield* (yield* Scheduler).emit(`app:${app.id}:${name}`);
        return json({ event: `app:${app.id}:${name}` });
      }),
    ),
  ),
  // Every tool of the apps in this app's workspace (calls to other apps' need the user's OK).
  HttpRouter.route(
    "GET",
    "/app-api/v1/tools",
    handle(
      Effect.gen(function* () {
        const app = yield* apiApp;
        const catalog = yield* (yield* AppTools).catalog(app.workspaceId);
        return json(catalog.map((info) => ({ ...info, self: info.appId === app.id, tools: info.tools.filter((t) => !t.path) })));
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/app-api/v1/tools/:app/:tool",
    handle(
      Effect.gen(function* () {
        const app = yield* apiApp;
        const args = yield* decodeBody(ToolCallBody);
        return json(yield* callTool({ kind: "app", appId: app.id }, yield* param("app"), yield* param("tool"), args));
      }),
    ),
  ),
  // The apps whose data this app could ask for: its workspace's.
  HttpRouter.route(
    "GET",
    "/app-api/v1/data",
    handle(
      Effect.gen(function* () {
        const app = yield* apiApp;
        const all = yield* (yield* Apps).list();
        return json(all.filter((a) => a.kind === "app" && a.workspaceId === app.workspaceId).map((a) => ({ id: a.id, name: a.name, self: a.id === app.id })));
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/app-api/v1/data/:app",
    handle(
      Effect.gen(function* () {
        const target = yield* mayRead(yield* apiApp, yield* param("app"));
        const { tables } = yield* (yield* AppData).overview(target.id);
        return json({ app: { id: target.id, name: target.name }, tables });
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/app-api/v1/data/:app/:table",
    handle(
      Effect.gen(function* () {
        const target = yield* mayRead(yield* apiApp, yield* param("app"));
        const table = decodeURIComponent(yield* param("table"));
        const rows = yield* (yield* AppData).rows(target.id, table, yield* rowQuery).pipe(Effect.catchTag("AppDataError", (e) => fail(e.status, e.message)));
        return json(rows);
      }),
    ),
  ),
]);

// --- App actions (command bar) ----------------------------------------------------------------

const ToolCallBody = Schema.Struct({
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  input: Schema.optionalKey(Schema.NullOr(str(4000))),
});

const callTool = (caller: ToolCaller, appId: string, toolId: string, args: { params?: Record<string, unknown>; input?: string | null }) =>
  Effect.gen(function* () {
    return yield* (yield* AppTools).call(caller, appId, toolId, args).pipe(Effect.catchTag("AppToolError", (e) => fail(e.status, e.message)));
  });

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
  // Runs an endpoint action (the command bar): through the tool registry, as the user.
  HttpRouter.route(
    "POST",
    "/api/apps/:id/actions/:action",
    handle(
      Effect.gen(function* () {
        const { input } = yield* decodeBody(Schema.Struct({ input: Schema.optionalKey(Schema.NullOr(str(4000))) }));
        const { ok, status, message } = yield* callTool({ kind: "user" }, yield* param("id"), yield* param("action"), { input });
        return json({ ok, status, message } satisfies AppActionResult);
      }),
    ),
  ),
  // The tool registry: an app's tools (its actions and the ones from its data).
  HttpRouter.route(
    "GET",
    "/api/apps/:id/tools",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        yield* requireApp(id);
        return json(yield* (yield* AppTools).list(id));
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/apps/:id/tools/:tool",
    handle(
      Effect.gen(function* () {
        const args = yield* decodeBody(ToolCallBody);
        return json(yield* callTool({ kind: "user" }, yield* param("id"), yield* param("tool"), args));
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
  // Its split views (tabs side by side). Saved as given, made consistent with its tabs.
  HttpRouter.route(
    "PUT",
    "/api/workspaces/:id/splits",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const id = yield* param("id");
        const { splits } = yield* decodeBody(
          Schema.Struct({
            splits: Schema.Array(
              Schema.Struct({
                id: str(100),
                direction: Schema.Literals(["row", "column"]),
                tabs: Schema.Array(str(100)),
                sizes: Schema.Array(Schema.Number),
              }),
            ).check(Schema.isMaxLength(100)),
          }),
        );
        const updated = yield* workspaces.setSplits(id, splits.map((s) => ({ ...s, tabs: [...s.tabs], sizes: [...s.sizes] })));
        if (!updated) return yield* fail(404, "Not found");
        return json(yield* publishWorkspace(id));
      }),
    ),
  ),
  // The order of its tabs in the sidebar. Tabs left out (made meanwhile) go after the others.
  HttpRouter.route(
    "PUT",
    "/api/workspaces/:id/order",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const apps = yield* Apps;
        const id = yield* param("id");
        const { ids } = yield* decodeBody(Schema.Struct({ ids: Schema.Array(str(100)) }));
        const current = yield* workspaces.appIds(id);
        if (!(yield* workspaces.get(id))) return yield* fail(404, "Not found");
        const known = new Set(current);
        const listed = [...new Set(ids)].filter((x) => known.has(x));
        const order = [...listed, ...current.filter((x) => !listed.includes(x))];
        const tabs = yield* apps.reorder(id, order);
        for (const tab of tabs) yield* publishApp(tab);
        return json(tabs);
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
        yield* (yield* Network).removeWorkspace(id);
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
    for (const id of appIds) yield* runtime.refresh(id);
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

const permissionActions = ["app.ai", "app.secret", "agent.site", "agent.network", "app.data", "app.tool", "agent.schedule", "agent.tab", "agent.browse"] as const satisfies readonly PermissionAction[];

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

// --- Network: rules for web tabs' requests, saved requests ------------------------------------

const headerValue = str(8000).check(Schema.isPattern(/^[^\r\n]*$/, { message: "header values can't contain line breaks" }));
const HeaderChanges = Schema.Record(Schema.String, Schema.NullOr(headerValue));
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Record keys aren't checked by the schema: header names are, here. */
const checkHeaderNames = (...records: (Record<string, unknown> | undefined)[]) =>
  Effect.gen(function* () {
    for (const record of records) {
      const keys = Object.keys(record ?? {});
      if (keys.length > 50) return yield* fail(400, "Too many headers");
      const bad = keys.find((k) => !HEADER_NAME.test(k));
      if (bad !== undefined) return yield* fail(400, `Invalid header name: ${bad.slice(0, 100)}`);
    }
  });
const RuleFields = Schema.Struct({
  workspaceId: Schema.NullOr(str(100)),
  pattern: str(500).check(Schema.isPattern(/\S/, { message: "pattern is required" })),
  action: Schema.Literals(["block", "modify"]),
  requestHeaders: Schema.optionalKey(HeaderChanges),
  responseHeaders: Schema.optionalKey(HeaderChanges),
  enabled: Schema.optionalKey(Schema.Boolean),
});
const Draft = Schema.Struct({
  method: Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,16}$/, { message: "invalid method" })),
  url: str(8000).check(Schema.isPattern(/^https?:\/\//i, { message: "only http(s) URLs" })),
  headers: Schema.Record(Schema.String, headerValue),
  body: Schema.NullOr(str(200_000)),
  sealed: Schema.NullOr(str(400_000)),
});
const Overrides = Schema.Struct({
  url: Schema.optionalKey(str(8000).check(Schema.isPattern(/^https?:\/\//i, { message: "only http(s) URLs" }))),
  method: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,16}$/, { message: "invalid method" }))),
  headers: Schema.optionalKey(HeaderChanges),
  body: Schema.optionalKey(Schema.NullOr(str(200_000))),
});

const publishNetwork = (what: "rules" | "requests") =>
  Effect.gen(function* () {
    const hub = yield* Hub;
    yield* hub.publish({ type: "network-changed", topic: topics.network, what });
  });

const ruleLabel = (rule: NetworkRule) => `${rule.action === "block" ? "Block" : "Change"} ${rule.pattern}`;

const ensureWorkspace = (id: string | null) =>
  Effect.gen(function* () {
    if (id !== null && !(yield* (yield* Workspaces).get(id))) return yield* fail(404, "No such workspace");
  });

/** Sends a saved request with its workspace's session (in Electron's main process, through the NathApp window). */
export const sendSaved = (id: string, overrides: ReplayOverrides) =>
  Effect.gen(function* () {
    const network = yield* Network;
    const hub = yield* Hub;
    const saved = yield* network.draftOf(id);
    if (!saved) return yield* fail(404, "Not found");
    const result = yield* hub
      .rpc<ReplayResult>("network.replay", { workspaceId: saved.request.workspaceId, draft: saved.draft, overrides }, 45_000)
      .pipe(Effect.mapError((err) => new HttpFail({ status: 502, message: err.message })));
    return { request: saved.request, result };
  });

const networkRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/network/rules",
    Effect.gen(function* () {
      const network = yield* Network;
      return json(yield* network.rules());
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/network/rules",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const fields = yield* decodeBody(RuleFields);
        yield* checkHeaderNames(fields.requestHeaders, fields.responseHeaders);
        yield* ensureWorkspace(fields.workspaceId);
        if ((yield* network.countRules()) >= 500) return yield* fail(400, "Too many rules");
        const rule = yield* network.addRule({
          workspaceId: fields.workspaceId,
          pattern: fields.pattern.trim(),
          action: fields.action,
          requestHeaders: fields.requestHeaders ?? {},
          responseHeaders: fields.responseHeaders ?? {},
          enabled: fields.enabled ?? true,
        });
        yield* youDid(rule.workspaceId ? workspaceScope(rule.workspaceId) : null, "network.rule.create", ruleLabel(rule));
        yield* publishNetwork("rules");
        return json(rule, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/network/rules/:id",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const fields = yield* decodeBody(Schema.Struct({ ...RuleFields.fields, workspaceId: Schema.optionalKey(Schema.NullOr(str(100))), pattern: Schema.optionalKey(RuleFields.fields.pattern), action: Schema.optionalKey(RuleFields.fields.action) }));
        yield* checkHeaderNames(fields.requestHeaders, fields.responseHeaders);
        if (fields.workspaceId !== undefined) yield* ensureWorkspace(fields.workspaceId);
        const rule = yield* network.updateRule(yield* param("id"), { ...fields, ...(fields.pattern ? { pattern: fields.pattern.trim() } : {}) });
        if (!rule) return yield* fail(404, "Not found");
        yield* youDid(rule.workspaceId ? workspaceScope(rule.workspaceId) : null, "network.rule.update", ruleLabel(rule), rule.enabled ? "on" : "off");
        yield* publishNetwork("rules");
        return json(rule);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/network/rules/:id",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const rule = yield* network.getRule(yield* param("id"));
        if (!rule) return yield* fail(404, "Not found");
        yield* network.removeRule(rule.id);
        yield* youDid(rule.workspaceId ? workspaceScope(rule.workspaceId) : null, "network.rule.delete", ruleLabel(rule));
        yield* publishNetwork("rules");
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/network/requests",
    Effect.gen(function* () {
      const network = yield* Network;
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(yield* network.saved(params.get("workspace") ?? undefined));
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/network/requests",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const { workspaceId, name, draft } = yield* decodeBody(
          Schema.Struct({ workspaceId: str(100), name: str(120).check(Schema.isPattern(/\S/, { message: "name is required" })), draft: Draft }),
        );
        yield* checkHeaderNames(draft.headers);
        yield* ensureWorkspace(workspaceId);
        const saved = yield* network.save(workspaceId, name.trim(), { ...draft, method: draft.method.toUpperCase() });
        yield* youDid(workspaceScope(workspaceId), "network.request.save", saved.name, `${saved.method} ${saved.url}`);
        yield* publishNetwork("requests");
        return json(saved, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/network/requests/:id",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const saved = yield* network.getSaved(yield* param("id"));
        if (!saved) return yield* fail(404, "Not found");
        yield* network.removeSaved(saved.id);
        yield* youDid(workspaceScope(saved.workspaceId), "network.request.delete", saved.name);
        yield* publishNetwork("requests");
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/network/requests/:id/send",
    handle(
      Effect.gen(function* () {
        const overrides = yield* decodeBody(Schema.Struct({ overrides: Schema.optionalKey(Overrides) }));
        yield* checkHeaderNames(overrides.overrides?.headers);
        const { request, result } = yield* sendSaved(yield* param("id"), overrides.overrides ?? {});
        yield* youDid(workspaceScope(request.workspaceId), "network.request.send", request.name, `HTTP ${result.status}`);
        return json(result);
      }),
    ),
  ),
]);

export const routes = Layer.mergeAll(health, ws, mcp, providerRoutes, settingsRoutes, presetsRoute, appRoutes, workspaceRoutes, historyRoutes, actionRoutes, dataRoutes, appApiRoutes, runtimeRoutes, siteRoutes, pageChangeRoutes, scheduleRoutes, aiRoutes, secretRoutes, permissionRoutes, networkRoutes, guard);

export const cors = (allowedOrigin: string) =>
  HttpRouter.cors({
    allowedOrigins: [allowedOrigin],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Disposition"],
    maxAge: 600,
  });
