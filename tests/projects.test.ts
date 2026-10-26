// The app lifecycle (workspace/Projects.ts): an app set up by the user or the
// agent, or copied from another, goes through the same steps; moving and
// deleting a tab take care of everything that belongs to it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { appTarget, DEFAULT_WORKSPACE } from "../src/shared/api";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { Workspaces } from "../src/server/db/Workspaces";
import { History } from "../src/server/history/History";
import { Secrets } from "../src/server/security/Secrets";
import { core } from "../src/server/services";
import { AppData } from "../src/server/workspace/AppData";
import { Projects } from "../src/server/workspace/Projects";
import { Runtime } from "../src/server/workspace/Runtime";
import { Workspace } from "../src/server/workspace/Workspace";

describe("projects", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "nathapp-projects-"));
  const runtime = ManagedRuntime.make(core(readConfig({ NATHAPP_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(effect as Effect.Effect<A>);

  /** A new app tab with a project from a preset, set up by `actor`; stopped right after. */
  const createApp = (actor: "user" | "agent") =>
    Effect.gen(function* () {
      const apps = yield* Apps;
      const projects = yield* Projects;
      const app = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
      yield* projects.create(app.id, "api", { name: `By ${actor}`, by: { actor, actorLabel: actor === "user" ? "You" : "App builder" } });
      yield* (yield* Runtime).stop(app.id);
      return (yield* apps.get(app.id))!;
    });

  test("the user's template and the agent's create_project are the same steps", async () => {
    const result = await run(
      Effect.gen(function* () {
        const history = yield* History;
        const workspace = yield* Workspace;
        const out = [];
        for (const actor of ["user", "agent"] as const) {
          const app = yield* createApp(actor);
          const [first] = yield* history.list({ target: appTarget(app.id) });
          out.push({ name: app.name, mode: app.mode, manifest: !!(yield* workspace.info(app.id)), first: first && { actor: first.actor, summary: first.summary } });
        }
        return out;
      }),
    );
    expect(result).toEqual([
      { name: "By user", mode: "dev", manifest: true, first: { actor: "user", summary: "Started from the api template" } },
      { name: "By agent", mode: "dev", manifest: true, first: { actor: "agent", summary: "Started from the api template" } },
    ]);
  });

  test("a copy gets the project as its first snapshot, without dependencies, data or secrets", async () => {
    const result = await run(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const appData = yield* AppData;
        const secrets = yield* Secrets;
        const history = yield* History;
        const app = yield* createApp("user");
        mkdirSync(join(workspace.dir(app.id), "node_modules", "dep"), { recursive: true });
        const data = yield* appData.ensure(app.id);
        writeFileSync(join(data.files, "upload.txt"), "mine");
        yield* secrets.set(app.id, "API_KEY", "secret-value-1");
        const copy = (yield* (yield* Projects).copy(app.id))!;
        const [first] = yield* history.list({ target: appTarget(copy.id) });
        return {
          name: copy.name,
          server: existsSync(join(workspace.dir(copy.id), "src", "server.ts")),
          deps: existsSync(join(workspace.dir(copy.id), "node_modules")),
          files: existsSync(join(appData.dir(copy.id), "files", "upload.txt")),
          secrets: (yield* secrets.available(copy.id)).own,
          first: first?.summary,
        };
      }),
    );
    expect(result).toEqual({ name: "By user copy", server: true, deps: false, files: false, secrets: [], first: "Copied from By user" });
  });

  test("moving a tab takes it out of its split; deleting it removes everything it had", async () => {
    const result = await run(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const projects = yield* Projects;
        const workspace = yield* Workspace;
        const appData = yield* AppData;
        const history = yield* History;
        const a = yield* createApp("user");
        const b = yield* apps.create(DEFAULT_WORKSPACE, "web", "https://example.com/");
        yield* workspaces.setSplits(DEFAULT_WORKSPACE, [{ id: "s", direction: "row", tabs: [a.id, b.id], sizes: [0.5, 0.5] }]);
        const other = yield* workspaces.create("Other", null);
        const moved = yield* projects.move(b.id, other.id);
        const splits = (yield* workspaces.get(DEFAULT_WORKSPACE))!.splits;
        yield* appData.ensure(a.id);
        yield* projects.remove(a.id);
        return {
          moved: moved?.workspaceId === other.id,
          splits,
          tab: yield* apps.get(a.id),
          project: existsSync(workspace.dir(a.id)),
          data: existsSync(appData.dir(a.id)),
          history: (yield* history.list({ target: appTarget(a.id) })).length,
        };
      }),
    );
    expect(result).toEqual({ moved: true, splits: [], tab: null, project: false, data: false, history: 0 });
  });
});
