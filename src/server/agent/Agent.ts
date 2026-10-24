// Runs agent turns: picks the provider, gives it NathApp's instructions and tools,
// persists the conversation and pushes everything to the renderer on the hub
// (topic app:<id>). A turn runs in the background; stopping interrupts it.
import { Context, Data, Effect, FiberMap, Layer, Stream } from "effect";
import { appTarget, type AgentChoice, type ChatEvent, type ChatMessage, type PageContext, type ProviderId } from "../../shared/api";
import { topics } from "../../shared/hub";
import { ServerConfig } from "../Config";
import { Apps, type AppRecord } from "../db/Apps";
import { Network } from "../db/Network";
import { Settings } from "../db/Settings";
import { Sites } from "../db/Sites";
import { Workspaces } from "../db/Workspaces";
import { History } from "../history/History";
import { Audit } from "../security/Audit";
import { Permissions } from "../security/Permissions";
import { Secrets } from "../security/Secrets";
import { Hub } from "../Hub";
import type { TurnInput } from "../providers/Provider";
import { Providers } from "../providers/Providers";
import { Runtime } from "../workspace/Runtime";
import { Sandbox } from "../workspace/Sandbox";
import { Workspace } from "../workspace/Workspace";
import { Mcp, type Tool } from "./Mcp";
import { buildAppPrompt, buildWebPrompt, contextSummary, withPageContext } from "./prompts";
import { networkTools } from "./networkTools";
import { appTools, pageTools, siteTools, type ToolEnv } from "./tools";

/** Tool arguments for the audit log: short values as they are, long ones by size. */
export function summarizeArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const parts = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 120 ? `${key}: ${text.length} chars` : `${key}: ${text}`;
  });
  return parts.length ? parts.join(", ") : null;
}

export class AgentError extends Data.TaggedError("AgentError")<{ readonly status: 404 | 409 | 400; readonly message: string }> {}

export interface TurnRequest {
  readonly prompt: string;
  readonly agent?: Partial<AgentChoice>;
  readonly page?: PageContext;
}

export interface AgentShape {
  /** Starts a turn in the background. Fails if the tab is busy or the provider can't run. */
  readonly start: (appId: string, request: TurnRequest) => Effect.Effect<void, AgentError>;
  readonly stop: (appId: string) => Effect.Effect<void>;
  readonly isRunning: (appId: string) => Effect.Effect<boolean>;
}

