// End-to-end check of the built app: launches Electron against a throwaway
// profile and drives the real UI over the DevTools protocol.
//
//   bun run e2e                 UI checks (providers, app previews, dev/live, web tabs, settings)
//   bun run e2e --agent         also has the agents build an app and customize a site (uses your Claude plan)
//   bun run e2e --agent "..."   ...with a custom prompt
//   bun run e2e --visible       show the window while testing (default: offscreen)
//
// Screenshots go to test-results/. Run `bun run build` first.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchElectron } from "./electron";
import { Page } from "./lib/cdp";

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
const profile = mkdtempSync(join(tmpdir(), "gapp-e2e-"));

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
const electron = launchElectron({ GAPP_USER_DATA_DIR: profile, GAPP_OFFSCREEN: visible ? undefined : "1" }, [
  ...(visible ? [] : ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080"]),
  // No OS keychain (it could ask to be unlocked): the secrets key falls back to a file.
  "--password-store=basic",
  `--remote-debugging-port=${port}`,
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
]);

// A small website for the web tab checks.
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const body =
      path === "/second"
        ? `<title>Second page</title><h1>Second</h1>`
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

/** Authenticated request to the gApp server, made from the renderer. */
const apiCall = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
  page!.eval<T>(`fetch(window.gapp.serverUrl + ${JSON.stringify(path)}, {
    method: ${JSON.stringify(init.method ?? "GET")},
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.gapp.token },
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

/** Waits until the agent in `root` started and finished. */
async function agentDone(root: string) {
  const panel = `${root} [data-agent-panel]`;
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
  console.log("Launching gApp…");
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
    await page!.waitFor(`document.querySelector("nav")?.innerText.includes("Settings")`, { timeoutMs: 20_000 });
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
    await waitForValue(async () => ((await inView<boolean>(appTab(), `!!window.__gappPicker`)) ? true : undefined));
    await inView(appTab(), `document.querySelector("h1").click(), true`);
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-picked-chip]')`, { label: "picked chip" });
  });

  await check("done: the app is built and served by its start command", async () => {
    await click(`${appTab()} [data-mode="live"]`);
    await page!.waitFor(`!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { label: "restart", timeoutMs: 10_000 }).catch(() => {});
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-runtime-state="running"]')`, { timeoutMs: 120_000, label: "live app running" });
    const status = await apiCall<{ status: { mode: string; state: string } }>(`/api/apps/${appId}/runtime`);
    if (status.status.mode !== "live") throw new Error(`mode is ${status.status.mode}`);
    await waitForValue(async () => ((await inView<string>(appTab(), `document.body.innerText`)).includes("Edited live:") ? true : undefined), 20_000);
    await click(`${appTab()} [data-logs]`);
    await page!.waitFor(`document.querySelector('${appTab()} [data-logs-panel]')?.innerText.includes("bun run start")`, { label: "logs" });
    await shot("app-live.png");
    await click(`${appTab()} [data-logs]`);
    await click(`${appTab()} [data-mode="dev"]`);
  });

  /** Sets an input's value the way typing does. */
  const type = (selector: string, value: string) =>
    page!.eval(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);

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
    await click("nav button", "Activity");
    await page!.waitFor(`!!document.querySelector('[data-activity] [data-audit-action="secret.create"]') && !!document.querySelector('[data-activity] [data-audit-action="permission.deny"]')`, {
      label: "secret and permission entries",
    });
    const count = await page!.eval<number>(`document.querySelectorAll("[data-activity] [data-audit-action]").length`);
    await shot("activity.png");
    await click(`nav li[data-app-id="${appId}"]`);
    return `${count} entries`;
  });

  await check("agent panel collapses and comes back", async () => {
    await click(`${appTab()} [data-agent-hide]`);
    await page!.waitFor(`!document.querySelector('${appTab()} [data-agent-panel]') && !!document.querySelector('${appTab()} [data-agent-show]')`, {
      label: "agent panel hidden",
    });
    await click(`${appTab()} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-agent-panel]')`, { label: "agent panel shown" });
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
      await chooseAgent(root, "claude", "haiku", "Low");
      await sendPrompt(root, agentPrompt);
      const chat = await agentDone(root);
      await page!.waitFor(`!!document.querySelector('${root} [data-runtime-state="running"]')`, { timeoutMs: 60_000, label: `app running:\n${chat.slice(-600)}` });
      const text = await waitForValue(async () => (await inView<string>(root, `document.body.innerText`)) || undefined, 20_000);
      await shot("agent-app.png");
      const name = await page!.eval<string>(`document.querySelector('nav li[data-app-id="${id}"]').innerText.split("\\n")[0].trim()`);
      return `built "${name}": ${text.slice(0, 80).replace(/\s+/g, " ")}`;
    });
  }

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
    await waitForValue(async () => ((await inPage<boolean>(`!!window.__gappPicker`)) ? true : undefined));
    await inPage(`document.querySelector(".cta").click(), true`);
    await page!.waitFor(`document.querySelector('${tab} [data-picked-chip]')?.innerText.includes("Buy now")`, {
      label: "picked element chip",
    });
    const outlined = await inPage<boolean>(`document.querySelector(".cta").hasAttribute("data-gapp-picked")`);
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

    // Turning customizations off in the tab's menu removes them.
    await click(`${tab} [data-customized]`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`);
    await click("[data-context-menu] button", "Turn off");
    await waitForValue(
      async () => ((await inPage<string>(`getComputedStyle(document.querySelector("h1")).color`)) !== "rgb(220, 20, 60)" ? true : undefined),
      15_000,
    );
    return "picked, customized, popup";
  });

  if (agentPrompt && webTabId) {
    await check("website agent customizes a picked element", async () => {
      const tab = `[data-web-tab="${webTabId}"]`;
      const inPage = <T>(code: string) =>
        page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
      await click(`nav li[data-app-id="${webTabId}"]`);
      await click(`${tab} [data-pick-element]`);
      await waitForValue(async () => ((await inPage<boolean>(`!!window.__gappPicker`)) ? true : undefined));
      await inPage(`document.querySelector("#headline").click(), true`);
      await page!.waitFor(`!!document.querySelector('${tab} [data-picked-chip]')`, { label: "picked heading" });
      await chooseAgent(`${tab} [data-agent-panel]`, "claude", "haiku", "Low");
      await sendPrompt(`${tab} [data-agent-panel]`, "Make this heading green (#16a34a) and give it a dashed border underneath.");
      const chat = await agentDone(tab);
      const color = await waitForValue(async () => {
        const c = await inPage<string>(`getComputedStyle(document.querySelector("#headline")).color`);
        return c === "rgb(22, 163, 74)" ? c : undefined;
      }, 15_000).catch(() => undefined);
      await shot("web-agent.png");
      if (!color) throw new Error(`heading isn't green:\n${chat.slice(-800)}`);
      const saved = await apiCall<{ css: string; js: string } | null>("/api/sites/127.0.0.1");
      if (!saved?.css.includes("16a34a")) throw new Error("customization wasn't saved");
      const reply = await page!.eval<string>(`[...document.querySelectorAll('${tab} [data-agent-panel] .gapp-markdown')].at(-1)?.innerText ?? ""`);
      return reply.slice(0, 140);
    });
  }

  await check("settings: theme presets apply and prompt additions are saved", async () => {
    await click("nav button", "Settings");
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
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}/`);
if (skippedShots.length) console.log(`(window wasn't painting, skipped screenshots: ${skippedShots.join(", ")})`);
process.exit(failed.length ? 1 : 0);
