// Custom app backends: TypeScript the agent writes into the app's backend
// folder, run with Bun on a free port. The entry point is server.ts; the
// realtime SDK is kept next to it as gapp.ts. Backends reach the app's data
// through the SDK (so writes are broadcast), and the UI reaches the backend
// through the gApp server (/api/apps/:id/backend/...).
//
// Backend code runs unsandboxed with the user's permissions, like any program
// they'd run themselves; it only gets a minimal environment (no credentials).
import type { Subprocess } from "bun";
import { BACKEND_ENTRY, type BackendStatus } from "../shared/api";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, normalize, relative, sep } from "node:path";
import { dataDir } from "./config";
import { publish, topics } from "./hub";
import { sdkSource } from "./sdk";

export const ENTRY = BACKEND_ENTRY;
const SDK_FILE = "gapp.ts";
const backendsDir = join(dataDir, "backends");
mkdirSync(backendsDir, { recursive: true });

export const backendDir = (appId: string) => join(backendsDir, appId);
export const hasBackend = (appId: string) => existsSync(join(backendDir(appId), ENTRY));

/** The gApp server's own URL; set at startup. Backends use it via $GAPP_URL. */
let gappUrl = "";
export function setGappUrl(url: string) {
  gappUrl = url.replace(/\/$/, "");
}

export type { BackendStatus };

interface Backend {
  proc: Subprocess | null;
  port: number | null;
  state: BackendStatus["state"];
  startedAt: string | null;
  exitCode: number | null;
  logs: string[];
  starting?: Promise<BackendStatus>;
}

const backends = new Map<string, Backend>();
const MAX_LOG_LINES = 500;

function entry(appId: string): Backend {
  let b = backends.get(appId);
  if (!b) {
    b = { proc: null, port: null, state: "stopped", startedAt: null, exitCode: null, logs: [] };
    backends.set(appId, b);
  }
  return b;
}

export function backendStatus(appId: string): BackendStatus {
  const b = backends.get(appId);
  return {
    exists: hasBackend(appId),
    state: b?.state ?? "stopped",
    port: b?.port ?? null,
    startedAt: b?.startedAt ?? null,
    exitCode: b?.exitCode ?? null,
    pid: b?.proc?.pid ?? null,
  };
}

export const backendLogs = (appId: string, lines = 100) => (backends.get(appId)?.logs ?? []).slice(-lines);

function log(appId: string, line: string) {
  const b = entry(appId);
  b.logs.push(line);
  if (b.logs.length > MAX_LOG_LINES) b.logs.splice(0, b.logs.length - MAX_LOG_LINES);
  publish({ type: "backend", topic: topics.backend(appId), appId, log: line });
}

function announce(appId: string) {
  publish({ type: "backend", topic: topics.backend(appId), appId, status: backendStatus(appId) });
}

// --- Files ---------------------------------------------------------------------

export class BackendError extends Error {}

/** Resolves a path inside the app's backend folder, refusing anything outside it. */
function resolvePath(appId: string, path: string) {
  const root = backendDir(appId);
  const full = normalize(join(root, path));
  if (!full.startsWith(root + sep) || !path.trim()) throw new BackendError(`Invalid path "${path}"`);
  return full;
}

const hidden = new Set(["node_modules", ".git", "bun.lock", "bun.lockb"]);