export class Agent extends Context.Service<Agent, AgentShape>()("nathapp/Agent") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const apps = yield* Apps;
  const settings = yield* Settings;
  const hub = yield* Hub;
  const providers = yield* Providers;
  const mcp = yield* Mcp;
  const workspace = yield* Workspace;
  const workspaces = yield* Workspaces;
  const history = yield* History;
  const runtime = yield* Runtime;
  const sandbox = yield* Sandbox;
  const audit = yield* Audit;
  const running = yield* FiberMap.make<string>();
  // Tools need the services; captured once.
  const context = yield* Effect.context<Hub | Apps | Workspace | Runtime | Sites | Permissions | Secrets | Network>();

  const emit = (appId: string, event: ChatEvent) => hub.publish({ type: "chat", topic: topics.app(appId), appId, event });
  const message = (appId: string, role: ChatMessage["role"], content: string) =>
    apps.addMessage(appId, role, content).pipe(Effect.tap((m) => emit(appId, { type: "message", message: m })));

  /** A tool whose calls go to the audit log (arguments summarized; long text only as its length). */
  const audited = (t: Tool, tabId: string, actorLabel: string): Tool => ({
    ...t,
    run: (args) =>
      t.run(args).pipe(
        Effect.tap((result) =>
          audit.record({
            actor: "agent",
            actorLabel,
            tabId,
            action: `tool.${t.name}`,
            target: summarizeArgs(args),
            outcome: result.isError ? "error" : "ok",
          }),
        ),
      ),
  });

  /** The request's choice, else the tab's last one, else the defaults (the workspace's or Settings'). */
  const resolveChoice = (request: Partial<AgentChoice> | undefined, app: AppRecord, defaults: AgentChoice): AgentChoice => {
    const provider: ProviderId = request?.provider ?? app.agent?.provider ?? defaults.provider;
    const previous = app.agent?.provider === provider ? app.agent : provider === defaults.provider ? defaults : null;
    return {
      provider,
      model: request?.model !== undefined ? request.model : (previous?.model ?? null),
      effort: request?.effort !== undefined ? request.effort : (previous?.effort ?? null),
    };
  };

  const turn = (app: AppRecord, choice: AgentChoice, request: TurnRequest) =>
    Effect.gen(function* () {
      const appId = app.id;
      const s = yield* settings.get();
      const space = (yield* workspaces.ofApp(appId))?.settings;
      // The workspace's instructions come after the global ones.
      const combine = (global: string, local: string | undefined) => [global.trim(), local?.trim()].filter(Boolean).join("\n\n");
      yield* emit(appId, { type: "started" });
      if (request.page?.selection.length) yield* message(appId, "context", contextSummary(request.page));
      yield* message(appId, "user", request.prompt);
      yield* apps.touch(appId);

      const env: ToolEnv = {
        tabId: appId,
        log: (line) => Effect.asVoid(message(appId, "tool", line)),
        message: (role, content) => Effect.asVoid(message(appId, role, content)),
      };
      const web = app.kind === "web";
      const status = (yield* providers.list).find((p) => p.id === choice.provider);
      const actorLabel = `${web ? "Website agent" : "App builder"} · ${status?.label ?? choice.provider}${choice.model ? ` (${choice.model})` : ""}`;
      const tools = web
        ? [
            ...(yield* Effect.provide(pageTools(env, { site: true }), context)),
            ...(yield* Effect.provide(siteTools(env), context)),
            ...(yield* Effect.provide(networkTools(env), context)),
          ]
        : [...(yield* Effect.provide(appTools(env), context)), ...(yield* Effect.provide(pageTools(env, { site: false }), context))];
      const mcpUrl = yield* mcp.register(tools.map((t) => audited(t, appId, actorLabel)));
      // Snapshots around the turn: what changed before it (the user, the app's data), and what the agent changed.
      const target = web ? "sites" : appTarget(appId);
      const prompt = request.prompt.trim();
      yield* history.record(target, { actor: "nathapp", actorLabel: "Automatic snapshot", summary: `Before “${prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt}”` });
      const snapshotAfter = history.record(target, { actor: "agent", actorLabel, summary: prompt });
      yield* audit.record({ actor: "agent", actorLabel, tabId: appId, action: "agent.turn", detail: `${request.prompt.length} characters` });

      let cwd: string;
      let instructions: string;
      if (web) {
        cwd = config.agentDir;
        instructions = buildWebPrompt(combine(s.agent.webInstructions, space?.webInstructions));
      } else {
        cwd = yield* workspace.ensureDir(appId);
        const project = yield* workspace.info(appId);
        instructions = buildAppPrompt({ instructions: combine(s.agent.instructions, space?.instructions), dir: cwd, hasProject: !!project });
        // The agent works against the dev server (live updates in the preview).
        if (project) yield* Effect.forkDetach(app.mode === "live" ? runtime.setMode(appId, "dev") : runtime.ensure(appId));
      }

      const driver = providers.driver(choice.provider);
      const input = (resume: string | null): TurnInput => ({
        cwd,
        prompt: withPageContext(request.prompt, request.page),
        instructions,
        model: choice.model,
        effort: choice.effort,
        resume,
        mcp: { name: "nathapp", url: mcpUrl, headers: {} },
        access: web ? "none" : "workspace",
        env: { PATH: `${process.env.PATH ?? ""}:${sandbox.binDir}` },
      });

      let heard = false;
      const run = (resume: string | null) =>
        driver.run(input(resume), s.providers[choice.provider]).pipe(
          Stream.runForEach((event) => {
            heard = heard || event.type !== "session";
            switch (event.type) {
              case "session":
                return apps.setSession(appId, { provider: choice.provider, id: event.id });
              case "delta":
                return emit(appId, { type: "delta", text: event.text });
              case "text":
                return Effect.asVoid(message(appId, "assistant", event.text));
              case "tool":
                return Effect.asVoid(message(appId, "tool", event.title)).pipe(
                  Effect.andThen(audit.record({ actor: "agent", actorLabel, tabId: appId, action: "agent.native", target: event.title })),
                );
              case "error":
                return Effect.asVoid(message(appId, "error", event.message));
            }
          }),
        );

      const resume = app.session?.provider === choice.provider ? app.session.id : null;
      yield* run(resume).pipe(
        // A session the provider no longer knows: start a fresh one.
        Effect.catch((err) => (resume && !heard ? run(null) : Effect.fail(err))),
        Effect.catch((err) => Effect.asVoid(message(appId, "error", `${driver.label} failed: ${err.message}`))),
        // Also when stopped halfway.
        Effect.ensuring(snapshotAfter),
      );

      if (!web && s.apps.autoPublish && (yield* workspace.info(appId))) yield* Effect.forkDetach(runtime.setMode(appId, "live"));
    }).pipe(
      Effect.scoped,
      Effect.onInterrupt(() => Effect.asVoid(message(app.id, "error", "Stopped."))),
      Effect.ensuring(emit(app.id, { type: "done" })),
    );

  return {
    isRunning: (appId) => FiberMap.has(running, appId),

    stop: (appId) => FiberMap.remove(running, appId),

    start: (appId, request) =>
      Effect.gen(function* () {
        const app = yield* apps.get(appId);
        if (!app) return yield* new AgentError({ status: 404, message: "Not found" });
        if (yield* FiberMap.has(running, appId)) {
          return yield* new AgentError({ status: 409, message: "The agent is already working on this tab" });
        }
        const s = yield* settings.get();
        // New tabs start with the workspace's default agent, if it has one.
        const defaults = (yield* workspaces.ofApp(appId))?.settings.agent ?? s.agent;
        const choice = resolveChoice(request.agent, app, defaults);
        const status = (yield* providers.list).find((p) => p.id === choice.provider)!;
        if (status.state !== "ready" && status.state !== "checking") {
          return yield* new AgentError({
            status: 400,
            message: `${status.label} can't run: ${status.state === "disabled" ? "it's turned off in Settings" : (status.message ?? status.state)}`,
          });
        }
        yield* apps.setAgent(appId, choice);
        yield* FiberMap.run(running, appId, turn(app, choice, request), { onlyIfMissing: true });
      }),
  } satisfies AgentShape;
});

export const layer = Layer.effect(Agent, make);
