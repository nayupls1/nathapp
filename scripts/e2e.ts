// End-to-end check of the built app: launches Electron against a throwaway
// profile and drives the real UI over the DevTools protocol.
//
//   bun run e2e                 UI checks (catalog, icons, new app, models)
//   bun run e2e --agent         also has the agent build an app (uses your Claude plan)
//   bun run e2e --agent "..."   ...with a custom prompt
//   bun run e2e --visible       show the window while testing (default: offscreen)
//
// Screenshots go to test-results/. Run `bun run build` first.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartExamples, componentDocs } from "../src/shared/catalog";
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

// Rendered offscreen by default: always painted (reliable screenshots) and no
// window pops up. --visible shows the window instead.
const visible = args.includes("--visible");
const electron = launchElectron({ GAPP_USER_DATA_DIR: profile, GAPP_OFFSCREEN: visible ? undefined : "1" }, [
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
    await page!.waitFor(`document.querySelector("nav")?.innerText.includes("Catalog")`, { timeoutMs: 20_000 });
  });

  await check("catalog renders every component", async () => {
    await click("nav button", "Catalog");
    await page!.waitFor(`document.querySelectorAll("[data-catalog-component]").length`);
    const found = await page!.eval<string[]>(
      `[...document.querySelectorAll("[data-catalog-component]")].map((e) => e.dataset.catalogComponent)`,
    );
    const missing = componentDocs.map((d) => d.type).filter((t) => !found.includes(t));
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
    const errors = await page!.eval<string[]>(`[...document.querySelectorAll("[data-render-error]")].map((e) => e.textContent)`);
    if (errors.length) throw new Error(errors.join("; "));
    return `${found.length} components`;
  });

  await check("catalog data loads and charts draw", async () => {
    const expected = 1 + chartExamples.length;
    // Every chart example renders an SVG with marks once its data arrives.
    const drawn = await page!.waitFor<number>(
      `(() => {
        const charts = [...document.querySelectorAll("[data-catalog-example] .ts-chart-host svg")]
          .filter((svg) => svg.querySelectorAll("path, rect, circle").length > 0);
        return charts.length >= ${expected} && charts.length;
      })()`,
      { label: `${expected} drawn charts` },
    );
    const statText = await page!.eval<string>(`document.querySelector('[data-catalog-component="stat"]').innerText`);
    if (!/\d/.test(statText)) throw new Error(`stat shows no number: ${statText}`);
    await shot("catalog.png");
    return `${drawn} charts`;
  });

  await check("catalog form inserts a row", async () => {
    const before = await page!.eval<number>(`document.querySelectorAll('[data-catalog-component="list"] li').length`);
    await page!.eval(`(() => {
      const form = document.querySelector('[data-catalog-component="form"] form');
      form.querySelector('[name="title"]').value = "E2E task";
      form.requestSubmit();
      return true;
    })()`);
    await page!.waitFor(`document.querySelectorAll('[data-catalog-component="list"] li').length === ${before + 1}`, {
      label: "list to grow by one",
    });
  });

  await check("realtime: writes from elsewhere show up live", async () => {
    // Another client (here: a plain fetch, like a backend would) inserts a row;
    // the list must update from the server's WebSocket push alone.
    const before = await page!.eval<number>(`document.querySelectorAll('[data-catalog-component="list"] li').length`);
    const started = Date.now();
    await page!.eval(`fetch(window.gapp.serverUrl + "/api/apps/catalog/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "action", action: { type: "insert", table: "tasks", values: { title: "Pushed live" } } }),
    }).then((r) => r.ok)`);
    await page!.waitFor(`[...document.querySelectorAll('[data-catalog-component="list"] li')].some((li) => li.innerText.includes("Pushed live"))`, {
      label: "pushed row",
      timeoutMs: 3000,
    });
    const after = await page!.eval<number>(`document.querySelectorAll('[data-catalog-component="list"] li').length`);
    if (after !== before + 1) throw new Error(`expected ${before + 1} rows, got ${after}`);
    return `${Date.now() - started}ms`;
  });

  await check("custom component runs and uses the realtime SDK", async () => {
    // The example counts open tasks live and has a button that inserts one.
    const frameUrl = "/frame/catalog/live-counter";
    const count = () => page!.evalIn<string>(frameUrl, `document.getElementById("count").textContent`);
    // The frame loads after the catalog renders; on a cold start that can take a while.
    const before = Number(await waitForValue(async () => ((await count()).match(/^\d+$/) ? await count() : undefined), 30_000));
    await page!.evalIn(frameUrl, `document.getElementById("add").click(), true`);
    await waitForValue(async () => (Number(await count()) === before + 1 ? true : undefined));
    await page!.waitFor(
      `[...document.querySelectorAll('[data-catalog-component="list"] li')].length > 0 && !document.querySelector("[data-custom-component] [data-render-error]")`,
    );
    const height = await page!.eval<number>(`document.querySelector("[data-custom-component] iframe").getBoundingClientRect().height`);
    if (height < 60) throw new Error(`iframe did not size to its content (${height}px)`);
    return `${before} → ${before + 1} open tasks, ${Math.round(height)}px tall`;
  });

  await check("icon search", async () => {
    await page!.eval(`(() => {
      const input = document.querySelector('#catalog-Icons input');
      input.value = "wallet";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    const names = await page!.waitFor<string[]>(
      `(() => { const n = [...document.querySelectorAll('#catalog-Icons button')].map((b) => b.title); return n.includes("wallet") && n; })()`,
    );
    return `${names.length} matches for "wallet"`;
  });

  await check("new app screen with model and effort pickers", async () => {
    await newTab("New app");
    await page!.waitFor(`document.body.innerText.includes("What do you want to build?")`);
    const options = await page!.waitFor<number>(`document.querySelector('select[title="Model"]')?.options.length > 1 && document.querySelector('select[title="Model"]').options.length`, {
      timeoutMs: 20_000,
      label: "models to load",
    });
    const efforts = await page!.eval<number>(`document.querySelector('select[title="Effort"]')?.options.length ?? 0`);
    if (efforts < 2) throw new Error("effort picker missing");
    await shot("new-app.png");
    return `${options - 1} models, ${efforts - 1} effort levels`;
  });

  if (agentPrompt) {
    await check("agent builds an app", async () => {
      // Fastest model keeps this cheap; any model exercises the same path.
      await page!.eval(`(() => {
        const select = (title, value) => {
          const el = document.querySelector('select[title="' + title + '"]');
          if (![...el.options].some((o) => o.value === value)) return;
          el.value = value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        select("Model", "haiku");
        select("Effort", "low");
        const t = document.querySelector("textarea");
        t.value = ${JSON.stringify(agentPrompt)};
        t.dispatchEvent(new InputEvent("input", { bubbles: true }));
        t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector("aside textarea")`, { label: "chat to open" });
      await page!.waitFor(`!document.querySelector("aside")?.innerText.includes("Working…") && [...document.querySelectorAll("aside button")].some((b) => b.textContent === "Send")`, {
        timeoutMs: 240_000,
        label: "agent to finish",
      });
      const chat = await page!.eval<string>(`document.querySelector("aside").innerText`);
      if (!chat.includes("Updated app")) throw new Error(`agent did not update the app:\n${chat.slice(-600)}`);
      const errors = await page!.eval<number>(`document.body.innerText.includes("failed to render")`);
      if (errors) throw new Error("generated app failed to render");
      await shot("agent-app.png");
      const name = await page!.eval<string>(`document.querySelector("nav li")?.innerText.split("\\n")[0].trim()`);
      return `built "${name}"`;
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

  await check("custom backend: runs, button calls it, data arrives live", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New app");
    const appId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "new app in the sidebar" },
    );
    const spec = {
      name: "Backend demo",
      icon: "server",
      tables: [{ name: "pings", columns: [{ name: "note", type: "text" }] }],
      ui: {
        type: "stack",
        children: [
          { type: "button", label: "Ping backend", action: { type: "backend", path: "/api/ping" } },
          { type: "list", table: "pings", primary: "note" },
        ],
      },
    };
    const serverTs = [
      'import { connect } from "./gapp";',
      "const gapp = connect();",
      "Bun.serve({",
      "  port: Number(process.env.PORT),",
      '  routes: { "/api/ping": { POST: async () => { await gapp.insert("pings", { note: "pong from backend" }); return Response.json({ ok: true }); } } },',
      '  fetch: () => new Response("Not found", { status: 404 }),',
      "});",
      'console.log("backend up");',
    ].join("\n");
    await page!.eval(`(async () => {
      const base = window.gapp.serverUrl + "/api/apps/${appId}";
      const put = (path, body, type) => fetch(base + path, { method: "PUT", headers: { "Content-Type": type }, body });
      const a = await put("/files/server.ts", ${JSON.stringify(serverTs)}, "text/plain");
      const b = await put("/spec", ${JSON.stringify(JSON.stringify(spec))}, "application/json");
      if (!a.ok || !b.ok) throw new Error("setup failed: " + a.status + " " + b.status);
      return true;
    })()`);
    // The spec arrives over the realtime connection; opening it auto-starts the backend.
    await page!.waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.includes("Ping backend"))`, {
      label: "imported app to render",
    });
    await page!.waitFor(`!!document.querySelector('[data-backend-pill="running"]')`, { timeoutMs: 20_000, label: "backend running" });
    await click("button", "Ping backend");
    await page!.waitFor(`document.body.innerText.includes("pong from backend")`, { label: "row written by the backend" });

    await click("[data-backend-pill]");
    await page!.waitFor(`document.querySelector("[data-backend-drawer]")?.innerText.includes("backend up")`, { label: "backend logs" });
    await shot("backend.png");

    // Collapsing the agent panel gives the app the whole width.
    await click("[data-agent-hide]");
    await page!.waitFor(`!document.querySelector("[data-agent-panel]") && !!document.querySelector("[data-agent-show]")`, {
      label: "agent panel hidden",
    });
    await click("[data-agent-show]");
    await page!.waitFor(`!!document.querySelector("[data-agent-panel]")`, { label: "agent panel shown" });
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
    await page!.eval(`fetch(window.gapp.serverUrl + "/api/sites/127.0.0.1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ css: "h1 { color: rgb(220, 20, 60) !important }", js: "onElement('.lead', (el) => { el.textContent = 'Changed by override'; });" }),
    }).then((r) => r.ok)`);
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
      await page!.eval(`(() => {
        const root = document.querySelector('${tab} [data-agent-panel]');
        const select = (title, value) => {
          const el = root.querySelector('select[title="' + title + '"]');
          if (![...el.options].some((o) => o.value === value)) return;
          el.value = value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        select("Model", "haiku");
        select("Effort", "low");
        const t = root.querySelector("textarea");
        t.value = "Make this heading green (#16a34a) and give it a dashed border underneath.";
        t.dispatchEvent(new InputEvent("input", { bubbles: true }));
        t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`);
      await page!.waitFor(`document.querySelector('${tab} [data-agent-panel] button')?.textContent !== "Send"`, { label: "agent to start" }).catch(() => {});
      await page!.waitFor(
        `[...document.querySelectorAll('${tab} [data-agent-panel] button')].some((b) => b.textContent === "Send") && !document.querySelector('${tab} [data-agent-panel]').innerText.includes("Working…")`,
        { timeoutMs: 240_000, label: "agent to finish" },
      );
      const chat = await page!.eval<string>(`document.querySelector('${tab} [data-agent-panel]').innerText`);
      const color = await waitForValue(async () => {
        const c = await inPage<string>(`getComputedStyle(document.querySelector("#headline")).color`);
        return c === "rgb(22, 163, 74)" ? c : undefined;
      }, 15_000).catch(() => undefined);
      await shot("web-agent.png");
      if (!color) throw new Error(`heading isn't green:\n${chat.slice(-800)}`);
      const saved = await page!.eval<{ css: string; js: string } | null>(
        `fetch(window.gapp.serverUrl + "/api/sites/127.0.0.1").then((r) => r.json())`,
      );
      if (!saved?.css.includes("16a34a")) throw new Error("customization wasn't saved");
      const reply = await page!.eval<string>(`[...document.querySelectorAll('${tab} [data-agent-panel] p')].at(-1)?.innerText ?? ""`);
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
    await page!.waitFor(
      `fetch(window.gapp.serverUrl + "/api/settings").then((r) => r.json()).then((s) => s.agent.instructions === "Amounts are in EUR." && s.theme.background === "#0b1020")`,
      { label: "settings saved on the server" },
    );
    await click("[data-preset]", "Default");
    await page!.waitFor(`getComputedStyle(document.querySelector("#root > div")).backgroundColor !== "rgb(11, 16, 32)"`);
    return `background ${await rootBg()} after reset`;
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
