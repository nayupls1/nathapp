import type { HealthResponse, HelloResponse } from "../shared/api";

// The Electron main process picks a free port and passes it in. When running
// the server standalone (`bun run server`) it falls back to 3000.
const port = Number(process.env.PORT ?? 3000);

// Only the app's own renderer may call the API from a browser context.
const allowedOrigin = process.env.GAPP_ALLOWED_ORIGIN ?? "http://localhost:5173";

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json<T>(data: T, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { ...corsHeaders, ...init?.headers } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/api/health": () =>
      json<HealthResponse>({ ok: true, uptime: process.uptime(), bun: Bun.version }),

    "/api/hello": (req) => {
      const name = new URL(req.url).searchParams.get("name") || "world";
      return json<HelloResponse>({
        message: `Hello, ${name}! (from Bun ${Bun.version})`,
        time: new Date().toISOString(),
      });
    },
  },
  fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    return json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[server] listening on ${server.url}`);

// When spawned by Electron, stdin is a pipe owned by the main process. If the
// app dies without shutting us down cleanly, the pipe closes and we exit too.
if (process.env.GAPP_PARENT === "electron") {
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
