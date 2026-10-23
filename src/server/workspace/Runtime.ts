// Runs apps. While an app is being edited (dev mode) gApp runs its dev server,
// which reloads on every change; when it's done (live mode) gApp builds it and
// runs its start command. Either way the app listens on a port gApp assigns
// and the renderer shows it in a preview tab. Processes run in the app's
// sandbox and stop with the server.
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Context, Effect, Fiber, FiberMap, Layer, Semaphore } from "effect";
import type { AppMode, LogLine, Manifest, RuntimeStatus } from "../../shared/api";
import { topics } from "../../shared/hub";
import { Apps } from "../db/Apps";
import { Hub } from "../Hub";
import { Sandbox } from "./Sandbox";
import { Workspace } from "./Workspace";

const MAX_LOG_LINES = 2000;

export interface RuntimeShape {
  readonly status: (appId: string) => Effect.Effect<RuntimeStatus>;
  readonly logs: (appId: string, limit?: number) => LogLine[];
  /** Starts the app in its mode unless it's already running (or has no project). */
  readonly ensure: (appId: string) => Effect.Effect<RuntimeStatus>;
  /** (Re)starts the app: installs dependencies if they changed, builds in live mode. */
  readonly restart: (appId: string) => Effect.Effect<RuntimeStatus>;
  readonly stop: (appId: string) => Effect.Effect<void>;
  /** Switches between dev (being edited) and live (done), restarting the app. */
  readonly setMode: (appId: string, mode: AppMode) => Effect.Effect<RuntimeStatus>;
  /** Waits until the app is running, crashed or stopped (or the timeout passes). */
  readonly settled: (appId: string, timeoutMs?: number) => Effect.Effect<RuntimeStatus>;
  /** Runs a one-off command in the app's sandbox (installs, scripts, migrations). */
  readonly exec: (appId: string, command: string, timeoutMs?: number) => Effect.Effect<{ code: number | null; output: string; timedOut: boolean }>;
  /** Stops the app and forgets it (the app was deleted). */
  readonly forget: (appId: string) => Effect.Effect<void>;
}

export class Runtime extends Context.Service<Runtime, RuntimeShape>()("gapp/Runtime") {}

const freePort = (preferred?: number | null) =>
  new Promise<number>((resolve, reject) => {
    const tryListen = (port: number) => {
      const srv = createServer();
      srv.once("error", () => (port ? tryListen(0) : reject(new Error("No free port"))));
      srv.listen(port, "127.0.0.1", () => {
        const { port: chosen } = srv.address() as { port: number };
        srv.close(() => resolve(chosen));
      });
    };
    tryListen(preferred ?? 0);
  });

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          socket.end();
          resolve(true);
        },
        connectError: () => resolve(false),
        data: () => {},
      },
    }).catch(() => resolve(false));
  });

/** Kills a process and everything it started (it leads its own process group). */
async function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      child.kill(sig);
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}

interface State {
  status: RuntimeStatus;
  logs: LogLine[];
  port: number | null;
  lock: Semaphore.Semaphore;
}

