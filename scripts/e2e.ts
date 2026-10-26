// End-to-end check of the built app: launches Electron against a throwaway
// profile and drives the real UI over the DevTools protocol.
//
//   bun run e2e                 UI checks (providers, app previews, dev/live, web tabs, settings)
//   bun run e2e --agent         also has the agents build an app and customize a site (uses your Claude plan)
//   bun run e2e --agent "..."   ...with a custom prompt
//   bun run e2e --visible       show the window while testing (default: offscreen)
//   bun run e2e --only <text>   only the checks whose name contains it (and the boot check)
//
// Screenshots go to test-results/. Run `bun run build` first.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchElectron } from "./electron";
import { Page } from "./lib/cdp";
import { writeFixtureBrowser } from "./lib/fixture-browser";

const args = process.argv.slice(2);
const agentIndex = args.indexOf("--agent");
const agentPrompt =
  agentIndex === -1
    ? undefined
    : (args[agentIndex + 1] ?? "A tiny reading list: book title, author, and whether I've finished it.");

if (!existsSync("dist/electron/main.cjs")) {
  console.error("No build found — run `bun run build` first.");
  process.exit(1);
}

const outDir = "test-results";
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "nathapp-e2e-"));
// A browser to import extensions from (instead of the real ones on this computer).
const browserDir = mkdtempSync(join(tmpdir(), "nathapp-e2e-browser-"));
const fixture = writeFixtureBrowser(browserDir);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];

const port = await new Promise<number>((resolve) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});

// Rendered offscreen by default: always painted (reliable screenshots). The
// headless ozone platform doesn't connect to the display server at all, so no
// window can show up on the user's screen (Wayland compositors ignore window
// positions and would open it wherever the user is). --visible shows it.
const visible = args.includes("--visible");
const electron = await launchElectron({ NATHAPP_USER_DATA_DIR: profile, NATHAPP_OFFSCREEN: visible ? undefined : "1", NATHAPP_BROWSER_DIRS: fixture.dirs, NATHAPP_EXTENSION_UPDATES: "0" }, [
  ...(visible ? [] : ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080"]),
  // No OS keychain (it could ask to be unlocked): the secrets key falls back to a file.
  "--password-store=basic",
  `--remote-debugging-port=${port}`,
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
]);

// A small website for the web tab checks. /feed loads its data from /api/feed
// with credentials of every kind (a cookie, a key in the URL, a bearer token).
const siteSeen: { url: string; authorization: string | null; cookie: string | null }[] = [];
const feedPage = `<title>Feed</title><h1>Feed</h1><p id="status">Loading…</p><script>
  document.cookie = "sid=cookie-secret-1; path=/";
  fetch("/api/feed?page=1&api_key=key-secret-2", { headers: { Authorization: "Bearer bearer-secret-3" } })
    .then((r) => r.json())
    .then((d) => (document.getElementById("status").textContent = "Loaded " + d.items.length + " items"))
    .catch(() => (document.getElementById("status").textContent = "Failed to load"));
</script>`;
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api/feed") {
      siteSeen.push({ url: req.url, authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie") });
      return Response.json({ items: [{ id: 1, title: "First post" }, { id: 2, title: "Second post" }], page: Number(url.searchParams.get("page")), sessionToken: "resp-secret-4" });
    }
    const body =
      path === "/feed"
        ? feedPage
        : path === "/act"
        ? `<title>Act page</title><h1>Act</h1><form action="/act-done"><input id="q" name="q"><button id="go">Search</button></form>
           <select id="size"><option>S</option><option>M</option></select><input type="checkbox" id="gift">
           <button id="next" onclick="document.getElementById('out').textContent = 'clicked next ' + event.isTrusted">Next</button><p id="out"></p>`
        : path === "/act-done"
        ? `<title>Searched</title><h1>Results for ${url.searchParams.get("q")}</h1>`
        : path === "/form"
        ? `<title>Form page</title><h1>Form</h1><div style="height:2400px"></div><input id="note" value=""><textarea id="long"></textarea><input id="pw" type="password">`
        : path === "/second"
        ? `<title>Second page</title><h1>Second</h1>`
        : path === "/blocked-by-extension"
        ? `<title>Should be blocked</title>`
        : `<title>Test site</title><main><h1 id="headline">Hello from the test site</h1><p class="lead">Plain text</p>
           <button class="cta">Buy now</button> <a id="popup" href="/second" target="_blank">open popup</a></main>`;
    return new Response(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">${body}`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

const results: { name: string; ok: boolean; detail?: string }[] = [];
let webTabId: string | undefined;
const pageErrors: string[] = [];
let page: Page | undefined;
const skippedShots: string[] = [];

/**
 * Screenshots are for looking at, not assertions. A window the compositor
 * doesn't paint (e.g. on another workspace) never delivers a frame, so give up
 * after a few seconds instead of failing the check.
 */
async function shot(name: string) {
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000));
  const result = await Promise.race([page!.screenshot(join(outDir, name)).catch(() => "timeout" as const), timeout]);
  if (result === "timeout") skippedShots.push(name);
}

async function check(name: string, fn: () => Promise<string | void>) {
  if (only && !name.includes(only) && !name.startsWith("app boots")) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || undefined });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""} (${Date.now() - started}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name} — ${detail}`);
    if (page) await shot(`failure-${results.length}.png`);
  }
}

/** Polls an async function until it returns something other than undefined. */
async function waitForValue<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

/** Opens the sidebar's "New tab" menu and picks an entry. */
async function newTab(label: "New app" | "New web tab") {
  await click("[data-new-tab]");
  await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "new tab menu" });
  await click("[data-context-menu] button", label);
}

/** Authenticated request to the NathApp server, made from the renderer. */
const apiCall = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
  page!.eval<T>(`fetch(window.nathapp.serverUrl + ${JSON.stringify(path)}, {
    method: ${JSON.stringify(init.method ?? "GET")},
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.nathapp.token },
    ${init.body !== undefined ? `body: ${JSON.stringify(JSON.stringify(init.body))},` : ""}
  }).then(async (r) => { if (!r.ok) throw new Error(r.status + " " + (await r.text())); return r.status === 204 ? null : r.json(); })`);

/** Picks provider, model and effort in the agent picker inside `root`. */
async function chooseAgent(root: string, provider: string, model: string, effort?: string) {
  await click(`${root} [data-agent-picker]`);
  await page!.waitFor(`!!document.querySelector("[data-agent-popover]")`, { label: "agent picker" });
  await click(`[data-agent-popover] [data-provider="${provider}"]`);
  await page!.waitFor(`!!document.querySelector('[data-agent-popover] [data-model="${model}"]')`, { timeoutMs: 30_000, label: `${model} in the list` });
  await click(`[data-agent-popover] [data-model="${model}"]`);
  await page!.waitFor(`!document.querySelector("[data-agent-popover]")`);
  if (effort) {
    await click(`${root} [data-effort-picker]`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`);
    await click("[data-context-menu] button", effort);
  }
}

/** Types a prompt into the composer inside `root` and sends it. */
const sendPrompt = (root: string, prompt: string) =>
  page!.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(`${root} textarea`)});
    t.value = ${JSON.stringify(prompt)};
    t.dispatchEvent(new InputEvent("input", { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);

/** The agent sidebar while it shows a tab's agent. */
const agentOf = (tabId: string) => `[data-agent-for="${tabId}"]`;

/** Waits until the agent in the agent sidebar `panel` started and finished. */
async function agentDone(panel: string) {
  await page!.waitFor(`!!document.querySelector(${JSON.stringify(panel)})`, { label: "chat to open", timeoutMs: 15_000 });
  await page!.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(`${panel} button`)})].some((b) => b.textContent === "Send") && !document.querySelector(${JSON.stringify(panel)}).innerText.includes("Working…")`,
    { timeoutMs: 300_000, label: "agent to finish" },
  );
  return page!.eval<string>(`document.querySelector(${JSON.stringify(panel)}).innerText`);
}

/** Runs code in the webview inside `root` (an app preview or web tab). */
const inView = <T>(root: string, code: string, gesture = false) =>
  page!.eval<T>(`document.querySelector(${JSON.stringify(`${root} webview`)}).executeJavaScript(${JSON.stringify(code)}, ${gesture})`);

const click = (selector: string, text?: string) =>
  page!.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) throw new Error(${JSON.stringify(`not found: ${selector} ${text ?? ""}`)});
    el.click();
    return true;
  })()`);

