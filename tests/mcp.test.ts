// gApp's MCP endpoint: what agents see when they connect (the provider CLIs
// validate tool schemas strictly and drop the whole server if one is off).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Schema, Scope } from "effect";
import { make, tool, type Tool } from "../src/server/agent/Mcp";
import { appTools, pageTools, siteTools } from "../src/server/agent/tools";
import { tokensLayer } from "../src/server/ai/AiTokens";
import { readConfig, ServerConfig } from "../src/server/Config";
import * as Apps from "../src/server/db/Apps";
import * as Db from "../src/server/db/Db";
import * as Settings from "../src/server/db/Settings";
import * as Sites from "../src/server/db/Sites";
import * as Hub from "../src/server/Hub";
import * as Runtime from "../src/server/workspace/Runtime";
import * as Sandbox from "../src/server/workspace/Sandbox";
import * as Workspace from "../src/server/workspace/Workspace";

const dataDir = mkdtempSync(join(tmpdir(), "gapp-mcp-test-"));
const config = readConfig({ GAPP_DATA_DIR: dataDir, PORT: "1" });
const runtime = ManagedRuntime.make(
  Runtime.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Workspace.layer, Sandbox.layer)),
    Layer.provideMerge(Layer.mergeAll(Apps.layer, Settings.layer, Sites.layer, Hub.layer, tokensLayer)),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  ),
);

afterAll(async () => {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const env = { tabId: "tab", log: () => Effect.void };

async function session(tools: Tool[]) {
  const mcp = await Effect.runPromise(make("http://gapp"));
  const scope = await Effect.runPromise(Scope.make());
  const url = await Effect.runPromise(mcp.register(tools).pipe(Scope.provide(scope)));
  const token = url.split("/").pop()!;
  let id = 0;
  const rpc = (method: string, params?: unknown) => Effect.runPromise(mcp.handle(token, { jsonrpc: "2.0", id: ++id, method, params })) as Promise<any>;
  return { mcp, url, token, rpc, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

describe("mcp", () => {
  test("handshake, listing and calls", async () => {
    const s = await session([
      tool("echo", "Echo", Schema.Struct({ text: Schema.String }), ({ text }) => Effect.succeed(text)),
      tool("boom", "Fails", Schema.Struct({}), () => Effect.fail(new Error("kaputt"))),
    ]);
    expect(s.url).toStartWith("http://gapp/mcp/");
    const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect(await Effect.runPromise(s.mcp.handle(s.token, { jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();

    const list = await s.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom"]);
    expect(list.result.tools[1].inputSchema).toEqual({ type: "object", properties: {} });

    expect((await s.rpc("tools/call", { name: "echo", arguments: { text: "hi" } })).result).toEqual({
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
    expect((await s.rpc("tools/call", { name: "echo", arguments: {} })).result.isError).toBe(true);
    expect((await s.rpc("tools/call", { name: "boom", arguments: {} })).result).toMatchObject({
      content: [{ text: "kaputt" }],
      isError: true,
    });
    expect((await s.rpc("tools/call", { name: "nope" })).error.code).toBe(-32602);
    expect((await s.rpc("resources/list")).error.code).toBe(-32601);

    await s.close();
    await expect(Effect.runPromise(s.mcp.handle(s.token, { jsonrpc: "2.0", id: 1, method: "ping" }))).rejects.toBeDefined();
  });

  test("every gApp tool has an object input schema", async () => {
    const tools = await runtime.runPromise(
      Effect.gen(function* () {
        return [...(yield* pageTools(env, { site: true })), ...(yield* siteTools(env)), ...(yield* appTools(env))];
      }),
    );
    const s = await session(tools);
    const list = await s.rpc("tools/list");
    expect(list.result.tools.length).toBe(tools.length);
    for (const t of list.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      // Numbers are plain numbers (not "number or the string NaN").
      for (const prop of Object.values(t.inputSchema.properties ?? {}) as { anyOf?: unknown }[]) expect(prop.anyOf).toBeUndefined();
    }
    await s.close();
  });
});