export function listFiles(appId: string): { path: string; size: number }[] {
  const root = backendDir(appId);
  if (!existsSync(root)) return [];
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (hidden.has(name)) continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push({ path: relative(root, full).split(sep).join("/"), size: stat.size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readBackendFile(appId: string, path: string) {
  const full = resolvePath(appId, path);
  if (!existsSync(full)) throw new BackendError(`No file "${path}"`);
  return readFileSync(full, "utf8");
}

export function writeBackendFile(appId: string, path: string, content: string) {
  if (path === SDK_FILE) throw new BackendError(`${SDK_FILE} is managed by gApp (the realtime SDK) and can't be changed`);
  const full = resolvePath(appId, path);
  if (full.includes(`${sep}node_modules${sep}`)) throw new BackendError("Use install_packages for dependencies");
  ensureScaffold(appId);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function deleteBackendFile(appId: string, path: string) {
  const full = resolvePath(appId, path);
  if (!existsSync(full)) throw new BackendError(`No file "${path}"`);
  rmSync(full, { recursive: true });
}

/** Creates the folder with the SDK and a package.json; refreshes the SDK every time. */
function ensureScaffold(appId: string) {
  const dir = backendDir(appId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SDK_FILE), `// Managed by gApp: the realtime SDK. Changes are overwritten.\n${sdkSource}`);
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) writeFileSync(pkg, `${JSON.stringify({ name: `gapp-backend`, private: true, type: "module" }, null, 2)}\n`);
}

export function deleteBackend(appId: string) {
  stopBackend(appId);
  backends.delete(appId);
  rmSync(backendDir(appId), { recursive: true, force: true });
}

export function copyBackend(fromId: string, toId: string) {
  if (!existsSync(backendDir(fromId))) return;
  cpSync(backendDir(fromId), backendDir(toId), {
    recursive: true,
    filter: (src) => !src.split(sep).includes("node_modules"),
  });
}

// --- Processes -----------------------------------------------------------------

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Runs Bun. From source `process.execPath` is Bun itself; in the packaged app
 * it is the compiled gApp server, which acts as the Bun CLI with BUN_BE_BUN=1.
 */
function bunEnv(appId: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { BUN_BE_BUN: "1", GAPP_URL: gappUrl, GAPP_APP_ID: appId, ...extra };
  for (const key of ["PATH", "HOME", "USER", "LANG", "TZ", "TMPDIR", "SystemRoot", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

async function pipeLines(appId: string, stream: ReadableStream<Uint8Array> | null, prefix = "") {
  if (!stream) return;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) log(appId, prefix + line);
  }
  if (buffer) log(appId, prefix + buffer);
}

/** Runs a Bun command in the backend folder and returns its output. */
export async function runBun(appId: string, args: string[], timeoutMs = 60_000) {
  ensureScaffold(appId);
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: backendDir(appId),
    env: bunEnv(appId),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
  return { exitCode, timedOut, output: output.length > 20_000 ? `…${output.slice(-20_000)}` : output };
}

async function needsInstall(appId: string) {
  const dir = backendDir(appId);
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: object };
    return !!pkg.dependencies && Object.keys(pkg.dependencies).length > 0 && !existsSync(join(dir, "node_modules"));
  } catch {
    return false;
  }
}

async function waitForPort(port: number, proc: Subprocess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode) return false;
    const ok = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })
      .then((s) => (s.end(), true))
      .catch(() => false);
    if (ok) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** Starts the backend (no-op if it's already running). Resolves once it listens or fails. */
export function startBackend(appId: string): Promise<BackendStatus> {
  const b = entry(appId);
  if (b.state === "running" && b.proc) return Promise.resolve(backendStatus(appId));
  if (b.starting) return b.starting;
  if (!hasBackend(appId)) return Promise.reject(new BackendError(`No ${ENTRY} yet; write one with write_file first`));

  b.starting = (async () => {
    ensureScaffold(appId);
    b.state = "starting";
    b.exitCode = null;
    announce(appId);
    if (await needsInstall(appId)) {
      log(appId, "[gapp] installing dependencies…");
      const res = await runBun(appId, ["install"], 120_000);
      if (res.output) for (const line of res.output.split("\n")) log(appId, line);
    }
    const port = await freePort();
    log(appId, `[gapp] starting ${ENTRY} on port ${port}`);
    const proc = Bun.spawn([process.execPath, "run", ENTRY], {
      cwd: backendDir(appId),
      env: bunEnv(appId, { PORT: String(port) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    b.proc = proc;
    b.port = port;
    b.startedAt = new Date().toISOString();
    void pipeLines(appId, proc.stdout);
    void pipeLines(appId, proc.stderr);
    void proc.exited.then((code) => {
      if (b.proc !== proc) return; // replaced by a restart
      b.proc = null;
      b.exitCode = code;
      b.state = b.state === "stopped" ? "stopped" : "crashed";
      log(appId, `[gapp] exited with code ${code}`);
      announce(appId);
    });

    const listening = await waitForPort(port, proc, 10_000);
    if (listening) {
      b.state = "running";
    } else if (b.proc === proc) {
      // Exited or never opened the port: report it as crashed.
      proc.kill();
      b.state = "crashed";
      log(appId, `[gapp] ${ENTRY} did not listen on $PORT (${port}) within 10s`);
    }
    announce(appId);
    return backendStatus(appId);
  })().finally(() => {
    b.starting = undefined;
  });
  return b.starting;
}

export function stopBackend(appId: string) {
  const b = backends.get(appId);
  if (!b?.proc) return;
  b.state = "stopped";
  b.proc.kill();
  b.proc = null;
  b.port = null;
  announce(appId);
}

export async function restartBackend(appId: string) {
  stopBackend(appId);
  return startBackend(appId);
}

export function stopAllBackends() {
  for (const b of backends.values()) b.proc?.kill();
}

/**
 * URL of the running backend, starting a stopped one on demand. Null if the app
 * has none or it crashed (it's restarted explicitly, not on every request).
 */
export async function backendUrl(appId: string): Promise<string | null> {
  if (!hasBackend(appId)) return null;
  const b = entry(appId);
  const status = b.state === "crashed" ? backendStatus(appId) : await startBackend(appId);
  return status.state === "running" && status.port ? `http://127.0.0.1:${status.port}` : null;
}