try {
  console.log("Launching NathApp…");
  page = await Page.connect(port);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  page.acceptDialogs();
  page.on("Runtime.exceptionThrown", (e) => pageErrors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", (e) => {
    if (e.type === "error") pageErrors.push(e.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
  });
  await page.attachChildren();
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  await check("app boots and shows the sidebar", async () => {
    await page!.waitFor(`!!document.querySelector('[data-page-link="Settings"]')`, { timeoutMs: 20_000 });
  });

  await check("providers are detected", async () => {
    const providers = await waitForValue(async () => {
      const list = await apiCall<{ id: string; state: string; models: unknown[] }[]>("/api/providers");
      return list.every((p) => p.state !== "checking") ? list : undefined;
    }, 60_000);
    const claude = providers.find((p) => p.id === "claude");
    if (claude?.state !== "ready" || !claude.models.length) throw new Error(`Claude isn't ready: ${JSON.stringify(claude)}`);
    return providers.map((p) => `${p.id} ${p.state} (${p.models.length})`).join(", ");
  });

  let appId = "";
  const appTab = () => `[data-app-tab="${appId}"]`;

  await check("new app screen with the agent picker", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New app");
    await page!.waitFor(`document.body.innerText.includes("What do you want to build?")`);
    appId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "new app in the sidebar" },
    );
    // A new app tab opens with the agent sidebar, ready to describe the app.
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${appId}"] textarea')`, { label: "agent sidebar open on a new app" });
    await click("[data-agent-picker]");
    await page!.waitFor(`!!document.querySelector("[data-agent-popover]")`, { label: "picker popover" });
    const rail = await page!.eval<number>(`document.querySelectorAll("[data-agent-popover] [data-provider]").length`);
    const models = await page!.waitFor<number>(`document.querySelectorAll("[data-agent-popover] [data-model]").length`, { label: "models" });
    await shot("agent-picker.png");
    await page!.eval(`document.querySelector("[data-agent-popover] input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-agent-popover]")`, { label: "Escape to close" });
    await shot("new-app.png");
    return `${rail} providers, ${models} Claude models`;
  });

  await check("a template runs in the preview (dev server)", async () => {
    await click('[data-template="vanilla"]');
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 120_000, label: "app running" });
    await page!.waitFor(`!!document.querySelector('${appTab()} webview')`, { label: "preview" });
    const heading = await waitForValue(async () => (await inView<string>(appTab(), `document.querySelector("h1")?.textContent || undefined`)) ?? undefined, 20_000);
    await shot("app-dev.png");
    return `"${heading}"`;
  });

  await check("edits show up live in dev mode", async () => {
    const file = join(profile, "data", "apps", appId, "src", "main.ts");
    const source = await Bun.file(file).text();
    if (!source.includes("A starting point:")) throw new Error("template changed; update this check");
    await Bun.write(file, source.replace("A starting point:", "Edited live:"));
    await waitForValue(async () => ((await inView<string>(appTab(), `document.body.innerText`)).includes("Edited live:") ? true : undefined), 20_000);
  });

  await check("element picker in the preview", async () => {
    await click(`${appTab()} [data-pick-element]`);
    await waitForValue(async () => ((await inView<boolean>(appTab(), `!!window.__nathappPicker`)) ? true : undefined));
    await inView(appTab(), `document.querySelector("h1").click(), true`);
    await page!.waitFor(`!!document.querySelector('${agentOf(appId)} [data-picked-chip]')`, { label: "picked chip" });
  });

  await check("done: hiding the agent builds the app and serves it with its start command", async () => {
    await click(`${agentOf(appId)} [data-agent-hide]`);
    await page!.waitFor(`!document.querySelector('${agentOf(appId)}')`, { label: "agent hidden" });
    await page!.waitFor(`!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { label: "restart", timeoutMs: 10_000 }).catch(() => {});
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 120_000, label: "live app running" });
    const status = await apiCall<{ status: { mode: string; state: string } }>(`/api/apps/${appId}/runtime`);
    if (status.status.mode !== "live") throw new Error(`mode is ${status.status.mode}`);
    await waitForValue(async () => ((await inView<string>(appTab(), `document.body.innerText`)).includes("Edited live:") ? true : undefined), 20_000);
    await click(`${appTab()} [data-logs]`);
    await page!.waitFor(`document.querySelector('${appTab()} [data-logs-panel]')?.innerText.includes("bun run start")`, { label: "logs" });
    await shot("app-live.png");
    await click(`${appTab()} [data-logs]`);
    // Showing the agent again goes back to editing: the dev server.
    await click(`${appTab()} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${agentOf(appId)}')`, { label: "agent shown" });
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"][data-mode="dev"]')`, { timeoutMs: 120_000, label: "dev server running" });
    const back = await apiCall<{ status: { mode: string } }>(`/api/apps/${appId}/runtime`);
    if (back.status.mode !== "dev") throw new Error(`mode is ${back.status.mode} after showing the agent`);
  });

  await check("history: a snapshot shows the change, and undoing it reverts the app", async () => {
    await click(`${appTab()} [data-history-button]`);
    const panel = `${appTab()} [data-history-panel]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-snapshot]')`, { label: "template snapshot" });
    await click(`${panel} [data-save-snapshot]`);
    await page!.waitFor(`document.querySelectorAll('${panel} [data-snapshot]').length >= 2`, { label: "new snapshot" });
    await click(`${panel} [data-snapshot] button`);
    const line = `[...document.querySelectorAll('${panel} [data-history-file="src/main.ts"] div')].some((d) => d.textContent.includes("Edited live:"))`;
    await page!.waitFor(line, { label: "diff of src/main.ts" });
    await shot("history.png");
    await click(`${panel} [data-undo]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    const file = join(profile, "data", "apps", appId, "src", "main.ts");
    await waitForValue(async () => ((await Bun.file(file).text()).includes("A starting point:") ? true : undefined), 15_000);
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 60_000, label: "app running again" });
    await waitForValue(async () => ((await inView<string>(appTab(), `document.body.innerText`)).includes("A starting point:") ? true : undefined), 30_000);
    await page!.waitFor(`[...document.querySelectorAll('${panel} [data-snapshot]')].some((e) => e.innerText.includes("Undid:"))`, { label: "undo in the timeline" });
    await click(`${appTab()} [data-history-button]`);

    // The History page has everything in the workspace.
    await click('[data-page-link="History"]');
    await page!.waitFor(`document.querySelectorAll("[data-history-page] [data-snapshot]").length >= 3`, { label: "history page" });
    // An entry opened on the page offers putting everything back to that moment.
    await click("[data-history-page] [data-snapshot] button");
    await page!.waitFor(`!!document.querySelector("[data-history-page] [data-restore-all]")`, { label: "restore everything" });
    await shot("history-page.png");
    const entries = await page!.eval<number>(`document.querySelectorAll("[data-history-page] [data-snapshot]").length`);
    await click(`nav li[data-app-id="${appId}"]`);
    return `${entries} snapshots on the page`;
  });

  /** Sets an input's value the way typing does. */
  const type = (selector: string, value: string) =>
    page!.eval(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);

  await check("app data: tables and rows in the data panel", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(profile, "data", "appdata", appId, "data.sqlite"));
    db.run("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, label TEXT, amount REAL)");
    for (const [label, amount] of [["Lunch", 12.5], ["Train", 4.2], ["Books", 31]] as const) db.run("INSERT INTO expenses (label, amount) VALUES (?, ?)", [label, amount]);
    db.close();
    await click(`${appTab()} [data-data-button]`);
    const panel = `${appTab()} [data-data-panel]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-data-table="expenses"]')`, { label: "expenses table" });
    await click(`${panel} [data-data-table="expenses"]`);
    await page!.waitFor(`document.querySelectorAll('${panel} [data-data-rows] tbody tr').length === 3`, { label: "rows" });
    await type(`${panel} [data-data-search]`, "train");
    await page!.waitFor(`document.querySelectorAll('${panel} [data-data-rows] tbody tr').length === 1`, { label: "search" });
    await shot("app-data.png");
    await click(`${appTab()} [data-data-button]`);
  });

  await check("tool registry: the app's tools from its data, run from the tools panel", async () => {
    await click(`${appTab()} [data-tools-button]`);
    const panel = `${appTab()} [data-tools-panel]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-tool="add-expenses"]')`, { label: "derived tools" });
    await click(`${panel} [data-tool="add-expenses"] button`);
    await type(`${panel} [data-tool="add-expenses"] [data-tool-param="label"]`, "Coffee");
    await type(`${panel} [data-tool="add-expenses"] [data-tool-param="amount"]`, "3.5");
    await click(`${panel} [data-tool="add-expenses"] [data-run-tool]`);
    await page!.waitFor(`document.querySelector('${panel} [data-tool="add-expenses"] [data-tool-result]')?.textContent.includes("Added a row")`, { label: "tool result" });
    await shot("app-tools.png");
    await click(`${appTab()} [data-tools-button]`);
    const tools = await apiCall<{ id: string }[]>(`/api/apps/${appId}/tools`);
    return `${tools.length} tools`;
  });

  await check("schedules: created on the page, run now, paused, deleted; a prompt for an agent", async () => {
    const choose = (selector: string, value: string) =>
      page!.eval(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
    await click('[data-page-link="Schedules"]');
    await page!.waitFor(`!!document.querySelector("[data-schedules]")`, { label: "schedules page" });
    await click("[data-new-schedule]");
    await page!.waitFor(`!!document.querySelector("[data-schedule-editor]")`, { label: "editor" });
    await type("[data-schedule-name]", "Say hello");
    await choose("[data-schedule-app]", appId);
    await choose("[data-schedule-task]", "command");
    await page!.waitFor(`!!document.querySelector("[data-schedule-command]")`, { label: "command field" });
    await type("[data-schedule-command]", "echo scheduled in $NATHAPP_MODE");
    await click("[data-save-schedule]");
    const row = "[data-schedules] [data-schedule]";
    await page!.waitFor(`!!document.querySelector('${row}') && !document.querySelector("[data-schedule-editor]")`, { label: "schedule listed" });
    await click(`${row} [data-run-schedule]`);
    await page!.waitFor(`!!document.querySelector('[data-past-runs] [data-run-status="ok"]')`, { label: "run finished", timeoutMs: 20_000 });
    await click(`[data-past-runs] [data-run-status="ok"] button`);
    await page!.waitFor(`document.querySelector("[data-past-runs]").innerText.includes("scheduled in")`, { label: "output" });
    await click(`${row} [data-pause-schedule]`);
    await page!.waitFor(`document.querySelector('${row}')?.dataset.paused === "yes"`, { label: "paused" });
    await shot("schedules.png");
    await click(`${row} [data-delete-schedule]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('${row}')`, { label: "deleted" });

    // A prompt for an agent, in a new web tab (not run: that needs a model).
    await click("[data-new-schedule]");
    await page!.waitFor(`!!document.querySelector("[data-schedule-editor]")`, { label: "editor again" });
    await choose("[data-schedule-task]", "prompt");
    await page!.waitFor(`!!document.querySelector("[data-schedule-prompt]") && !!document.querySelector("[data-schedule-target]")`, { label: "prompt fields" });
    await type("[data-schedule-prompt]", "Summarize what's new on the front page");
    await choose("[data-schedule-target]", "new:web");
    await page!.waitFor(`!!document.querySelector("[data-schedule-url]")`, { label: "url field" });
    await type("[data-schedule-url]", "https://example.com");
    await shot("schedule-prompt.png");
    await click("[data-save-schedule]");
    await page!.waitFor(
      `!document.querySelector("[data-schedule-editor]") && (document.querySelector('${row}')?.innerText ?? "").includes("a new tab (https://example.com)")`,
      { label: "prompt schedule listed" },
    );
    await click(`${row} [data-delete-schedule]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('${row}')`, { label: "prompt schedule deleted" });
    await click(`nav li[data-app-id="${appId}"]`);
  });

  await check("secrets: added in the app tab, never shown again", async () => {
    const value = "e2e-secret-value-4711";
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 60_000, label: "app running" });
    await click(`${appTab()} [data-secrets]`);
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-secrets-panel] [data-secret-form]')`, { label: "secrets panel" });
    await type(`${appTab()} [data-secrets-panel] [data-secret-name]`, "e2e_key");
    await type(`${appTab()} [data-secrets-panel] [data-secret-value]`, value);
    await page!.eval(`document.querySelector('${appTab()} [data-secrets-panel] [data-secret-form]').requestSubmit(), true`);
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-secret="E2E_KEY"]')`, { label: "saved secret" });
    const html = await page!.eval<string>(`document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join(" ")`);
    if (html.includes(value)) throw new Error("the secret value is still in the page");
    await shot("secrets.png");
    await click(`${appTab()} [data-secrets]`);
  });

  await check("permissions: an app asking for AI waits for the user", async () => {
    const file = join(profile, "data", "apps", appId, "src", "server.ts");
    const source = await Bun.file(file).text();
    await Bun.write(
      file,
      source
        .replace('import { realtime } from "./realtime";', 'import { realtime } from "./realtime";\nimport { ai } from "./ai";')
        .replace(
          "  routes: {",
          `  routes: {
    "/api/ask-ai": async () => {
      try {
        return Response.json(await ai.chat("Say hi"));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 403 });
      }
    },`,
        ),
    );
    await click(`${appTab()} [data-restart]`);
    await page!.waitFor(`!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 10_000 }).catch(() => {});
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 60_000, label: "app restarted" });
    const { status } = await apiCall<{ status: { url: string } }>(`/api/apps/${appId}/runtime`);
    const answer = fetch(`${status.url}/api/ask-ai`).then(async (r) => ({ status: r.status, body: await r.text() }));
    await page!.waitFor(`!!document.querySelector('[data-permission-request="app.ai"]')`, { timeoutMs: 20_000, label: "permission prompt" });
    await shot("permission.png");
    await click("[data-permission-request] [data-deny]");
    const result = await answer;
    if (result.status !== 403 || !result.body.includes("didn't allow")) throw new Error(`unexpected answer: ${result.status} ${result.body}`);
    await page!.waitFor(`!document.querySelector("[data-permission-request]")`, { label: "prompt gone" });
  });

  await check("activity: the audit log shows what happened", async () => {
    await click('[data-page-link="Activity"]');
    await page!.waitFor(`!!document.querySelector('[data-activity] [data-audit-action="secret.create"]') && !!document.querySelector('[data-activity] [data-audit-action="permission.deny"]')`, {
      label: "secret and permission entries",
    });
    const count = await page!.eval<number>(`document.querySelectorAll("[data-activity] [data-audit-action]").length`);
    await shot("activity.png");
    await click(`nav li[data-app-id="${appId}"]`);
    return `${count} entries`;
  });

  await check("agent panel collapses and comes back", async () => {
    await click(`${agentOf(appId)} [data-agent-hide]`);
    await page!.waitFor(`!document.querySelector('${agentOf(appId)}') && !!document.querySelector('${appTab()} [data-agent-show]')`, {
      label: "agent panel hidden",
    });
    await click(`${appTab()} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${agentOf(appId)}')`, { label: "agent panel shown" });
  });

  if (agentPrompt) {
    await check("agent builds an app", async () => {
      const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
      await newTab("New app");
      const id = await page!.waitFor<string>(
        `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      );
      const root = `[data-app-tab="${id}"]`;
      // Fastest model keeps this cheap; any model exercises the same path.
      await chooseAgent(agentOf(id), "claude", "haiku", "Low");
      await sendPrompt(agentOf(id), agentPrompt);
      const chat = await agentDone(agentOf(id));
      await page!.waitFor(`!!document.querySelector('${root} [data-runtime-state="running"]')`, { timeoutMs: 60_000, label: `app running:\n${chat.slice(-600)}` });
      const text = await waitForValue(async () => (await inView<string>(root, `document.body.innerText`)) || undefined, 20_000);
      await shot("agent-app.png");
      const name = await page!.eval<string>(`document.querySelector('nav li[data-app-id="${id}"]').innerText.split("\\n")[0].trim()`);
      return `built "${name}": ${text.slice(0, 80).replace(/\s+/g, " ")}`;
    });
  }

  await check("import: a folder of your own becomes an app tab, run like any other", async () => {
    const folder = join(mkdtempSync(join(tmpdir(), "nathapp-e2e-import-")), "hello-import");
    mkdirSync(folder);
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "hello-import", scripts: { dev: "bun server.ts", start: "bun server.ts" } }));
    writeFileSync(join(folder, "server.ts"), `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("<h1>Imported and running</h1>", { headers: { "Content-Type": "text/html" } }) });`);
    const tab = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "app" } });
    await click(`nav li[data-app-id="${tab.id}"]`);
    await page!.waitFor(`!!document.querySelector('[data-app-tab="${tab.id}"] [data-import-folder]')`, { label: "import buttons" });
    await apiCall(`/api/apps/${tab.id}/import`, { method: "POST", body: { folder } });
    const root = `[data-app-tab="${tab.id}"]`;
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tab.id}"]')?.innerText.includes("hello-import")`, { label: "named after the folder" });
    await page!.waitFor(`!!document.querySelector('${root} [data-runtime-state="running"]')`, { timeoutMs: 60_000, label: "running" });
    await waitForValue(async () => ((await inView<string>(root, `document.body.innerText`)).includes("Imported and running") ? true : undefined), 20_000);
    await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    rmSync(dirname(folder), { recursive: true, force: true });
    return "named, manifest from package.json, running in the preview";
  });

  await check("sidebar context menu: rename, duplicate, delete", async () => {
    const appNames = () => page!.eval<string[]>(`[...document.querySelectorAll("nav li")].map((li) => li.innerText.split("\\n")[0].trim())`);
    const openMenu = (index: number) =>
      page!.eval(`(() => {
        const li = document.querySelectorAll("nav li")[${index}];
        const r = li.getBoundingClientRect();
        li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      })()`);
    const choose = async (label: string) => {
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "menu to open" });
      await click("[data-context-menu] button", label);
      await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "menu to close" });
    };

    const before = await appNames();
    if (!before.length) throw new Error("no apps in the sidebar");

    await openMenu(0);
    await choose("Rename");
    await page!.eval(`(() => {
      const input = document.querySelector("nav li input");
      input.value = "E2E renamed";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    await page!.waitFor(`[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("E2E renamed"))`, {
      label: "rename",
    });

    await openMenu(0);
    await choose("Duplicate");
    await page!.waitFor(`[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("E2E renamed copy"))`, {
      label: "duplicate",
    });

    const copyIndex = (await appNames()).indexOf("E2E renamed copy");
    await openMenu(copyIndex);
    await choose("Delete");
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`![...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("E2E renamed copy"))`, {
      label: "delete",
    });

    // Escape closes without doing anything.
    await openMenu(0);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`);
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "Escape to close the menu" });

    const after = await appNames();
    if (after.length !== before.length) throw new Error(`expected ${before.length} apps, got ${after.join(", ")}`);
  });

  await check("no title bar: window buttons top right, the bar under them makes room", async () => {
    const r = await page!.eval<{ controls: { right: number; top: number; width: number } | null; padded: string[]; underneath: number }>(`(() => {
      const c = document.querySelector("[data-window-controls]")?.getBoundingClientRect();
      const bars = [...document.querySelectorAll("[data-titlebar]")];
      const padded = bars.filter((b) => b.style.paddingRight).map((b) => b.tagName.toLowerCase());
      const underneath = bars.filter((b) => b.getBoundingClientRect().right >= innerWidth - 1 && b.getBoundingClientRect().top < 44).length;
      return { controls: c ? { right: Math.round(c.right), top: Math.round(c.top), width: Math.round(c.width) } : null, padded, underneath };
    })()`);
    if (!r.controls || r.controls.top !== 0 || r.controls.right !== 1400) throw new Error(`controls: ${JSON.stringify(r.controls)}`);
    if (r.padded.length !== r.underneath) throw new Error(`${r.underneath} bars run under the buttons, ${r.padded.length} padded`);
    const drag = await page!.eval<string>(`getComputedStyle(document.querySelector("[data-titlebar]")).webkitAppRegion || getComputedStyle(document.querySelector("[data-titlebar]")).getPropertyValue("-webkit-app-region")`);
    if (drag !== "drag") throw new Error(`top bars aren't drag regions: ${drag}`);
    return `${r.controls.width}px of buttons; padded: ${r.padded.join(", ") || "none needed"}`;
  });

  await check("sidebar: collapses to icons, resizes, remembers both", async () => {
    const navWidth = () => page!.eval<number>(`document.querySelector("nav").getBoundingClientRect().width`);
    await click("[data-sidebar-toggle]");
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "collapsed"`, { label: "collapsed" });
    const collapsed = await navWidth();
    if (collapsed > 60) throw new Error(`collapsed sidebar is ${collapsed}px wide`);
    await shot("sidebar-collapsed.png");
    // Ctrl+Shift+B brings it back.
    await page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true, bubbles: true })), true`);
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "expanded"`, { label: "expanded by the shortcut" });
    const before = await navWidth();
    // Drag the edge 100px to the right.
    await page!.eval(`(() => {
      const handle = document.querySelector("[data-sidebar-resizer]");
      const r = handle.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + 200;
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 100, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 100, clientY: y }));
      return true;
    })()`);
    const after = await navWidth();
    if (Math.abs(after - before - 100) > 2) throw new Error(`width ${before} → ${after}`);
    const saved = await page!.eval<{ width: number; collapsed: boolean }>(`JSON.parse(localStorage.getItem("nathapp.sidebar"))`);
    if (saved.width !== Math.round(after) || saved.collapsed) throw new Error(`saved ${JSON.stringify(saved)}`);
    await shot("sidebar-wide.png");
    // Back to the default width.
    await page!.eval(`document.querySelector("[data-sidebar-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    return `${Math.round(collapsed)}px collapsed, ${Math.round(before)} → ${Math.round(after)}px`;
  });

  await check("agent sidebar: resized by its edge, remembered, reset by double-click", async () => {
    const panel = "[data-agent-sidebar]";
    if (!(await page!.eval<boolean>(`!!document.querySelector('${panel}')`))) {
      await click(`[data-app-tab="${appId}"] [data-agent-show]`);
      await page!.waitFor(`!!document.querySelector('${panel}')`, { label: "agent sidebar" });
    }
    const width = () => page!.eval<number>(`Math.round(document.querySelector('${panel}').getBoundingClientRect().width)`);
    const before = await width();
    const drag = (dx: number) =>
      page!.eval(`(() => {
        const h = document.querySelector("[data-agent-resizer]");
        const r = h.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + 100;
        h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + ${dx}, clientY: y }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + ${dx}, clientY: y }));
        return true;
      })()`);
    await drag(-120);
    const wider = await width();
    if (wider !== before + 120) throw new Error(`${before} → ${wider}, expected +120`);
    const saved = await page!.eval<string>(`localStorage.getItem("nathapp.agentSidebar")`);
    if (!saved.includes(String(wider))) throw new Error(`not remembered: ${saved}`);
    // Dragged far to the right: it closes (and comes back at its width).
    await drag(5000);
    await page!.waitFor(`!document.querySelector('${panel}')`, { label: "closed by dragging" });
    await click(`[data-app-tab="${appId}"] [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${panel}')`, { label: "shown again" });
    if ((await width()) !== wider) throw new Error(`came back at ${await width()}px`);
    await page!.eval(`document.querySelector("[data-agent-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    const reset = await width();
    if (reset !== 380) throw new Error(`double-click: ${reset}px`);
    return `${before} → ${wider} → reset ${reset}px`;
  });

  await check("chats: new chat button and the earlier chats list in the agent sidebar", async () => {
    const panel = `[data-agent-for="${appId}"]`;
    if (!(await page!.eval<boolean>(`!!document.querySelector('${panel}')`))) await click(`[data-app-tab="${appId}"] [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-chat-history-button]')`, { label: "chat buttons" });
    const disabled = await page!.eval<boolean>(`document.querySelector('${panel} [data-new-chat]').disabled`);
    if (!disabled) throw new Error("New chat is offered for an empty chat");
    await click(`${panel} [data-chat-history-button]`);
    await page!.waitFor(`document.querySelector("[data-chat-history]")?.innerText.includes("No earlier chats")`, { label: "history popover" });
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-chat-history]")`, { label: "closed" });
    const chats = await apiCall<unknown[]>(`/api/apps/${appId}/chats`);
    if (chats.length) throw new Error("unexpected chats");
  });

  await check("sidebar footer: one row of icon buttons with labels, also at the minimum width", async () => {
    const layout = () =>
      page!.eval<{ tops: number[]; labels: (string | null)[]; texts: string[]; inside: boolean }>(`(() => {
        const nav = document.querySelector("nav").getBoundingClientRect();
        const links = [...document.querySelectorAll("[data-page-link]")];
        return {
          tops: [...new Set(links.map((b) => Math.round(b.getBoundingClientRect().top)))],
          labels: links.map((b) => b.getAttribute("aria-label")),
          texts: links.map((b) => b.innerText.trim()).filter(Boolean),
          inside: links.every((b) => b.getBoundingClientRect().right <= nav.right + 0.5),
        };
      })()`);
    const wide = await layout();
    if (wide.tops.length !== 1 || wide.texts.length || wide.labels.includes(null)) throw new Error(`footer: ${JSON.stringify(wide)}`);
    await page!.eval(`(() => {
      const h = document.querySelector("[data-sidebar-resizer]");
      const r = h.getBoundingClientRect();
      h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.left, clientY: 300 }));
      // Past the minimum width (180 px), not so far that it collapses.
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left - 80, clientY: 300 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left - 80, clientY: 300 }));
      return true;
    })()`);
    const narrow = await layout();
    const width = await page!.eval<number>(`Math.round(document.querySelector("nav").getBoundingClientRect().width)`);
    if (width !== 180) throw new Error(`expected the minimum width, got ${width}px`);
    await shot("sidebar-footer-narrow.png");
    await page!.eval(`document.querySelector("[data-sidebar-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    if (narrow.tops.length !== 1 || !narrow.inside) throw new Error(`at the minimum width: ${JSON.stringify(narrow)}`);
    return `${wide.labels.join(", ")}`;
  });

  await check("sidebar: tabs are reordered by dragging", async () => {
    const ids = () => page!.eval<string[]>(`[...document.querySelectorAll("nav li[data-app-id]")].map((li) => li.dataset.appId)`);
    const first = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "web", url: `${site.url.origin}/second` } });
    const extra = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "web", url: `${site.url.origin}/second` } });
    await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${extra.id}"]')`, { label: "new tab in the sidebar" });
    const before = await ids();
    if (before.length < 2 || before.at(-1) !== extra.id) throw new Error(`unexpected order ${before.join(", ")}`);
    // Drag the last tab onto the top half of the first one.
    await page!.eval(`(() => {
      const from = document.querySelector('nav li[data-app-id="${extra.id}"]');
      const to = document.querySelector("nav li[data-app-id]");
      const r = to.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      const at = { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 20, clientY: r.top + 4 };
      from.dispatchEvent(new DragEvent("dragstart", at));
      to.dispatchEvent(new DragEvent("dragover", at));
      to.dispatchEvent(new DragEvent("drop", at));
      from.dispatchEvent(new DragEvent("dragend", at));
      return true;
    })()`);
    const expected = [extra.id, ...before.slice(0, -1)];
    await page!.waitFor(`JSON.stringify([...document.querySelectorAll("nav li[data-app-id]")].map((li) => li.dataset.appId)) === ${JSON.stringify(JSON.stringify(expected))}`, {
      label: "new order in the sidebar",
    });
    // Saved: the server lists them in that order.
    const saved = await waitForValue(async () => {
      const list = await apiCall<{ id: string; workspaceId: string }[]>("/api/apps");
      const order = list.filter((t) => expected.includes(t.id)).map((t) => t.id);
      return JSON.stringify(order) === JSON.stringify(expected) ? order : undefined;
    });
    for (const tab of [first, extra]) await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    await page!.waitFor(`!document.querySelector('nav li[data-app-id="${extra.id}"]')`, { label: "tabs removed" });
    return `${saved.length} tabs, last one moved to the top`;
  });

  await check("tab icons: picked from Lucide, uploaded, reset", async () => {
    const tab = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "web", url: `${site.url.origin}/second` } });
    const li = `nav li[data-app-id="${tab.id}"]`;
    await page!.waitFor(`!!document.querySelector('${li}')`, { label: "tab in the sidebar" });
    const iconOf = async () => (await apiCall<{ id: string; icon: string | null }[]>("/api/apps")).find((t) => t.id === tab.id)?.icon;
    const openPicker = async () => {
      await page!.eval(`(() => {
        const li = document.querySelector('${li}');
        const r = li.getBoundingClientRect();
        li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "menu" });
      await click("[data-context-menu] button", "Change icon");
      await page!.waitFor(`!!document.querySelector("[data-icon-picker]")`, { label: "icon picker" });
    };

    await openPicker();
    await page!.eval(`(() => {
      const input = document.querySelector("[data-icon-picker] input");
      input.value = "rocket";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector('[data-icon-picker] [data-icon="rocket"]')`, { label: "search result" });
    await shot("icon-picker.png");
    await click('[data-icon-picker] [data-icon="rocket"]');
    await page!.waitFor(`!document.querySelector("[data-icon-picker]")`, { label: "picker closes" });
    if ((await waitForValue(async () => ((await iconOf()) === "rocket" ? "rocket" : undefined))) !== "rocket") throw new Error("not saved");
    await page!.waitFor(`!!document.querySelector('${li} svg.lucide-rocket, ${li} svg[class*="rocket"]')`, { label: "rocket in the sidebar" });

    // An uploaded image is scaled to a 64px PNG.
    await openPicker();
    await page!.eval(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 200; canvas.height = 100;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e11d48"; ctx.fillRect(0, 0, 200, 100);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "logo.jpg", { type: "image/jpeg" }));
      const input = document.querySelector("[data-icon-file]");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const image = await waitForValue(async () => {
      const icon = await iconOf();
      return icon?.startsWith("data:image/png;base64,") ? icon : undefined;
    });
    const size = await page!.eval<string>(`new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth + "x" + img.naturalHeight); img.src = ${JSON.stringify(image)}; })`);
    if (size !== "64x64") throw new Error(`uploaded icon is ${size}`);
    await page!.waitFor(`!!document.querySelector('${li} img[data-tab-icon-image]')`, { label: "image in the sidebar" });
    await shot("tab-icon-image.png");

    await openPicker();
    await click("[data-icon-picker] [data-icon-reset]");
    if ((await waitForValue(async () => ((await iconOf()) === null ? "reset" : undefined))) !== "reset") throw new Error("not reset");
    await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    return `rocket, uploaded image (${size}), reset; ${Math.round(image.length / 1024)} kB`;
  });

  await check("split view: drag a tab beside another, focus, resize, rotate, remove", async () => {
    type Workspace = { id: string; splits: { id: string; direction: string; tabs: string[]; sizes: number[] }[] };
    const make = (path: string) => apiCall<{ id: string; workspaceId: string }>("/api/apps", { method: "POST", body: { kind: "web", url: `${site.url.origin}${path}` } });
    // The sidebar has loaded its workspace (right after booting, it may not have yet).
    await page!.waitFor(`!!document.querySelector("[data-workspace-switcher]")?.innerText.trim()`, { label: "workspace loaded" });
    const a = await make("/");
    const b = await make("/second");
    const liOf = (id: string) => `nav li[data-app-id="${id}"]`;
    await page!.waitFor(`!!document.querySelector('${liOf(b.id)}')`, { label: "tabs in the sidebar" });
    await click(liOf(a.id));
    await page!.waitFor(`!!document.querySelector('[data-tab-layer="${a.id}"] webview')`, { label: "first tab open" });
    const splitsNow = async () => (await apiCall<Workspace[]>("/api/workspaces")).find((w) => w.id === a.workspaceId)!.splits;

    // Drag the second tab from the sidebar onto the right half of the page.
    await page!.eval(`(() => {
      window.__splitDrag = new DataTransfer();
      document.querySelector('${liOf(b.id)}').dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__splitDrag }));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector("[data-split-drop]")`, { label: "drop zones" });
    await page!.eval(`(() => {
      const zone = document.querySelector("[data-split-drop]");
      const r = zone.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__splitDrag, clientX: r.right - 40, clientY: r.top + r.height / 2 };
      zone.dispatchEvent(new DragEvent("dragover", at));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector('[data-split-preview="right"]')`, { label: "preview on the right" });
    await shot("split-drop.png");
    await page!.eval(`(() => {
      const zone = document.querySelector("[data-split-drop]");
      const r = zone.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__splitDrag, clientX: r.right - 40, clientY: r.top + r.height / 2 };
      zone.dispatchEvent(new DragEvent("drop", at));
      document.querySelector('${liOf(b.id)}').dispatchEvent(new DragEvent("dragend", at));
      return true;
    })()`);
    const saved = await waitForValue(async () => {
      const splits = await splitsNow();
      return splits.length === 1 && splits[0]!.tabs.join() === [a.id, b.id].join() ? splits[0] : undefined;
    });
    if (saved.direction !== "row") throw new Error(`direction ${saved.direction}`);

    // Both pages on screen, half each; the dropped tab has the focus; the sidebar groups them.
    const rects = () =>
      page!.eval<{ a: DOMRect; b: DOMRect; area: DOMRect }>(`(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
        return { a: r('[data-tab-layer="${a.id}"]'), b: r('[data-tab-layer="${b.id}"]'), area: r('[data-split-drop], [data-tab-layer="${a.id}"]') };
      })()`);
    await page!.waitFor(`!!document.querySelector('[data-tab-layer="${b.id}"] webview') && getComputedStyle(document.querySelector('[data-tab-layer="${a.id}"]')).visibility === "visible"`, { label: "both panes shown" });
    const half = await rects();
    if (Math.abs(half.a.width - half.b.width) > 2 || Math.abs(half.a.right - half.b.left) > 1) throw new Error(`panes ${JSON.stringify(half)}`);
    await page!.waitFor(`document.querySelector('${liOf(b.id)}').getAttribute("aria-current") === "page"`, { label: "dropped tab focused" });
    await page!.waitFor(`document.querySelectorAll('[data-split-group="${saved.id}"] li[data-app-id]').length === 2`, { label: "split group in the sidebar" });

    // Clicking into the other page (a real click, inside its webview) focuses its tab.
    const point = { x: Math.round(half.a.left + half.a.width / 2), y: Math.round(half.a.top + half.a.height / 2) };
    await page!.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await page!.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    await page!.waitFor(`document.querySelector('${liOf(a.id)}').getAttribute("aria-current") === "page"`, { label: "clicked pane focused" });
    await shot("split-view.png");

    // Drag the gutter to 30%.
    await page!.eval(`(() => {
      const gutter = document.querySelector("[data-split-gutter]");
      const area = gutter.parentElement.getBoundingClientRect();
      const g = gutter.getBoundingClientRect();
      const y = g.top + 100;
      gutter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: g.left + 3, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: area.left + area.width * 0.3, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: area.left + area.width * 0.3, clientY: y }));
      return true;
    })()`);
    const resized = await waitForValue(async () => {
      const sizes = (await splitsNow())[0]?.sizes;
      return sizes && Math.abs(sizes[0]! - 0.3) < 0.02 ? sizes : undefined;
    });

    // Another tab on its own hides the split; coming back shows it again.
    const other = await make("/");
    await page!.waitFor(`!!document.querySelector('${liOf(other.id)}')`, { label: "third tab" });
    await click(liOf(other.id));
    await page!.waitFor(`getComputedStyle(document.querySelector('[data-tab-layer="${a.id}"]')).visibility === "hidden"`, { label: "split hidden" });
    await click(liOf(a.id));
    await page!.waitFor(`getComputedStyle(document.querySelector('[data-tab-layer="${b.id}"]')).visibility === "visible"`, { label: "split shown again" });

    // Stacked from the group's menu.
    await click(`[data-split-group="${saved.id}"] [data-split-menu]`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "split menu" });
    await click("[data-context-menu] button", "Stack them");
    await waitForValue(async () => ((await splitsNow())[0]?.direction === "column" ? true : undefined));
    const stacked = await rects();
    if (Math.abs(stacked.a.bottom - stacked.b.top) > 1 || Math.abs(stacked.a.width - stacked.b.width) > 1) throw new Error(`stacked panes ${JSON.stringify(stacked)}`);

    // Removing a tab from a split of two ends it.
    await page!.eval(`(() => {
      const li = document.querySelector('${liOf(b.id)}');
      const r = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "tab menu" });
    await click("[data-context-menu] button", "Remove from split view");
    await waitForValue(async () => ((await splitsNow()).length === 0 ? true : undefined));
    await page!.waitFor(`!document.querySelector("[data-split-group]")`, { label: "group gone" });
    for (const tab of [a, b, other]) await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    return `side by side, resized to ${Math.round(resized[0]! * 100)}/${Math.round(resized[1]! * 100)}, stacked, removed`;
  });

  await check("web tab: browse, pick an element, site customization applies", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    webTabId = tabId;
    const tab = `[data-web-tab="${tabId}"]`;
    // In the page: runs code inside the tab's webview.
    const inPage = <T>(code: string, gesture = false) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)}, ${gesture})`);

    await page!.waitFor(`!!document.querySelector('${tab} [data-address]')`, { label: "address bar" });
    await page!.eval(`(() => {
      const input = document.querySelector('${tab} [data-address]');
      input.value = "${site.url.origin}/";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes("Test site")`, {
      timeoutMs: 20_000,
      label: "page title as the tab name",
    });
    await waitForValue(async () => ((await inPage<string>(`document.querySelector("h1")?.textContent`)) ? true : undefined));

    // Pick the button: the picker resolves on a click inside the page.
    await click(`${tab} [data-pick-element]`);
    await waitForValue(async () => ((await inPage<boolean>(`!!window.__nathappPicker`)) ? true : undefined));
    await inPage(`document.querySelector(".cta").click(), true`);
    await page!.waitFor(`document.querySelector('${agentOf(tabId)} [data-picked-chip]')?.innerText.includes("Buy now")`, {
      label: "picked element chip",
    });
    const outlined = await inPage<boolean>(`document.querySelector(".cta").hasAttribute("data-nathapp-picked")`);
    if (!outlined) throw new Error("picked element isn't marked");

    // A customization (as the agent would save it) applies live: CSS now, JS after a reload.
    await apiCall("/api/sites/127.0.0.1", {
      method: "PUT",
      body: { css: "h1 { color: rgb(220, 20, 60) !important }", js: "onElement('.lead', (el) => { el.textContent = 'Changed by override'; });" },
    });
    await waitForValue(
      async () =>
        (await inPage<string>(`getComputedStyle(document.querySelector("h1")).color + "|" + document.querySelector(".lead").textContent`)) ===
        "rgb(220, 20, 60)|Changed by override"
          ? true
          : undefined,
      15_000,
    );
    await page!.waitFor(`!!document.querySelector('${tab} [data-customized="on"]')`, { label: "customized indicator" });
    await shot("web-tab.png");

    // Links that open a new window become web tabs.
    await inPage(`document.querySelector("#popup").click(), true`, true);
    await page!.waitFor(`[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("Second page"))`, {
      timeoutMs: 15_000,
      label: "popup opened as a new tab",
    });

    // Turning the customization off in the tab's list of changes removes it.
    await click(`nav li[data-app-id="${webTabId}"]`);
    await click(`${tab} [data-customized]`);
    await page!.waitFor(`!!document.querySelector("[data-page-changes] [data-site-override]")`, { label: "changes popover" });
    await click(`[data-page-changes] [data-site-override] [role="switch"]`);
    await waitForValue(
      async () => ((await inPage<string>(`getComputedStyle(document.querySelector("h1")).color`)) !== "rgb(220, 20, 60)" ? true : undefined),
      15_000,
    );
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    return "picked, customized, popup";
  });

  await check("agent sidebar: closed on web tabs until opened (Ctrl+J), remembered per tab", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    await page!.waitFor(`!!document.querySelector('[data-web-tab="${tabId}"] [data-address]')`, { label: "web tab" });
    if (await page!.eval<boolean>(`!!document.querySelector("[data-agent-sidebar]")`)) throw new Error("the agent sidebar is open on a new web tab");
    const ctrlJ = () => page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true })), true`);
    await ctrlJ();
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"]')`, { label: "opened with Ctrl+J" });
    // Another tab and back: still open for this one.
    await click(`nav li[data-app-id="${webTabId}"]`);
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tabId}"]').getAttribute("aria-current") !== "page"`, { label: "other tab" });
    await click(`nav li[data-app-id="${tabId}"]`);
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"]')`, { label: "still open" });
    await ctrlJ();
    await page!.waitFor(`!document.querySelector("[data-agent-sidebar]")`, { label: "closed with Ctrl+J" });
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return "closed by default, opened, remembered, closed";
  });

  await check("page changes: hide, rewrite, insert, buttons; dynamic content, toggles, removal, reloads", async () => {
    if (!webTabId) throw new Error("needs the web tab");
    const tab = `[data-web-tab="${webTabId}"]`;
    const inPage = <T>(code: string) => page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    const until = (code: string, label: string) =>
      waitForValue(async () => ((await inPage<boolean>(code).catch(() => false)) ? true : undefined), 15_000).catch(() => {
        throw new Error(`timed out: ${label}`);
      });
    await click(`nav li[data-app-id="${webTabId}"]`);
    const site = { type: "site", value: "127.0.0.1" };
    const add = (change: Record<string, unknown>) => apiCall<{ id: string }>("/api/page-changes", { method: "POST", body: change });
    const hide = await add({ title: "Hide the buy button", scope: site, action: "hide", selector: ".cta" });
    const text = await add({ title: "New headline", scope: { type: "page", value: "127.0.0.1/" }, action: "text", selector: "#headline", value: "Changed headline" });
    const insert = await add({ title: "Add a note", scope: { type: "pattern", value: "127.0.0.1/*" }, action: "insert", selector: "#headline", value: '<p class="added">Inserted note</p>' });
    await add({ title: "Count button", scope: site, action: "button", selector: "main", position: "append", value: "Count", onClick: 'button.textContent = "Clicked";' });
    await add({ title: "Tooltip", scope: site, action: "attribute", selector: ".lead", name: "title", value: "tip" });
    await add({ title: "Elsewhere", scope: { type: "site", value: "example.com" }, action: "hide", selector: "h1" });

    await until(`getComputedStyle(document.querySelector(".cta")).display === "none"`, "hidden");
    await until(`document.querySelector("#headline").textContent === "Changed headline"`, "text");
    await until(`document.querySelector("#headline + .added")?.textContent === "Inserted note"`, "inserted");
    await until(`document.querySelector(".lead").title === "tip"`, "attribute");
    // Content the page adds later gets the changes too.
    await inPage(`document.querySelector("main").insertAdjacentHTML("beforeend", '<p class="lead">Later</p>'), true`);
    await until(`[...document.querySelectorAll(".lead")].every((el) => el.title === "tip")`, "dynamic content");
    await until(`!!document.querySelector("button.nathapp-button")`, "button");
    await inPage(`document.querySelector("button.nathapp-button").click(), true`);
    await until(`document.querySelector("button.nathapp-button").textContent === "Clicked"`, "button behavior");

    // Every change on the page, each with its switch; the other site's isn't listed.
    await click(`${tab} [data-customized]`);
    await page!.waitFor(`document.querySelectorAll("[data-page-changes] [data-page-change]").length === 5`, { label: "five changes listed" });
    await shot("page-changes.png");
    await click(`[data-page-changes] [data-page-change="${text.id}"] [role="switch"]`);
    await until(`document.querySelector("#headline").textContent === "Hello from the test site"`, "turned off");
    await click(`[data-page-changes] [data-page-change="${insert.id}"] [data-remove-page-change]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await until(`!document.querySelector(".added")`, "removed");
    await page!.waitFor(`document.querySelectorAll("[data-page-changes] [data-page-change]").length === 4`, { label: "removed from the list" });
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);

    // After a reload: still hidden, still off, still gone.
    await inPage(`location.reload(), true`);
    await until(`document.readyState === "complete" && !!document.querySelector("button.nathapp-button")`, "reloaded with the button");
    await until(`getComputedStyle(document.querySelector(".cta")).display === "none"`, "hidden after reload");
    const after = await inPage<string>(`document.querySelector("#headline").textContent + "|" + !!document.querySelector(".added")`);
    if (after !== "Hello from the test site|false") throw new Error(`after reload: ${after}`);
    await apiCall(`/api/page-changes/${hide.id}`, { method: "DELETE" });
    await until(`getComputedStyle(document.querySelector(".cta")).display !== "none"`, "removed through the API");
    // The checks after this one get the page as it is.
    for (const change of await apiCall<{ id: string }[]>("/api/page-changes")) await apiCall(`/api/page-changes/${change.id}`, { method: "DELETE" });
    await until(`!document.querySelector("button.nathapp-button")`, "all removed");
    return "5 changes applied, one turned off, one removed";
  });

  await check("tab unloading: idle tabs unload unless pinned, come back as they were, wake for agents", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    const other = `nav li:not([data-app-id="${tabId}"])`;
    const li = `nav li[data-app-id="${tabId}"]`;
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`).catch((err) => {
        throw new Error(`${String(err).slice(0, 80)} in: ${code.slice(0, 120)}`);
      });
    await page!.waitFor(`!!document.querySelector('${tab} [data-address]')`, { label: "address bar" });
    await page!.eval(`(() => {
      const input = document.querySelector('${tab} [data-address]');
      input.value = "${site.url.origin}/form";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    await page!.waitFor(`document.querySelector('${li}')?.innerText.includes("Form page")`, { timeoutMs: 20_000, label: "form page" });
    await waitForValue(async () => ((await inPage<boolean>(`!!document.querySelector("#note")`)) ? true : undefined));
    await inPage(`(() => {
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set(document.querySelector("#note"), "typed before unloading");
      set(document.querySelector("#long"), "line one\\nline two");
      set(document.querySelector("#pw"), "hunter2");
      window.scrollTo(0, 1500);
      return true;
    })()`);
    const openMenu = async () => {
      await page!.eval(`(() => {
        const el = document.querySelector('${li}');
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "tab menu" });
    };
    const choose = async (label: string) => {
      await openMenu();
      await click("[data-context-menu] button", label);
      await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "menu to close" });
    };
    // On screen: never unloaded, and "Unload" is off.
    await page!.eval(`window.__nathappTabs.sweep(4 * 3600_000)`);
    if (!(await page!.eval<boolean>(`!!document.querySelector('${tab} webview')`))) throw new Error("the tab on screen was unloaded");
    await openMenu();
    const unloadDisabled = await page!.eval<boolean>(`[...document.querySelectorAll("[data-context-menu] button")].find((b) => b.textContent.includes("Unload")).disabled`);
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    if (!unloadDisabled) throw new Error("Unload is offered for the tab on screen");

    // Pinned and in the background: still not unloaded.
    await choose("Keep loaded");
    await page!.waitFor(`document.querySelector('${li}').hasAttribute("data-pinned")`, { label: "pinned" });
    await click(other);
    await page!.waitFor(`document.querySelector('${li}').getAttribute("aria-current") !== "page"`, { label: "other tab selected" });
    const swept = await page!.eval<string[]>(`window.__nathappTabs.sweep(4 * 3600_000)`);
    if (swept.includes(tabId) || !(await page!.eval<boolean>(`!!document.querySelector('${tab} webview')`))) throw new Error("a pinned tab was unloaded");

    // Not pinned: idle long enough, it's unloaded.
    await choose("Allow unloading");
    await page!.waitFor(`!document.querySelector('${li}').hasAttribute("data-pinned")`, { label: "unpinned" });
    const idleNow = await page!.eval<string[]>(`window.__nathappTabs.sweep(60_000)`);
    if (idleNow.includes(tabId)) throw new Error("unloaded after a minute");
    await page!.eval(`window.__nathappTabs.sweep(4 * 3600_000)`);
    await page!.waitFor(`!document.querySelector('${tab}') && !document.querySelector('${li}').hasAttribute("data-loaded")`, { label: "unloaded" });
    await shot("tab-unloaded.png");

    // Opened again: same page, scroll position and input; never the password.
    await click(li);
    await page!.waitFor(`!!document.querySelector('${tab} webview')`, { label: "page back" });
    const restored = await waitForValue(async () => {
      const r = await inPage<{ note: string; long: string; pw: string; y: number }>(
        `({ note: document.querySelector("#note")?.value, long: document.querySelector("#long")?.value, pw: document.querySelector("#pw")?.value, y: Math.round(window.scrollY) })`,
      );
      return r?.note === "typed before unloading" && r.y > 1000 ? r : undefined;
    }, 15_000);
    if (restored.long !== "line one\nline two") throw new Error(`textarea not restored: ${JSON.stringify(restored.long)}`);
    if (restored.pw) throw new Error("the password field was restored");

    // Unloaded by hand, then woken up in the background like an agent's page tool would.
    await click(other);
    await page!.waitFor(`document.querySelector('${li}').getAttribute("aria-current") !== "page"`, { label: "other tab selected" });
    await choose("Unload");
    await page!.waitFor(`!document.querySelector('${tab}')`, { label: "unloaded by hand" });
    const woken = await page!.eval<string>(`window.__nathappTabs.wake(${JSON.stringify(tabId)})`);
    if (!woken.endsWith("/form")) throw new Error(`woke up on ${woken}`);
    const background = await page!.eval<boolean>(`!!document.querySelector('${tab} webview') && document.querySelector('${li}').getAttribute("aria-current") !== "page"`);
    if (!background) throw new Error("waking it should load it without showing it");
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    await page!.waitFor(`!document.querySelector('${li}')`, { label: "tab deleted" });
    return `restored scroll ${restored.y}px and 2 fields; pinned kept; woke on ${new URL(woken).pathname}`;
  });

  await check("shared tab context: @ mentions another tab, web pages stay away from app builders", async () => {
    if (!webTabId) throw new Error("needs the web tab from the web tab check");
    const tabs = await page!.eval<{ id: string; name: string; web: boolean }[]>(
      `[...document.querySelectorAll("nav li[data-app-id]")].map((li) => ({ id: li.dataset.appId, name: li.innerText.split("\\n")[0].trim(), web: !!document.querySelector('[data-web-tab="' + li.dataset.appId + '"]') }))`,
    );
    const second = tabs.find((t) => t.name === "Second page");
    const app = tabs.find((t) => t.name === "E2E renamed");
    if (!second || !app) throw new Error(`tabs: ${tabs.map((t) => t.name).join(", ")}`);
    const type = (panel: string, text: string) =>
      page!.eval(`(() => {
        const t = document.querySelector(${JSON.stringify(`${panel} textarea`)});
        t.focus();
        t.value = ${JSON.stringify(text)};
        t.setSelectionRange(t.value.length, t.value.length);
        t.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return true;
      })()`);

    // In the web tab: "@Sec" offers the other page; Enter shares it.
    await click(`nav li[data-app-id="${webTabId}"]`);
    const web = `[data-web-tab="${webTabId}"]`;
    const webAgent = agentOf(webTabId);
    if (!(await page!.eval<boolean>(`!!document.querySelector('${webAgent}')`))) await click(`${web} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${webAgent} textarea')`, { label: "website agent's composer" });
    await type(webAgent, "Compare with @Sec");
    await page!.waitFor(`!!document.querySelector('${webAgent} [data-mentions] [data-mention="${second.id}"]')`, { label: "mention list" });
    await shot("share-mention.png");
    await page!.eval(`document.querySelector('${webAgent} textarea').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), true`);
    await page!.waitFor(`!!document.querySelector('${webAgent} [data-share-chip="${second.id}"]')`, { label: "share chip" });
    const left = await page!.eval<string>(`document.querySelector('${webAgent} textarea').value`);
    if (left.trim() !== "Compare with") throw new Error(`the mention stayed in the text: ${JSON.stringify(left)}`);
    // Removing the chip unshares it.
    await click(`${webAgent} [data-share-chip="${second.id}"] button`);
    await page!.waitFor(`!document.querySelector('${webAgent} [data-share-chip]')`, { label: "chip removed" });
    await type(webAgent, "");

    // In an app tab, web pages are offered but can't be picked: the app builder has tools.
    await click(`nav li[data-app-id="${app.id}"]`);
    const appTab = `[data-app-tab="${app.id}"]`;
    const appAgent = agentOf(app.id);
    const wasHidden = !(await page!.eval<boolean>(`!!document.querySelector('${appAgent}')`));
    if (wasHidden) await click(`${appTab} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${appAgent} textarea')`, { label: "app builder's composer" });
    await type(appAgent, "@");
    await page!.waitFor(`!!document.querySelector('${appAgent} [data-mentions] [data-mention="${webTabId}"]')`, { label: "mention list in the app" });
    const disabled = await page!.eval<string | null>(`document.querySelector('${appAgent} [data-mention="${webTabId}"]').getAttribute("aria-disabled")`);
    if (disabled !== "true") throw new Error("a web page could be shared with the app builder");
    await click(`${appAgent} [data-mention="${webTabId}"]`);
    await Bun.sleep(200);
    if (await page!.eval<boolean>(`!!document.querySelector('${appAgent} [data-share-chip]')`)) throw new Error("the web page was shared anyway");
    await type(appAgent, "");
    if (wasHidden) await click(`${appAgent} [data-agent-hide]`);
    return "mentioned, shared, unshared; web page refused for the app builder";
  });

  await check("browse: the website agent's clicks, typing and keys are real input in the tab", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    const rpc = <T>(method: string, params: object = {}) => page!.eval<T>(`window.__nathappRpc(${JSON.stringify(method)}, ${JSON.stringify({ tabId, ...params })})`);
    const inPage = <T>(code: string) => page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    await page!.waitFor(`!!document.querySelector('${tab} [data-address]')`, { label: "address bar" });
    await rpc("page.navigate", { url: `${site.url.origin}/act` });
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes("Act page")`, { timeoutMs: 20_000, label: "act page" });

    // Found by its text, clicked with a real (trusted) click, shown where it happened.
    const next = await rpc<{ x: number; y: number; label: string }>("page.target", { text: "Next" });
    if (next.label !== "Next") throw new Error(`found ${JSON.stringify(next)}`);
    await rpc("page.act", { kind: "click", x: next.x, y: next.y });
    await page!.waitFor(`!!document.querySelector('${tab} [data-agent-marker]')`, { label: "click marker" });
    await shot("browse-click.png");
    await waitForValue(async () => ((await inPage<string>(`document.querySelector("#out").textContent`)) === "clicked next true" ? true : undefined));

    // Typed into a field, then Enter submits its form.
    const field = await rpc<{ x: number; y: number; form: { action: string } | null }>("page.target", { selector: "#q" });
    if (!field.form?.action.endsWith("/act-done")) throw new Error(`form: ${JSON.stringify(field.form)}`);
    await rpc("page.act", { kind: "type", x: field.x, y: field.y, value: "socks", clear: true });
    const typed = await inPage<string>(`document.querySelector("#q").value`);
    if (typed !== "socks") throw new Error(`typed ${JSON.stringify(typed)}`);
    await rpc("page.act", { kind: "key", key: "Enter" });
    const settled = await rpc<{ url: string; title: string }>("page.settle");
    if (!settled.url.includes("/act-done?q=socks")) throw new Error(`after Enter: ${settled.url}`);

    // A select and a checkbox filled in.
    await rpc("page.navigate", { url: `${site.url.origin}/act` });
    await rpc("page.act", { kind: "fill", selector: "#size", x: 0, y: 0, value: "M" });
    await rpc("page.act", { kind: "fill", selector: "#gift", x: 0, y: 0, value: "true" });
    const filled = await inPage<string>(`document.querySelector("#size").value + "|" + document.querySelector("#gift").checked`);
    if (filled !== "M|true") throw new Error(`filled ${filled}`);
    if (!(await rpc<boolean>("page.waitFor", { text: "act", timeoutMs: 1000 }))) throw new Error("wait_for didn't see the page");
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return "clicked (trusted), typed and submitted with Enter, filled a select and a checkbox";
  });

  await check("mods: gallery, make one from a page change, share code, review, install, turn off, remove", async () => {
    type Change = { id: string; title: string; enabled: boolean; modId?: string | null };
    const mine = await apiCall<Change>("/api/page-changes", {
      method: "POST",
      body: { title: "E2E mod change", scope: { type: "site", value: "127.0.0.1" }, action: "css", value: "body { outline: 1px solid red }" },
    });
    await click('[data-page-link="Mods"]');
    await page!.waitFor(`!!document.querySelector("[data-mods]")`, { label: "mods page" });

    await click(`[data-mods-tab="gallery"]`);
    await page!.waitFor(`document.querySelectorAll("[data-gallery-mod]").length >= 3`, { label: "gallery" });
    await shot("mods-gallery.png");

    // Made from the page change: a share code comes out.
    await click(`[data-mods-tab="create"]`);
    await page!.waitFor(`!!document.querySelector('[data-mod-change="${mine.id}"]')`, { label: "own page changes listed" });
    await page!.eval(`(() => {
      const name = document.querySelector("[data-mod-name]");
      name.value = "E2E mod";
      name.dispatchEvent(new InputEvent("input", { bubbles: true }));
      document.querySelector('[data-mod-change="${mine.id}"]').click();
      return true;
    })()`);
    await click("[data-mod-make]");
    const code = await page!.waitFor<string>(`document.querySelector("[data-mod-code]")?.value`, { label: "share code" });
    if (!code.startsWith("NATHAPP-MOD:")) throw new Error(`code: ${code.slice(0, 40)}`);
    await shot("mods-made.png");

    // Installed from the code (as someone else would), after the review.
    await apiCall(`/api/page-changes/${mine.id}`, { method: "DELETE" });
    await page!.eval(`(() => {
      const input = document.querySelector("[data-mod-input]");
      input.value = ${JSON.stringify(code)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await click("[data-mod-review]");
    await page!.waitFor(`!!document.querySelector("[data-mod-review-dialog]")`, { label: "review dialog" });
    const permissions = await page!.eval<string[]>(`[...document.querySelectorAll("[data-mod-permission]")].map((p) => p.dataset.modPermission + ": " + p.innerText)`);
    if (!permissions.some((p) => p.startsWith("info:") && p.includes("127.0.0.1"))) throw new Error(`review: ${permissions.join(" | ")}`);
    await shot("mods-review.png");
    await click("[data-mod-install]");
    await page!.waitFor(`!document.querySelector("[data-mod-review-dialog]") && !!document.querySelector("[data-mod]")`, { label: "installed" });
    const modId = await page!.eval<string>(`document.querySelector("[data-mod]").dataset.mod`);
    const installed = (await apiCall<Change[]>("/api/page-changes")).filter((c) => c.modId === modId);
    if (installed.length !== 1 || installed[0]!.title !== "E2E mod change") throw new Error(`installed changes: ${JSON.stringify(installed)}`);

    // Off: its change is off; removed: it's gone.
    await click(`[data-mod="${modId}"] [data-mod-toggle]`);
    await waitForValue(async () => ((await apiCall<Change[]>("/api/page-changes")).find((c) => c.modId === modId)?.enabled === false ? true : undefined));
    await click(`[data-mod="${modId}"] [data-mod-remove]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm remove" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('[data-mod="${modId}"]')`, { label: "removed" });
    if ((await apiCall<Change[]>("/api/page-changes")).some((c) => c.modId === modId)) throw new Error("the mod's change is still there");

    // A mod with a script is flagged before anything is installed.
    const scripty = { format: "nathapp-mod", version: 1, id: "e2e-scripty", name: "Scripty", author: "Someone", pageChanges: [{ title: "Watch", scope: { type: "pattern", value: "*" }, action: "script", value: "console.log(location.href)" }] };
    await page!.eval(`(() => {
      const input = document.querySelector("[data-mod-input]");
      input.value = ${JSON.stringify(JSON.stringify(scripty))};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await click("[data-mod-review]");
    await page!.waitFor(`document.querySelector('[data-mod-permission="danger"]')?.innerText.includes("every site")`, { label: "script warning" });
    await shot("mods-review-script.png");
    await click("[data-mod-cancel]");
    await page!.waitFor(`!document.querySelector("[data-mod-review-dialog]")`, { label: "review closed" });
    if ((await apiCall<unknown[]>("/api/mods")).length) throw new Error("cancelling installed it anyway");
    return "made, shared as a code, reviewed, installed, turned off, removed; a script mod flagged";
  });

  await check("network: requests with their data, credentials hidden, sent again, saved, blocked", async () => {
    if (!webTabId) throw new Error("needs the web tab");
    const tab = `[data-web-tab="${webTabId}"]`;
    const panel = `${tab} [data-network-panel]`;
    const inPage = <T>(code: string) => page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    const panelText = () => page!.eval<string>(`document.querySelector('${panel}')?.innerText ?? ""`);
    const secrets = ["cookie-secret-1", "key-secret-2", "bearer-secret-3", "resp-secret-4"];
    const leaked = (text: string) => secrets.filter((s) => text.includes(s));
    const status = () => inPage<string>(`document.getElementById("status")?.textContent ?? ""`);
    const goTo = async (url: string) => {
      await inPage(`location.href = ${JSON.stringify(url)}, true`);
      await waitForValue(async () => ((await inPage<string>("location.href")) === url ? true : undefined), 15_000);
    };

    await click(`nav li[data-app-id="${webTabId}"]`);
    await click(`${tab} [data-network-button]`);
    await page!.waitFor(`!!document.querySelector('${panel}')`, { label: "network panel" });
    await goTo(`${site.url.origin}/feed`);
    await waitForValue(async () => ((await status()) === "Loaded 2 items" ? true : undefined), 15_000);
    const feedRow = `[...document.querySelectorAll('${panel} [data-network-entry]')].find((r) => r.title.includes("/api/feed"))`;
    await page!.waitFor(`!!${feedRow}`, { label: "the feed request", timeoutMs: 10_000 });
    await page!.eval(`${feedRow}.click(), true`);
    await page!.waitFor(`document.querySelector('${panel} [data-network-response]')?.innerText.includes("Second post")`, { label: "the response data" });
    const hidden = await panelText();
    if (leaked(hidden).length) throw new Error(`credentials shown without asking: ${leaked(hidden).join(", ")}`);
    if (!hidden.includes("[redacted]")) throw new Error("nothing redacted");
    await shot("network.png");

    // Shown when asked.
    await click(`${panel} [data-network-reveal]`);
    await page!.waitFor(`document.querySelector('${panel} [data-network-detail]')?.innerText.includes("bearer-secret-3")`, { label: "revealed credentials" });
    await click(`${panel} [data-network-reveal]`);
    await page!.waitFor(`!document.querySelector('${panel} [data-network-detail]')?.innerText.includes("bearer-secret-3")`, { label: "hidden again" });

    // Sent again: the session's cookie and the original token go along.
    const before = siteSeen.length;
    await click(`${panel} [data-network-replay]`);
    await page!.waitFor(`document.querySelector('${panel} [data-network-result]')?.innerText.includes("HTTP 200")`, { label: "replay result" });
    const replayed = siteSeen[before];
    if (replayed?.authorization !== "Bearer bearer-secret-3" || !replayed.cookie?.includes("sid=cookie-secret-1") || !replayed.url.includes("api_key=key-secret-2")) {
      throw new Error(`the replay didn't carry the session: ${JSON.stringify(replayed)}`);
    }

    // Saved: its credentials are sealed, and it's sent later without the page.
    await click(`${panel} [data-network-save]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-network-save-name]')`, { label: "name field" });
    await page!.eval(`(() => {
      const input = document.querySelector('${panel} [data-network-save-name]');
      input.value = "Feed page 1";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    const saved = await waitForValue(async () => (await apiCall<{ id: string; name: string; hasCredentials: boolean }[]>("/api/network/requests")).find((r) => r.name === "Feed page 1"));
    const stored = JSON.stringify(await apiCall("/api/network/requests"));
    if (leaked(stored).length || !saved.hasCredentials) throw new Error(`saved request: ${stored}`);
    await goTo(`${site.url.origin}/second`);
    await click(`${panel} [data-network-saved-tab]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-saved-request="Feed page 1"] [data-send-saved]')`, { label: "saved list" });
    const beforeSaved = siteSeen.length;
    await click(`${panel} [data-saved-request="Feed page 1"] [data-send-saved]`);
    await page!.waitFor(`document.querySelector('${panel} [data-saved-request="Feed page 1"] [data-network-result]')?.innerText.includes("HTTP 200")`, {
      label: "saved request result",
    });
    const sent = siteSeen[beforeSaved];
    if (sent?.authorization !== "Bearer bearer-secret-3" || !sent.cookie?.includes("sid=cookie-secret-1") || !sent.url.includes("api_key=key-secret-2")) {
      throw new Error(`the saved request didn't carry the session: ${JSON.stringify(sent)}`);
    }
    const sentText = await panelText();
    if (leaked(sentText).length) throw new Error(`the saved request's result shows credentials: ${leaked(sentText).join(", ")}`);

    // Blocked by a rule.
    await click(`${panel} [role="tab"]`, "Requests");
    await goTo(`${site.url.origin}/feed`);
    await waitForValue(async () => ((await status()) === "Loaded 2 items" ? true : undefined), 15_000);
    await page!.waitFor(`!!${feedRow}`, { label: "the feed request again" });
    await page!.eval(`${feedRow}.click(), true`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-network-block]')`);
    await click(`${panel} [data-network-block]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    const rule = await waitForValue(async () => (await apiCall<{ id: string; pattern: string }[]>("/api/network/rules")).find((r) => r.pattern.includes("/api/feed")));
    await Bun.sleep(300); // the rules reach the main process over the hub
    const beforeBlock = siteSeen.length;
    await inPage("location.reload(), true");
    await waitForValue(async () => ((await status()) === "Failed to load" ? true : undefined), 15_000);
    if (siteSeen.length !== beforeBlock) throw new Error("the blocked request reached the site");
    await apiCall(`/api/network/rules/${rule.id}`, { method: "DELETE" });

    await click(`${tab} [data-network-button]`);
    await goTo(`${site.url.origin}/`);
    return `${secrets.length} kinds of credentials hidden, replayed and saved with the session, blocked by ${rule.pattern}`;
  });

  if (agentPrompt && webTabId) {
    await check("website agent customizes a picked element", async () => {
      const tab = `[data-web-tab="${webTabId}"]`;
      const inPage = <T>(code: string) =>
        page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
      await click(`nav li[data-app-id="${webTabId}"]`);
      await click(`${tab} [data-pick-element]`);
      await waitForValue(async () => ((await inPage<boolean>(`!!window.__nathappPicker`)) ? true : undefined));
      await inPage(`document.querySelector("#headline").click(), true`);
      await page!.waitFor(`!!document.querySelector('${agentOf(webTabId!)} [data-picked-chip]')`, { label: "picked heading" });
      await chooseAgent(agentOf(webTabId!), "claude", "haiku", "Low");
      await sendPrompt(agentOf(webTabId!), "Make this heading green (#16a34a) and give it a dashed border underneath.");
      const chat = await agentDone(agentOf(webTabId!));
      const color = await waitForValue(async () => {
        const c = await inPage<string>(`getComputedStyle(document.querySelector("#headline")).color`);
        return c === "rgb(22, 163, 74)" ? c : undefined;
      }, 15_000).catch(() => undefined);
      await shot("web-agent.png");
      if (!color) throw new Error(`heading isn't green:\n${chat.slice(-800)}`);
      const saved = await apiCall<{ css: string; js: string } | null>("/api/sites/127.0.0.1");
      if (!saved?.css.includes("16a34a")) throw new Error("customization wasn't saved");
      const reply = await page!.eval<string>(`[...document.querySelectorAll('${agentOf(webTabId!)} .nathapp-markdown')].at(-1)?.innerText ?? ""`);
      return reply.slice(0, 140);
    });
  }

  await check("extensions: imported from Chrome with their settings, toolbar, popup, shortcut, blocking", async () => {
    const id = fixture.extensionId;
    // Import from the (fake) browser profile, settings included.
    await click('[data-page-link="Settings"]');
    await page!.waitFor(`!!document.querySelector('[data-section="extensions"] [data-extensions-import]')`, { label: "extensions settings" });
    await click('[data-section="extensions"] [data-extensions-import]');
    await page!.waitFor(`!!document.querySelector('[data-extension-import] [data-import-candidate="${id}"]')`, { label: "the extension offered", timeoutMs: 15_000 });
    const offered = await page!.eval<number>(`document.querySelectorAll("[data-extension-import] [data-import-candidate]").length`);
    if (offered !== 1) throw new Error(`expected only the fixture to be offered (no browser components), got ${offered}`);
    const checked = await page!.eval<boolean>(`document.querySelector('[data-import-candidate="${id}"] input').checked && document.querySelector("[data-import-settings]").checked`);
    if (!checked) throw new Error("the extension (with its settings) should be picked by default");
    await shot("extensions-import.png");
    await click("[data-import-run]");
    await page!.waitFor(`document.querySelector("[data-import-result]")?.innerText.includes("Imported")`, { label: "import result", timeoutMs: 20_000 });
    await click("[data-extension-import] button", "Done");
    await page!.waitFor(`!!document.querySelector('[data-extension="${id}"]')`, { label: "extension listed" });
    const row = await page!.eval<string>(`document.querySelector('[data-extension="${id}"]').innerText`);
    if (!row.includes(fixture.name) || !row.includes("Chromium (Work)")) throw new Error(`settings row: ${row}`);
    await page!.eval(`document.querySelector('[data-section="extensions"]').scrollIntoView({ block: "start" }), true`);
    await shot("extensions-settings.png");

    // A web tab: the content script ran with the data from Chrome, and the pinned button shows its badge.
    const tabsBefore = await page!.eval<string[]>(`[...document.querySelectorAll("nav li")].map((li) => li.dataset.appId)`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `(() => { const id = document.querySelector('nav li[aria-current="page"]')?.dataset.appId; return id && !${JSON.stringify(tabsBefore)}.includes(id) ? id : null; })()`,
      { label: "new web tab" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    await page!.waitFor(`!!document.querySelector('${tab} [data-address]')`, { label: "address bar" });
    await page!.eval(`(() => {
      const input = document.querySelector('${tab} [data-address]');
      input.value = "${site.url.origin}/";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    const inPage = <T>(code: string) => inView<T>(tab, code);
    const marks = await waitForValue(async () => {
      const m = await inPage<string>(`document.documentElement.dataset.crx + "|" + document.documentElement.dataset.greeting`);
      return m?.startsWith("ok|") && !m.endsWith("undefined") ? m : undefined;
    }, 20_000);
    if (marks !== "ok|hello from chrome") throw new Error(`content script: ${marks}`);
    const badge = await page!.waitFor<string>(`document.querySelector('${tab} [data-extension-action="${id}"] [data-extension-badge]')?.textContent`, { label: "badge", timeoutMs: 15_000 });
    if (badge !== "7") throw new Error(`badge: ${badge}`);

    // Its declarativeNetRequest rules block (and NathApp's own rules, checked above, still work alongside).
    const before = siteSeen.length;
    const blocked = await inPage<string>(`fetch("/blocked-by-extension").then(() => "loaded", () => "blocked")`);
    if (blocked !== "blocked") throw new Error("the extension's rule didn't block the request");

    // The popup sees the tab it was opened on.
    await click(`${tab} [data-extension-action="${id}"]`);
    await page!.waitFor(`!!document.querySelector('[data-extension-popup="${id}"] webview')`, { label: "popup" });
    const popupUrl = await waitForValue(async () => {
      const text = await page!.eval<string>(`document.querySelector('[data-extension-popup="${id}"] webview').executeJavaScript('document.getElementById("url")?.textContent')`);
      return text && text !== "…" ? text : undefined;
    }, 15_000);
    if (popupUrl !== `${site.url.origin}/`) throw new Error(`popup's active tab: ${popupUrl}`);
    await Bun.sleep(300);
    await shot("extensions-popup.png");
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-extension-popup]")`, { label: "popup closed" });

    // The shortcut changed in Chrome (Alt+Shift+U) reaches the extension, with the tab.
    for (const type of ["rawKeyDown", "keyUp"]) {
      await page!.send("Input.dispatchKeyEvent", { type, modifiers: 1 | 8, key: "U", code: "KeyU", windowsVirtualKeyCode: 85, nativeVirtualKeyCode: 85 });
    }

    // Its options page opens as a web tab; there, its storage tells what it got.
    await click('[data-page-link="Settings"]');
    await page!.waitFor(`!!document.querySelector('[data-extension="${id}"] [data-extension-options]')`, { label: "options button" });
    await click(`[data-extension="${id}"] [data-extension-options]`);
    const optionsTab = await page!.waitFor<string>(
      `[...document.querySelectorAll("nav li")].find((li) => li.innerText.includes("Fixture options") && li.getAttribute("aria-current") === "page")?.dataset.appId`,
      { label: "options tab", timeoutMs: 15_000 },
    );
    const stored = await waitForValue(async () => {
      const value = await inView<{ installed?: { reason: string }; command?: string; tabUrl?: string; fromWorker?: number }>(
        `[data-web-tab="${optionsTab}"]`,
        `Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)]).then(([l, s]) => ({ ...l, ...s }))`,
      );
      return value?.command ? value : undefined;
    }, 15_000);
    // Imported with its data, it was updated rather than installed (no first-run pages).
    if (stored.installed?.reason !== "update") throw new Error(`runtime.onInstalled: ${JSON.stringify(stored.installed)}`);
    if (stored.command !== "bump" || stored.tabUrl !== `${site.url.origin}/`) throw new Error(`command: ${JSON.stringify(stored)}`);
    if (stored.fromWorker !== 1) throw new Error("storage.sync didn't keep the value");
    if (siteSeen.length !== before) throw new Error("a blocked request reached the site");
    return `content script with Chrome's data, badge ${badge}, popup on ${popupUrl}, shortcut → ${stored.command}, onInstalled: ${stored.installed.reason}`;
  });

  await check("workspaces: icons at the bottom, own tabs and web logins, switching keeps state, reorder, move tabs, shortcuts", async () => {
    const tabIds = () => page!.eval<string[]>(`[...document.querySelectorAll("nav li")].map((li) => li.dataset.appId)`);
    const selected = () => page!.eval<string | undefined>(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId`);
    const header = () => page!.eval<string>(`document.querySelector("[data-workspace-switcher]").innerText.trim().split("\\n").pop()`);
    const order = () => page!.eval<string[]>(`[...document.querySelectorAll("[data-workspace-bar] [data-workspace]")].map((b) => b.dataset.workspace)`);
    const menuOn = async (id: string, label: string) => {
      await page!.eval(`(() => {
        const b = document.querySelector('[data-workspace="${id}"]');
        const r = b.getBoundingClientRect();
        b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 10, clientY: r.top }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "workspace menu" });
      await click("[data-context-menu] button", label);
    };
    const personal = (await apiCall<{ id: string }[]>("/api/workspaces"))[0]!.id;
    const personalTabs = await tabIds();
    const personalSelected = await selected();

    // "+" at the bottom makes one, and its name is typed in the header.
    await click("[data-new-workspace]");
    await page!.waitFor(`!!document.querySelector("[data-workspace-name]")`, { label: "workspace name field" });
    await page!.eval(`(() => {
      const input = document.querySelector("[data-workspace-name]");
      input.value = "Client";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    await page!.waitFor(`document.querySelector("[data-workspace-switcher]")?.innerText.includes("Client")`, { label: "renamed workspace" });
    if ((await tabIds()).length) throw new Error("a new workspace should have no tabs");
    const client = (await apiCall<{ id: string; name: string }[]>("/api/workspaces")).find((w) => w.name === "Client")!;
    if ((await order()).join() !== [personal, client.id].join()) throw new Error(`bar: ${(await order()).join()}`);

    // A web tab here gets its own session: cookies set in Personal's web tab aren't there.
    const tab = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "web", url: `${site.url.origin}/`, workspaceId: client.id } });
    await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${tab.id}"]')`, { label: "tab in the sidebar" });
    await click(`nav li[data-app-id="${tab.id}"]`);
    const view = `[data-web-tab="${tab.id}"] webview`;
    await page!.waitFor(`document.querySelector('${view}')?.getAttribute("partition") === "persist:web-${client.id}"`, { label: "workspace session" });
    await waitForValue(async () => ((await inView<string>(`[data-web-tab="${tab.id}"]`, `document.querySelector("h1")?.textContent`)) ? true : undefined), 20_000);
    if (webTabId) await inView(`[data-web-tab="${webTabId}"]`, `document.cookie = "space=personal; path=/"`);
    const clientCookies = await inView<string>(`[data-web-tab="${tab.id}"]`, `document.cookie`);
    if (clientCookies.includes("space=personal")) throw new Error("the Client workspace sees Personal's cookies");

    // An icon in the bar, and Ctrl+Alt+1 / 2.
    await menuOn(client.id, "Change icon…");
    await page!.waitFor(`!!document.querySelector('[data-icon-picker] [data-icon="briefcase"]')`, { label: "icon picker" });
    await click('[data-icon-picker] [data-icon="briefcase"]');
    await waitForValue(async () => ((await apiCall<{ id: string; icon: string | null }[]>("/api/workspaces")).find((w) => w.id === client.id)?.icon === "briefcase" ? true : undefined));
    await shot("workspaces.png");
    await page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Digit1", ctrlKey: true, altKey: true, bubbles: true })), true`);
    await page!.waitFor(`document.querySelector("[data-workspace-switcher]")?.innerText.includes("Personal")`, { label: "Ctrl+Alt+1" });
    const back = await tabIds();
    if (back.join() !== personalTabs.join()) throw new Error(`Personal's tabs changed: ${back.join()} vs ${personalTabs.join()}`);
    if ((await selected()) !== personalSelected) throw new Error("the tab selected in Personal wasn't restored");
    await page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true, altKey: true, bubbles: true })), true`);
    await page!.waitFor(`document.querySelector("[data-workspace-switcher]")?.innerText.includes("Client")`, { label: "Ctrl+Alt+2" });
    await click(`[data-workspace="${personal}"]`);
    await page!.waitFor(`document.querySelector("[data-workspace-switcher]")?.innerText.includes("Personal")`, { label: "clicked Personal" });

    // Reordered from its menu (saved); a tab dropped on a workspace moves there.
    await menuOn(client.id, "Move left");
    await page!.waitFor(`[...document.querySelectorAll("[data-workspace-bar] [data-workspace]")][0]?.dataset.workspace === "${client.id}"`, { label: "reordered" });
    if ((await apiCall<{ id: string }[]>("/api/workspaces"))[0]!.id !== client.id) throw new Error("the order wasn't saved");
    const moving = personalTabs.at(-1)!;
    await page!.eval(`(() => {
      const from = document.querySelector('nav li[data-app-id="${moving}"]');
      const to = document.querySelector('[data-workspace="${client.id}"]');
      const dataTransfer = new DataTransfer();
      const at = { bubbles: true, cancelable: true, dataTransfer };
      from.dispatchEvent(new DragEvent("dragstart", at));
      to.dispatchEvent(new DragEvent("dragover", at));
      to.dispatchEvent(new DragEvent("drop", at));
      from.dispatchEvent(new DragEvent("dragend", at));
      return true;
    })()`);
    await waitForValue(async () => ((await apiCall<{ id: string; workspaceId: string }[]>("/api/apps")).find((t) => t.id === moving)?.workspaceId === client.id ? true : undefined));
    await apiCall(`/api/apps/${moving}/move`, { method: "POST", body: { workspaceId: personal } });
    await menuOn(client.id, "Move right");
    await page!.waitFor(`[...document.querySelectorAll("[data-workspace-bar] [data-workspace]")][0]?.dataset.workspace === "${personal}"`, { label: "order back" });

    // Deleted from its menu, with its tabs.
    await menuOn(client.id, "Delete workspace");
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('[data-workspace="${client.id}"]')`, { label: "deleted" });
    if ((await apiCall<unknown[]>("/api/workspaces")).length !== 1) throw new Error("the workspace wasn't deleted");
    return `separate cookies; icon, shortcuts, reorder, moved a tab by dropping it; ${await header()} restored`;
  });

  await check("command bar: finds tabs and commands, runs app actions, routes free text", async () => {
    const bar = "[data-command-bar]";
    const openBar = async () => {
      await page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })), true`);
      await page!.waitFor(`!!document.querySelector("${bar} input")`, { label: "command bar" });
    };
    const key = (k: string) => page!.eval(`document.querySelector("${bar} input").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true })), true`);
    /** Types into the bar; resolves with the first result's id. */
    const search = async (text: string, expected: string) => {
      await type(`${bar} input`, text);
      await page!.waitFor(`document.querySelector("${bar} [data-index='0']")?.dataset.command === ${JSON.stringify(expected)}`, {
        label: `"${text}" → ${expected}`,
        timeoutMs: 5_000,
      });
    };
    const selected = () => page!.eval<string | undefined>(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId`);

    // An app declares an action that opens one of its pages.
    const manifestFile = join(profile, "data", "apps", appId, "nathapp.json");
    const manifest = JSON.parse(await Bun.file(manifestFile).text());
    await Bun.write(manifestFile, JSON.stringify({ ...manifest, actions: [{ id: "second", title: "Open the second page", path: "/?from=command-bar" }] }));

    await openBar();
    await search("settings", "open.settings");
    await key("Enter");
    await page!.waitFor(`!!document.querySelector("[data-settings]")`, { label: "settings page" });

    const name = (await apiCall<{ id: string; name: string }[]>("/api/apps")).find((a) => a.id === appId)!.name;
    await openBar();
    await search(name, `tab:${appId}`);
    await key("Enter");
    await page!.waitFor(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId === "${appId}"`, { label: "the app selected" });

    await openBar();
    await search("open the second", `action:${appId}:second`);
    await key("Enter");
    await waitForValue(async () => ((await inView<string>(appTab(), "location.search")) === "?from=command-bar" ? true : undefined), 30_000);

    await openBar();
    await search("save a snap", "app.snapshot");
    await key("Enter");
    await page!.waitFor(`!!document.querySelector("[data-toast]")?.innerText.match(/snapshot/i)`, { label: "toast" });

    // Commands that ask for text first.
    await openBar();
    await search("rename tab", "tab.rename");
    await key("Enter");
    await page!.waitFor(`!!document.querySelector("${bar} [data-command-asking]")`, { label: "asks for the name" });
    await type(`${bar} input`, "Renamed from the bar");
    await key("Enter");
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${appId}"]')?.innerText.includes("Renamed from the bar")`, { label: "renamed" });
    await apiCall(`/api/apps/${appId}`, { method: "PATCH", body: { name } });

    // Free text: a URL opens, a sentence goes to the agent.
    await openBar();
    await search("example.com/docs", "route.open");
    await search("add a dark mode toggle to the header", "route.ask");
    await Bun.sleep(200); // the fade-in
    await shot("command-bar.png");
    await key("Escape");
    await page!.waitFor(`!document.querySelector("${bar}")`, { label: "closed" });
    if ((await selected()) !== appId) throw new Error("the selected tab changed");
    return `opened ${name} and its page, saved a snapshot, renamed it`;
  });

  await check("full access: switched on in Settings after a warning, shown in the agent sidebar, switched off there", async () => {
    await click('[data-page-link="Settings"]');
    await page!.waitFor(`!!document.querySelector("[data-permission-mode]")`, { label: "permissions setting" });
    await click("[data-permission-mode] button", "Full access");
    await page!.waitFor(`document.querySelector("[data-confirm-dialog]")?.innerText.includes("A web page can try")`, { label: "warning" });
    await shot("full-access-warning.png");
    await click("[data-confirm-dialog] [data-confirm]");
    await waitForValue(async () => ((await apiCall<{ agent: { permissions: string } }>("/api/settings")).agent.permissions === "full" ? true : undefined));
    await click(`nav li[data-app-id="${appId}"]`);
    const panel = `[data-agent-for="${appId}"]`;
    if (!(await page!.eval<boolean>(`!!document.querySelector('${panel}')`))) await click(`[data-app-tab="${appId}"] [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-full-access]')`, { label: "full access badge" });
    await click(`${panel} [data-full-access]`);
    await page!.waitFor(`!document.querySelector("[data-full-access]")`, { label: "badge gone" });
    await waitForValue(async () => ((await apiCall<{ agent: { permissions: string } }>("/api/settings")).agent.permissions === "ask" ? true : undefined));
    return "on with a warning, badge shown, back to asking";
  });

  await check("settings: theme presets apply and prompt additions are saved", async () => {
    await click('[data-page-link="Settings"]');
    await page!.waitFor(`!!document.querySelector("[data-settings] [data-preset]")`, { label: "settings page" });
    const rootBg = () => page!.eval<string>(`getComputedStyle(document.querySelector("#root > div")).backgroundColor`);
    await click("[data-preset]", "Midnight");
    await page!.waitFor(`getComputedStyle(document.querySelector("#root > div")).backgroundColor === "rgb(11, 16, 32)"`, {
      label: "Midnight background",
    });
    await Bun.sleep(300); // let color transitions finish
    await shot("settings.png");
    await page!.eval(`(() => {
      const t = document.querySelector('textarea[name="instructions"]');
      t.value = "Amounts are in EUR.";
      t.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await waitForValue(async () => {
      const s = await apiCall<{ agent: { instructions: string }; theme: { background?: string } }>("/api/settings");
      return s.agent.instructions === "Amounts are in EUR." && s.theme.background === "#0b1020" ? true : undefined;
    });
    const rows = await page!.eval<string[]>(`[...document.querySelectorAll("[data-provider-row]")].map((r) => r.dataset.providerRow + ":" + r.querySelector("[data-provider-state]")?.dataset.providerState)`);
    if (rows.length !== 3) throw new Error(`provider rows: ${rows.join(", ")}`);
    await page!.eval(`document.querySelector("[data-provider-row]").scrollIntoView({ block: "start" }), true`);
    await shot("settings-providers.png");
    await page!.waitFor(`!!document.querySelector("[data-app-ai-agent] [data-agent-picker]") && !!document.querySelector("[data-ai-limit]")`, { label: "AI in apps settings" });
    await page!.eval(`document.querySelector("[data-app-ai-agent]").scrollIntoView({ block: "center" }), true`);
    await shot("settings-ai.png");
    await click("[data-add-global-secret]");
    await page!.waitFor(`!!document.querySelector("[data-global-secret-warning]")`, { label: "global secret warning" });
    await page!.eval(`document.querySelector("[data-global-secret-warning]").scrollIntoView({ block: "center" }), true`);
    await shot("settings-secrets.png");
    await click("[data-preset]", "Default");
    await page!.waitFor(`getComputedStyle(document.querySelector("#root > div")).backgroundColor !== "rgb(11, 16, 32)"`);
    return `${rows.join(", ")}; background ${await rootBg()} after reset`;
  });

  await check("no uncaught errors in the renderer", async () => {
    // Expected noise from Electron itself isn't an app bug.
    const real = pageErrors.filter((e) => !/Electron Security Warning/.test(e));
    if (real.length) throw new Error(real.slice(0, 5).join("\n"));
  });
} finally {
  page?.close();
  site.stop(true);
  electron.kill();
  await electron.exited;
  rmSync(profile, { recursive: true, force: true });
  rmSync(browserDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}/`);
if (skippedShots.length) console.log(`(window wasn't painting, skipped screenshots: ${skippedShots.join(", ")})`);
process.exit(failed.length ? 1 : 0);
