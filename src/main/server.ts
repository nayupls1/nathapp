import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadSecretsKey } from "./secretsKey";

export interface ServerHandle {
  url: string;
  /** Required on every API request; only gApp's own window gets it. */
  token: string;
  stop: () => void;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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
 * In dev we run the TypeScript source directly with Bun (with --watch, so the
 * server hot-restarts on change). In production we run the standalone binary
 * produced by `bun build --compile`, so end users don't need Bun installed.
 */
function serverCommand(): { command: string; args: string[] } {
  if (process.env.VITE_DEV_SERVER_URL) {
    const bun = process.env.GAPP_BUN_PATH || "bun";
    return { command: bun, args: ["--watch", join(app.getAppPath(), "src/server/index.ts")] };
  }

  const binary = process.platform === "win32" ? "gapp-server.exe" : "gapp-server";
  const dir = app.isPackaged
    ? join(process.resourcesPath, "server")
    : join(app.getAppPath(), "dist/server");
  return { command: join(dir, binary), args: [] };
}

async function waitForHealthy(url: string, child: ChildProcess, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

export async function startServer(allowedOrigin: string): Promise<ServerHandle> {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("hex");
  const { command, args } = serverCommand();
  let secretsKey: ReturnType<typeof loadSecretsKey> = null;
  try {
    secretsKey = loadSecretsKey();
  } catch (err) {
    console.error("Couldn't load the secrets key:", err);
  }

  const child = spawn(command, args, {
    env: {
      ...process.env,
      PORT: String(port),
      GAPP_ALLOWED_ORIGIN: allowedOrigin,
      GAPP_TOKEN: token,
      GAPP_PARENT: "electron",
      GAPP_DATA_DIR: join(app.getPath("userData"), "data"),
      // Dev only: `bun --watch` restarts the server, which then can't read stdin again.
      ...(process.env.VITE_DEV_SERVER_URL && secretsKey ? { GAPP_DEV_SECRETS_KEY: JSON.stringify(secretsKey) } : {}),
    },
    // stdin stays piped so the server can detect when the app goes away.
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });

  // The secrets key goes over stdin, not the environment (other processes of the user can read that).
  child.stdin!.write(`${JSON.stringify({ secretsKey })}\n`);

  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill();
  };

  try {
    await waitForHealthy(url, child);
  } catch (err) {
    stop();
    throw err;
  }

  return { url, token, stop };
}