export const make = Effect.gen(function* () {
  const apps = yield* Apps;
  const hub = yield* Hub;
  const sandbox = yield* Sandbox;
  const workspace = yield* Workspace;
  const sessions = yield* FiberMap.make<string>();
  const states = new Map<string, State>();

  const stateOf = (appId: string): State => {
    let state = states.get(appId);
    if (!state) {
      state = {
        status: { mode: "dev", state: "stopped", url: null, port: null, exitCode: null, error: null, startedAt: null, sandbox: "none" },
        logs: [],
        port: null,
        lock: Semaphore.makeUnsafe(1),
      };
      states.set(appId, state);
    }
    return state;
  };

  const setStatus = (appId: string, patch: Partial<RuntimeStatus>) => {
    const state = stateOf(appId);
    state.status = { ...state.status, ...patch };
    hub.publishUnsafe({ type: "runtime", topic: topics.app(appId), appId, status: state.status });
  };

  const log = (appId: string, stream: LogLine["stream"], text: string) => {
    const state = stateOf(appId);
    const lines = text
      .replace(/\r/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\n")
      .filter((line, i, all) => line.length > 0 || i < all.length - 1)
      .map((line): LogLine => ({ at: Date.now(), stream, text: line }));
    if (!lines.length) return;
    state.logs.push(...lines);
    if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
    hub.publishUnsafe({ type: "log", topic: topics.logs(appId), appId, lines });
  };

  /** Environment gApp provides to the app's processes. */
  const appEnv = (appId: string, mode: AppMode, port: number | null): Record<string, string> => {
    const db = join(workspace.stateDir(appId), "data.sqlite");
    return {
      ...(port ? { PORT: String(port), HOST: "127.0.0.1", APP_URL: `http://127.0.0.1:${port}` } : {}),
      DATABASE_PATH: db,
      DATABASE_URL: `file:${db}`,
      GAPP_APP_ID: appId,
      GAPP_MODE: mode,
      NODE_ENV: mode === "live" ? "production" : "development",
    };
  };

  /** Starts a command in the sandbox; stopping the scope kills it. */
  const spawnIn = (appId: string, command: string, env: Record<string, string>) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const spec = yield* sandbox.spawnSpec({ dir: workspace.dir(appId), command, env });
        const [file, ...args] = spec.argv;
        const child = spawnChild(file!, args, {
          cwd: spec.cwd,
          env: spec.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // its own process group, so it can be killed with its children
        });
        child.stdout!.on("data", (chunk: Buffer) => log(appId, "out", chunk.toString()));
        child.stderr!.on("data", (chunk: Buffer) => log(appId, "err", chunk.toString()));
        const exited = new Promise<number | null>((resolve) => {
          child.once("exit", (code) => resolve(code));
          child.once("error", (err) => {
            log(appId, "system", `Couldn't start: ${err.message}`);
            resolve(-1);
          });
        });
        return { child, exited };
      }),
      ({ child }) => Effect.promise(() => killTree(child)),
    );

  /** Runs a command to completion (installs, builds). */
  const runToEnd = (appId: string, command: string, env: Record<string, string>, timeoutMs = 10 * 60_000) =>
    Effect.scoped(
      Effect.gen(function* () {
        log(appId, "system", `$ ${command}`);
        const { exited } = yield* spawnIn(appId, command, env);
        const code = yield* Effect.promise(() => exited).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed("timeout" as const) }));
        return code;
      }),
    );

  const installStamp = (appId: string) => join(workspace.stateDir(appId), "installed");

  /** Whether dependencies changed since the last successful install. */
  const needsInstall = (appId: string, manifest: Manifest) => {
    const dir = workspace.dir(appId);
    if (!manifest.install && !existsSync(join(dir, "package.json"))) return false;
    if (!existsSync(installStamp(appId))) return true;
    if (!manifest.install && !existsSync(join(dir, "node_modules"))) return true;
    const stamp = statSync(installStamp(appId)).mtimeMs;
    return ["package.json", "bun.lock", "bun.lockb"].some((f) => {
      const path = join(dir, f);
      return existsSync(path) && statSync(path).mtimeMs > stamp;
    });
  };

  const fail = (appId: string, error: string, exitCode: number | null = null) => {
    log(appId, "system", error);
    setStatus(appId, { state: "crashed", error, exitCode, url: null });
  };

  /** One run of the app: install → (build) → serve, until it exits or is stopped. */
  const session = (appId: string, mode: AppMode) =>
    Effect.gen(function* () {
      const state = stateOf(appId);
      const kind = yield* sandbox.kind;
      setStatus(appId, { mode, sandbox: kind, exitCode: null, error: null, url: null, port: null, startedAt: null });
      const manifest = yield* workspace.manifest(appId).pipe(
        Effect.catch((err) => Effect.sync(() => (fail(appId, err.message), undefined))),
      );
      if (manifest === undefined) return;
      if (manifest === null) {
        setStatus(appId, { state: "stopped" });
        return;
      }
      const env = appEnv(appId, mode, null);

      if (needsInstall(appId, manifest)) {
        setStatus(appId, { state: "installing" });
        const code = yield* runToEnd(appId, manifest.install ?? "bun install", env);
        if (code !== 0) return fail(appId, code === "timeout" ? "Installing dependencies timed out" : `Installing dependencies failed (exit code ${code})`);
        writeFileSync(installStamp(appId), new Date().toISOString());
      }

      if (mode === "live" && manifest.build) {
        setStatus(appId, { state: "building" });
        const code = yield* runToEnd(appId, manifest.build, env);
        if (code !== 0) return fail(appId, code === "timeout" ? "The build timed out" : `The build failed (exit code ${code})`);
      }

      const port = yield* Effect.promise(() => freePort(state.port));
      state.port = port;
      const command = mode === "live" ? manifest.start : manifest.dev;
      setStatus(appId, { state: "starting", port });
      log(appId, "system", `$ ${command}  (PORT=${port}, ${kind === "bwrap" ? "sandboxed" : "not sandboxed"})`);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { exited } = yield* spawnIn(appId, command, appEnv(appId, mode, port));
          const ready = yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (!(yield* Effect.promise(() => listening(port)))) yield* Effect.sleep(250);
              setStatus(appId, { state: "running", url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() });
            }),
          );
          const code = yield* Effect.promise(() => exited);
          yield* Fiber.interrupt(ready);
          const wasRunning = stateOf(appId).status.state === "running";
          fail(appId, `The app ${wasRunning ? "stopped" : "exited before it was ready"} (exit code ${code})`, code);
        }),
      );
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => setStatus(appId, { state: "stopped", url: null }))));

  const start = (appId: string, mode: AppMode) =>
    stateOf(appId).lock.withPermits(1)(
      Effect.gen(function* () {
        yield* FiberMap.remove(sessions, appId);
        yield* FiberMap.run(sessions, appId, session(appId, mode));
        // Let the session publish its first status.
        yield* Effect.yieldNow;
        return stateOf(appId).status;
      }),
    );

  const modeOf = (appId: string) => apps.get(appId).pipe(Effect.map((app) => app?.mode ?? "dev"));

  const settled = (appId: string, timeoutMs = 120_000) =>
    Effect.gen(function* () {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { state } = stateOf(appId).status;
        if (state === "running" || state === "crashed" || state === "stopped" || Date.now() > deadline) return stateOf(appId).status;
        yield* Effect.sleep(200);
      }
    });

  return {
    status: (appId) => Effect.sync(() => stateOf(appId).status),
    logs: (appId, limit = 200) => stateOf(appId).logs.slice(-limit),

    ensure: (appId) =>
      Effect.gen(function* () {
        const { state } = stateOf(appId).status;
        if (state !== "stopped" && state !== "crashed") return stateOf(appId).status;
        if (!(yield* workspace.info(appId))) return stateOf(appId).status;
        return yield* start(appId, yield* modeOf(appId));
      }),

    restart: (appId) => Effect.flatMap(modeOf(appId), (mode) => start(appId, mode)),

    stop: (appId) => stateOf(appId).lock.withPermits(1)(FiberMap.remove(sessions, appId)),

    setMode: (appId, mode) => apps.setMode(appId, mode).pipe(Effect.andThen(start(appId, mode))),

    settled,

    exec: (appId, command, timeoutMs = 120_000) =>
      Effect.scoped(
        Effect.gen(function* () {
          const mode = yield* modeOf(appId);
          let output = "";
          const spec = yield* sandbox.spawnSpec({ dir: workspace.dir(appId), command, env: appEnv(appId, mode, null) });
          const [file, ...args] = spec.argv;
          const child = yield* Effect.acquireRelease(
            Effect.sync(() => spawnChild(file!, args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true })),
            (c) => Effect.promise(() => killTree(c)),
          );
          const append = (chunk: Buffer) => {
            output = `${output}${chunk.toString()}`.slice(-20_000);
          };
          child.stdout!.on("data", append);
          child.stderr!.on("data", append);
          const code = yield* Effect.promise(
            () => new Promise<number | null>((resolve) => (child.once("exit", resolve), child.once("error", () => resolve(-1)))),
          ).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed("timeout" as const) }));
          return {
            code: code === "timeout" ? null : code,
            // eslint-disable-next-line no-control-regex
            output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim(),
            timedOut: code === "timeout",
          };
        }),
      ),

    forget: (appId) =>
      FiberMap.remove(sessions, appId).pipe(Effect.andThen(Effect.sync(() => states.delete(appId)))),
  } satisfies RuntimeShape;
});

export const layer = Layer.effect(Runtime, make);
