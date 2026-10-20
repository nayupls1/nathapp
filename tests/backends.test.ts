import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect, type Row } from "../src/sdk/gapp";
import type { BackendStatus, RuntimeInfo } from "../src/shared/api";
import type { AppSpec } from "../src/shared/spec";
import { startServer } from "./lib/server";

let server: Awaited<ReturnType<typeof startServer>>;
let appId: string;

const spec: AppSpec = {
  name: "Backend test",
  tables: [{ name: "pings", columns: [{ name: "note", type: "text" }] }],
  ui: { type: "button", label: "Ping", action: { type: "backend", path: "/api/ping" } },
};

const serverTs = `import { connect } from "./gapp";
const gapp = connect();
Bun.serve({
  port: Number(process.env.PORT),
  routes: {
    "/api/hello": () => Response.json({ hello: "world", app: process.env.GAPP_APP_ID }),
    "/api/ping": {
      POST: async (req) => {
        const body = await req.json().catch(() => ({}));
        await gapp.insert("pings", { note: body.note ?? "pong" });
        return Response.json({ ok: true });
      },
    },
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
    return new Response("Not found", { status: 404 });
  },
  websocket: { message: (ws, msg) => ws.send("echo:" + msg) },
});
console.log("backend up");
`;

const putFile = (path: string, content: string) =>
  fetch(`${server.url}/api/apps/${appId}/files/${path}`, { method: "PUT", body: content });
const control = (action: string) =>
  server.api<BackendStatus>(`/api/apps/${appId}/runtime`, { method: "POST", json: { action } });

beforeAll(async () => {
  server = await startServer();
  appId = (await server.api<{ id: string }>("/api/apps", { method: "POST" })).id;
  await server.api(`/api/apps/${appId}/spec`, { method: "PUT", json: spec });
});

afterAll(() => server.stop());

describe("custom backends", () => {
  test("runs server.ts and proxies HTTP to it", async () => {
    expect((await putFile("server.ts", serverTs)).status).toBe(204);
    const status = await control("start");
    expect(status.state).toBe("running");
    const res = await fetch(`${server.url}/api/apps/${appId}/backend/api/hello`);
    expect(await res.json()).toEqual({ hello: "world", app: appId });

    const runtime = await server.api<RuntimeInfo>(`/api/apps/${appId}/runtime`);
    expect(runtime.files.map((f) => f.path)).toEqual(["gapp.ts", "package.json", "server.ts"]);
    expect(runtime.logs).toContain("backend up");
  }, 20_000);

  test("backend writes through the SDK reach live queries", async () => {
    const gapp = connect({ url: server.url, appId });
    const seen: Row[][] = [];
    const stop = gapp.live("pings", {}, (rows) => seen.push(rows));
    const res = await fetch(`${server.url}/api/apps/${appId}/backend/api/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "from backend" }),
    });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && !seen.some((r) => r[0]?.note === "from backend"); i++) await Bun.sleep(20);
    expect(seen.at(-1)?.[0]?.note).toBe("from backend");
    stop();
    gapp.close();
  });

  test("proxies WebSockets", async () => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/apps/${appId}/backend/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("socket error"));
    });
    expect(reply).toBe("echo:hi");
    ws.close();
  });

  test("reports crashes with logs", async () => {
    await putFile("server.ts", `throw new Error("boom at startup");`);
    const status = await control("restart");
    expect(status.state).toBe("crashed");
    const runtime = await server.api<RuntimeInfo>(`/api/apps/${appId}/runtime`);
    expect(runtime.logs.join("\n")).toContain("boom at startup");
    // A crashed backend isn't restarted by requests.
    expect((await fetch(`${server.url}/api/apps/${appId}/backend/api/hello`)).status).toBe(502);
  }, 20_000);

  test("files stay inside the backend folder", async () => {
    expect((await putFile("..%2F..%2Fescape.ts", "x")).status).toBe(400);
    expect((await putFile("gapp.ts", "x")).status).toBe(400);
  });

  test("deleting the app removes its backend", async () => {
    await control("stop");
    await fetch(`${server.url}/api/apps/${appId}`, { method: "DELETE" });
    expect(existsSync(join(server.dataDir, "backends", appId))).toBe(false);
  });
});
