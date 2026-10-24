// App projects: one folder per app (the app's disk), with nathapp.json saying how
// to install, develop, build and start it. NathApp keeps its runtime state in
// .nathapp/ inside the folder (the app's SQLite database, a home directory).
import { existsSync, renameSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { AppAction, Manifest, ProjectInfo } from "../../shared/api";
import { tokensCss } from "../../shared/theme";
import { ServerConfig } from "../Config";
import { Settings } from "../db/Settings";
import { findPreset, presets, render } from "./presets";

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ readonly message: string }> {}

const ManifestSchema = Schema.Struct({
  preset: Schema.optionalKey(Schema.String),
  install: Schema.optionalKey(Schema.String),
  dev: Schema.String,
  build: Schema.optionalKey(Schema.String),
  start: Schema.String,
});

export const MANIFEST = "nathapp.json";

export interface WorkspaceShape {
  readonly dir: (appId: string) => string;
  /** NathApp's runtime folder inside the project (database, home). */
  readonly stateDir: (appId: string) => string;
  /** Creates the project folder if needed and returns it. */
  readonly ensureDir: (appId: string) => Effect.Effect<string>;
  /** The project's nathapp.json; null when there is none yet, an error when it's invalid. */
  readonly manifest: (appId: string) => Effect.Effect<Manifest | null, WorkspaceError>;
  readonly info: (appId: string) => Effect.Effect<ProjectInfo | null>;
  /** Sets up a new project from a preset. */
  readonly scaffold: (appId: string, presetId: string, name: string) => Effect.Effect<ProjectInfo, WorkspaceError>;
  /** Copies a project (without dependencies, builds and NathApp's runtime state). */
  readonly duplicate: (fromId: string, toId: string) => Effect.Effect<void>;
  readonly remove: (appId: string) => Effect.Effect<void>;
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("nathapp/Workspace") {}

const decodeManifest = Schema.decodeUnknownSync(ManifestSchema);

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const route = (value: unknown) => (typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 500 ? value : undefined);

/** The command bar actions in nathapp.json. Invalid ones are left out rather than failing the whole manifest. */
export function parseActions(value: unknown): AppAction[] {
  if (!Array.isArray(value)) return [];
  const actions = new Map<string, AppAction>();
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== "object") continue;
    const { id, title, description, path, endpoint, input } = item as Record<string, unknown>;
    if (typeof id !== "string" || !ACTION_ID.test(id) || typeof title !== "string" || !title.trim() || actions.has(id)) continue;
    const opens = route(path);
    const calls = route(endpoint);
    // Exactly one of the two.
    if (!opens === !calls) continue;
    actions.set(id, {
      id,
      title: title.trim().slice(0, 80),
      ...(typeof description === "string" && description.trim() ? { description: description.trim().slice(0, 200) } : {}),
      ...(opens ? { path: opens } : { endpoint: calls }),
      ...(typeof input === "string" && input.trim() ? { input: input.trim().slice(0, 80) } : {}),
    });
  }
  return [...actions.values()];
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* Settings;
  const dir = (appId: string) => join(config.appsDir, appId);
  const stateDir = (appId: string) => join(dir(appId), ".nathapp");

  /** Projects from NathApp's earlier name (gApp): gapp.json and .gapp/ get the new names. */
  const migrate = (appId: string) =>
    Effect.sync(() => {
      const renames: [string, string][] = [
        ["gapp.json", MANIFEST],
        [".gapp", ".nathapp"],
      ];
      for (const [from, to] of renames) {
        const legacy = join(dir(appId), from);
        if (existsSync(legacy) && !existsSync(join(dir(appId), to))) renameSync(legacy, join(dir(appId), to));
      }
    });

  const manifest = (appId: string) =>
    Effect.gen(function* () {
      yield* migrate(appId);
      const text = yield* Effect.promise(() => readFile(join(dir(appId), MANIFEST), "utf8").catch(() => null));
      if (text === null) return null;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        return yield* new WorkspaceError({ message: `${MANIFEST} isn't valid JSON: ${(err as Error).message}` });
      }
      try {
        const actions = parseActions((json as { actions?: unknown } | null)?.actions);
        return { ...(decodeManifest(json) as Manifest), ...(actions.length ? { actions } : {}) };
      } catch (err) {
        return yield* new WorkspaceError({ message: `${MANIFEST} is invalid: ${(err as Error).message}` });
      }
    });

  const ensureDir = (appId: string) => Effect.promise(() => mkdir(dir(appId), { recursive: true }).then(() => dir(appId)));

  return {
    dir,
    stateDir,
    ensureDir,
    manifest,
    info: (appId) =>
      manifest(appId).pipe(
        Effect.map((m) => (m ? { dir: dir(appId), manifest: m } : null)),
        Effect.orElseSucceed(() => null),
      ),

    scaffold: (appId, presetId, name) =>
      Effect.gen(function* () {
        const preset = findPreset(presetId);
        if (!preset) {
          return yield* new WorkspaceError({ message: `Unknown preset "${presetId}". Presets: ${presets.map((p) => p.id).join(", ")}` });
        }
        const existing = yield* manifest(appId).pipe(Effect.orElseSucceed(() => ({}) as Manifest));
        if (existing) return yield* new WorkspaceError({ message: `The project is already set up (it has a ${MANIFEST}). Change its files instead.` });
        const root = yield* ensureDir(appId);
        const theme = (yield* settings.get()).theme;
        const files: Record<string, string> = {
          ...Object.fromEntries(Object.entries(preset.files).map(([path, content]) => [path, render(content, { name })])),
          [MANIFEST]: `${JSON.stringify(preset.manifest, null, 2)}\n`,
        };
        if (preset.files["src/styles.css"]) files["src/tokens.css"] = tokensCss(theme);
        yield* Effect.promise(async () => {
          for (const [path, content] of Object.entries(files)) {
            const target = join(root, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content);
          }
        });
        return { dir: root, manifest: preset.manifest };
      }),

    duplicate: (fromId, toId) =>
      Effect.promise(async () => {
        const skip = new Set(["node_modules", "dist", ".nathapp"].map((name) => join(dir(fromId), name)));
        await cp(dir(fromId), dir(toId), { recursive: true, filter: (src) => !skip.has(src) }).catch(() => {});
      }),

    remove: (appId) => Effect.promise(() => rm(dir(appId), { recursive: true, force: true })),
  } satisfies WorkspaceShape;
});

export const layer = Layer.effect(Workspace, make);
