import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, type Row } from "../src/sdk/gapp";
import type { AppSpec } from "../src/shared/spec";
import { startServer } from "./lib/server";

let server: Awaited<ReturnType<typeof startServer>>;
let appId: string;

const spec: AppSpec = {
  name: "Realtime",
  icon: "zap",
  tables: [{ name: "notes", columns: [{ name: "text", type: "text", required: true }] }],
  ui: { type: "list", table: "notes", primary: "text" },
};

/** Resolves once `predicate` holds for a value pushed into `values`. */
function waitFor<T>(values: T[], predicate: (v: T) => boolean, timeoutMs = 3000) {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = values.find(predicate);
      if (hit !== undefined) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeAll(async () => {
  server = await startServer();
  appId = (await server.api<{ id: string }>("/api/apps", { method: "POST" })).id;
  await server.api(`/api/apps/${appId}/spec`, { method: "PUT", json: spec });
});

afterAll(() => server.stop());

describe("realtime SDK", () => {
  test("live queries update on writes from another client", async () => {
    const a = connect({ url: server.url, appId });
    const b = connect({ url: server.url, appId });
    const seen: Row[][] = [];
    const stop = b.live("notes", {}, (rows) => seen.push(rows));
    await waitFor(seen, (rows) => rows.length === 0);

    const started = performance.now();
    expect(await a.insert("notes", { text: "hello" })).toBe(1);
    const rows = await waitFor(seen, (r) => r.length === 1);
    const latency = performance.now() - started;
    expect(rows[0]!.text).toBe("hello");
    expect(latency).toBeLessThan(500);

    await a.update("notes", { text: "hello" }, { text: "edited" });
    await waitFor(seen, (r) => r[0]?.text === "edited");
    await a.delete("notes", {});
    await waitFor(seen, (r) => r.length === 0 && seen.indexOf(r) > 1);

    stop();
    a.close();
    b.close();
  });

  test("channels deliver messages to other subscribers", async () => {
    const a = connect({ url: server.url, appId });
    const b = connect({ url: server.url, appId });
    const got: unknown[] = [];
    b.channel("cursor").on((data) => got.push(data));
    await Bun.sleep(100); // let the subscription reach the server
    a.channel("cursor").send({ x: 1 });
    expect(await waitFor(got, () => true)).toEqual({ x: 1 });
    a.close();
    b.close();
  });

  test("invalid writes reject with the server's message", async () => {
    const a = connect({ url: server.url, appId });
    await expect(a.insert("notes", {})).rejects.toThrow("required");
    await expect(a.query("nope")).rejects.toThrow('Unknown table "nope"');
    a.close();
  });
});

describe("origin guard", () => {
  test("websites can't write or open sockets", async () => {
    const res = await fetch(`${server.url}/api/apps`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    const ws = await fetch(`${server.url}/api/ws`, {
      headers: { Origin: "https://evil.example", Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(ws.status).toBe(403);
    // Reads stay allowed (CORS keeps their responses from foreign pages).
    expect((await fetch(`${server.url}/api/health`, { headers: { Origin: "https://evil.example" } })).status).toBe(200);
  });

  test("spec import validates", async () => {
    await expect(server.api(`/api/apps/${appId}/spec`, { method: "PUT", json: { ...spec, icon: "nope-nope" } })).rejects.toThrow(
      "unknown icon",
    );
  });
});
