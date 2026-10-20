// End-to-end check of the built app: launches Electron against a throwaway
// profile and drives the real UI over the DevTools protocol.
//
//   bun run e2e                 UI checks (catalog, icons, new app, models)
//   bun run e2e --agent         also has the agent build an app (uses your Claude plan)
//   bun run e2e --agent "..."   ...with a custom prompt
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

const electron = launchElectron({ GAPP_USER_DATA_DIR: profile }, [`--remote-debugging-port=${port}`]);

const results: { name: string; ok: boolean; detail?: string }[] = [];
const pageErrors: string[] = [];
let page: Page | undefined;

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
    await page?.screenshot(join(outDir, `failure-${results.length}.png`)).catch(() => {});
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

const click = (selector: string, text?: string) =>
  page!.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) throw new Error("not found: ${selector} ${text ?? ""}");
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
    await page!.screenshot(join(outDir, "catalog.png"));
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
    const before = Number(await waitForValue(async () => ((await count()).match(/^\d+$/) ? await count() : undefined)));
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
    await click("nav button", "New app");
    await page!.waitFor(`document.body.innerText.includes("What do you want to build?")`);
    const options = await page!.waitFor<number>(`document.querySelector('select[title="Model"]')?.options.length > 1 && document.querySelector('select[title="Model"]').options.length`, {
      timeoutMs: 20_000,
      label: "models to load",
    });
    const efforts = await page!.eval<number>(`document.querySelector('select[title="Effort"]')?.options.length ?? 0`);
    if (efforts < 2) throw new Error("effort picker missing");
    await page!.screenshot(join(outDir, "new-app.png"));
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
      await page!.waitFor(`!document.querySelector("aside")?.innerText.includes("Working…") && document.querySelector("aside button")?.textContent === "Send"`, {
        timeoutMs: 240_000,
        label: "agent to finish",
      });
      const chat = await page!.eval<string>(`document.querySelector("aside").innerText`);
      if (!chat.includes("Updated app")) throw new Error(`agent did not update the app:\n${chat.slice(-600)}`);
      const errors = await page!.eval<number>(`document.body.innerText.includes("failed to render")`);
      if (errors) throw new Error("generated app failed to render");
      await page!.screenshot(join(outDir, "agent-app.png"));
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

  await check("settings: theme presets apply and prompt additions are saved", async () => {
    await click("nav button", "Settings");
    await page!.waitFor(`!!document.querySelector("[data-settings] [data-preset]")`, { label: "settings page" });
    const rootBg = () => page!.eval<string>(`getComputedStyle(document.querySelector("#root > div")).backgroundColor`);
    await click("[data-preset]", "Midnight");
    await page!.waitFor(`getComputedStyle(document.querySelector("#root > div")).backgroundColor === "rgb(11, 16, 32)"`, {
      label: "Midnight background",
    });
    await Bun.sleep(300); // let color transitions finish
    await page!.screenshot(join(outDir, "settings.png"));
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
  electron.kill();
  await electron.exited;
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}/`);
process.exit(failed.length ? 1 : 0);
