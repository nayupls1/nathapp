// Where app processes run. With bubblewrap (Linux) every app gets a light
// sandbox of its own: it sees the system read-only, its project folder
// read-write (and its data folder) and a private /tmp, with its own process and IPC namespaces, so
// an app can't read your files or other apps. Without it, processes run
// directly in the project folder.
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { SandboxKind } from "../../shared/api";
import { ServerConfig, type ServerConfigShape } from "../Config";
import { Settings } from "../db/Settings";

export interface SpawnSpec {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}

export interface SandboxShape {
  /** What the current settings resolve to on this machine. */
  readonly kind: Effect.Effect<SandboxKind>;
  /** How to run `command` (a shell command line) for an app. `binds`: more folders it may read and write (its data). */
  readonly spawnSpec: (options: { dir: string; command: string; env: Record<string, string>; binds?: readonly string[] }) => Effect.Effect<SpawnSpec>;
  /** Directory with `bun`, `bunx` and `node` for app processes and agents. */
  readonly binDir: string;
}

export class Sandbox extends Context.Service<Sandbox, SandboxShape>()("nathapp/Sandbox") {}

/**
 * `bun`, `bunx` and `node` that always work: the Bun NathApp runs on (from
 * source), or the compiled server acting as Bun (BUN_BE_BUN).
 */
function writeShims(config: ServerConfigShape) {
  const dir = join(config.dataDir, "bin");
  mkdirSync(dir, { recursive: true });
  const bun = config.bunCommand.path;
  const beBun = Object.keys(config.bunCommand.env).length > 0;
  const script = (args: string) =>
    `#!/bin/sh\n${beBun ? "BUN_BE_BUN=1 " : ""}exec ${JSON.stringify(bun)} ${args}"$@"\n`;
  const shims: Record<string, string | null> = {
    bun: beBun ? script("") : null,
    node: beBun ? script("") : null,
    bunx: script("x "),
  };
  for (const [name, content] of Object.entries(shims)) {
    const path = join(dir, name);
    rmSync(path, { force: true });
    if (content === null) symlinkSync(bun, path); // run as `node`, Bun behaves like Node
    else writeFileSync(path, content, { mode: 0o755 });
  }
  return dir;
}

async function bwrapWorks() {
  if (process.platform !== "linux" || !Bun.which("bwrap")) return false;
  try {
    const proc = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "true"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Binds a top-level system path the way it exists on the host (dir or symlink like /bin → usr/bin). */
function systemPath(path: string): string[] {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return ["--symlink", readlinkSync(path), path];
    return ["--ro-bind", path, path];
  } catch {
    return [];
  }
}

const etcFiles = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/alternatives",
  "/etc/ld.so.cache",
];

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* Settings;
  const binDir = writeShims(config);
  const bunCache = join(config.cacheDir, "bun");
  mkdirSync(bunCache, { recursive: true });
  const available = yield* Effect.promise(bwrapWorks);

  const kind = settings.get().pipe(
    Effect.map(({ apps }): SandboxKind => (apps.sandbox === "none" || !available ? "none" : "bwrap")),
  );

  return {
    binDir,
    kind,
    spawnSpec: ({ dir, command, env, binds = [] }) =>
      Effect.gen(function* () {
        const home = join(dir, ".nathapp", "home");
        mkdirSync(home, { recursive: true });
        const base: Record<string, string> = {
          HOME: home,
          BUN_INSTALL_CACHE_DIR: bunCache,
          TMPDIR: "/tmp",
          LANG: process.env.LANG ?? "C.UTF-8",
          NO_COLOR: "1",
          ...env,
        };
        if ((yield* kind) === "none") {
          return {
            argv: ["/bin/sh", "-c", command],
            env: { ...base, PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
            cwd: dir,
          };
        }
        const sandboxEnv = { ...base, PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`, TMPDIR: "/tmp" };
        const argv = [
          Bun.which("bwrap") ?? "/usr/bin/bwrap",
          "--die-with-parent",
          "--new-session",
          "--unshare-pid",
          "--unshare-ipc",
          "--unshare-uts",
          "--unshare-cgroup-try",
          "--hostname",
          "nathapp",
          ...systemPath("/usr"),
          ...["/bin", "/sbin", "/lib", "/lib64", "/lib32"].flatMap(systemPath),
          ...etcFiles.flatMap((p) => ["--ro-bind-try", p, p]),
          // resolv.conf is often a link into /run (systemd-resolved).
          "--ro-bind-try",
          "/run/systemd/resolve",
          "/run/systemd/resolve",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/tmp",
          "--ro-bind",
          binDir,
          binDir,
          "--ro-bind",
          config.bunCommand.path,
          config.bunCommand.path,
          "--bind",
          bunCache,
          bunCache,
          "--bind",
          dir,
          dir,
          ...binds.flatMap((path) => ["--bind", path, path]),
          "--chdir",
          dir,
          "--",
          "/bin/sh",
          "-c",
          command,
        ];
        // The environment goes to bwrap as its own (exactly this, nothing inherited) and on to
        // the app: never in the arguments, which every process on the machine can read.
        return { argv, env: sandboxEnv, cwd: dir };
      }),
  } satisfies SandboxShape;
});

export const layer = Layer.effect(Sandbox, make);
