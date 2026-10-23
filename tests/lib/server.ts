// Starts the real Bun server on a free port with a throwaway data dir.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function freePort() {
  return new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer() {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "gapp-server-test-"));
  const url = `http://127.0.0.1:${port}`;
  const token = crypto.randomUUID();
  const proc = Bun.spawn([process.execPath, "src/server/index.ts"], {
    env: { ...process.env, PORT: String(port), GAPP_DATA_DIR: dataDir, GAPP_ALLOWED_ORIGIN: "app://gapp", GAPP_TOKEN: token },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await Bun.sleep(50);
  }

  const api = async <T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init?.headers },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  return {
    url,
    port,
    token,
    /** The hub WebSocket URL (authenticated). */
    wsUrl: `${url.replace("http", "ws")}/api/ws?token=${token}`,
    dataDir,
    api,
    async stop() {
      proc.kill();
      await proc.exited;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
