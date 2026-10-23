// The tools agents get from gApp (over MCP). Page tools reach the page open in
// a tab — a website, or an app's preview — through the gApp window (RPC over
// the hub). App tools run and inspect the app's project; site tools save
// customizations for websites.
import { Effect, Schema } from "effect";
import { hostOf, inspectedStyles } from "../../shared/web";
import { Apps } from "../db/Apps";
import { Sites } from "../db/Sites";
import { Hub } from "../Hub";
import { isIcon, searchIcons } from "../icons";
import { presets } from "../workspace/presets";
import { Runtime } from "../workspace/Runtime";
import { Workspace } from "../workspace/Workspace";
import { NoArgs, text, tool } from "./Mcp";
import { topics } from "../../shared/hub";
import type { LogLine, RuntimeStatus } from "../../shared/api";

const transpiler = new Bun.Transpiler({ loader: "js" });

/** Throws with the parser's message if the JavaScript doesn't parse. */
export function checkSyntax(js: string) {
  try {
    transpiler.transformSync(`(() => {\n${js}\n})`);
  } catch (err) {
    throw new Error(`JavaScript syntax error: ${err instanceof Error ? err.message : err}`);
  }
}

export interface ToolEnv {
  /** The tab (and its page) the agent works on. */
  readonly tabId: string;
  /** Adds a line of activity to the chat ("Customized example.com"). */
  readonly log: (line: string) => Effect.Effect<void>;
}

// --- Page tools ------------------------------------------------------------------------

export const pageTools = Effect.fn(function* (env: ToolEnv, options: { site: boolean }) {
  const hub = yield* Hub;
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) => hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const evalIn = <T>(code: string) => call<T>("page.eval", { code });

  const where = options.site ? "the page in the user's tab" : "the app's preview";
  return [
    tool(
      "get_page",
      `The URL, title, viewport and visible text of ${where}.`,
      NoArgs,
      () =>
        evalIn<object>(`(() => {
            const text = (document.body?.innerText ?? "").replace(/\\n{3,}/g, "\\n\\n");
            return {
              url: location.href,
              title: document.title,
              viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight },
              text: text.length > 12000 ? text.slice(0, 12000) + "…" : text,
            };
          })()`).pipe(Effect.map((page) => JSON.stringify(page, null, 1))),
    ),

    tool(
      "inspect",
      `Elements of ${where} matching a CSS selector: count, outer HTML (truncated), position and key computed styles.`,
      Schema.Struct({ selector: Schema.String, limit: Schema.optionalKey(Schema.Finite) }),
      ({ selector, limit }) =>
        evalIn<object>(`((selector, limit, keys) => {
          const els = [...document.querySelectorAll(selector)];
          return {
            count: els.length,
            elements: els.slice(0, limit).map((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const html = el.outerHTML;
              return {
                html: html.length > 3000 ? html.slice(0, 3000) + "…" : html,
                rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
                styles: Object.fromEntries(keys.map((k) => [k, cs.getPropertyValue(k)])),
              };
            }),
          };
        })(${JSON.stringify(selector)}, ${Math.min(Math.max(limit ?? 5, 1), 20)}, ${JSON.stringify(inspectedStyles)})`).pipe(
          Effect.map((result) => JSON.stringify(result, null, 1)),
        ),
    ),

    tool(
      "run_js",
      `Run JavaScript in ${where} and get the result. \`code\` is the body of an async function: use \`return\` (JSON-serializable).${
        options.site ? " Changes made this way are lost on reload; use set_site_override to keep them." : " Good for checking behavior; change the source files for real changes."
      }`,
      Schema.Struct({ code: Schema.String }),
      ({ code }) =>
        evalIn<string>(`(async () => {
          const __result = await (async () => {
${code}
          })();
          if (__result === undefined) return "undefined";
          try {
            const s = JSON.stringify(__result, null, 1);
            return s === undefined ? String(__result) : s.length > 20000 ? s.slice(0, 20000) + "…" : s;
          } catch {
            return String(__result);
          }
        })()`),
    ),

    tool("screenshot", `A screenshot of ${where} as the user sees it right now.`, NoArgs, () =>
      call<string>("page.capture").pipe(Effect.map((data) => ({ content: [{ type: "image" as const, data, mimeType: "image/jpeg" }] }))),
    ),

    tool(
      "navigate",
      options.site ? "Open a URL in the tab and wait for it to load." : "Open a path of the app in the preview (e.g. /settings) and wait for it to load.",
      Schema.Struct({ url: Schema.String }),
      ({ url }) =>
        call<{ url: string; title: string }>("page.navigate", { url }, 45_000).pipe(
          Effect.tap((page) => (options.site ? env.log(`Opened ${page.url.slice(0, 80)}`) : Effect.void)),
          Effect.map((page) => `Loaded ${page.url} — ${page.title}`),
        ),
    ),

    tool("reload", `Reload ${where} and wait for it to load.`, NoArgs, () =>
      call<{ url: string }>("page.reload", {}, 45_000).pipe(Effect.map((page) => `Reloaded ${page.url}`)),
    ),
  ];
});

// --- Website tools ------------------------------------------------------------------

export const siteTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const sites = yield* Sites;
  const currentHost = hub.rpc<{ url: string }>("page.info", { tabId: env.tabId }).pipe(
    Effect.flatMap(({ url }) => {
      const host = hostOf(url);
      return host ? Effect.succeed(host) : Effect.fail(new Error("No website is open in this tab"));
    }),
  );

  return [
    tool("get_site_override", "The current site's customization (CSS and JavaScript applied whenever it loads in gApp).", NoArgs, () =>
      Effect.gen(function* () {
        const host = yield* currentHost;
        const override = yield* sites.get(host);
        return override
          ? JSON.stringify({ host, enabled: override.enabled, css: override.css, js: override.js }, null, 1)
          : `No customization for ${host} yet.`;
      }),
    ),

    tool(
      "set_site_override",
      'Replace the current site\'s customization and apply it to the page. Send the complete CSS and JS (omit one to keep it unchanged, use "" to clear it). Changing the JS reloads the page. Returns errors thrown by the JS.',
      Schema.Struct({ css: Schema.optionalKey(Schema.String), js: Schema.optionalKey(Schema.String) }),
      ({ css, js }) =>
        Effect.gen(function* () {
          const host = yield* currentHost;
          if (js) yield* Effect.try(() => checkSyntax(js));
          const saved = yield* sites.save(host, { css, js, enabled: true });
          yield* hub.publish({ type: "site", topic: topics.sites, host });
          const result = yield* hub.rpc<{ applied: boolean; error?: string }>("page.applyOverride", { tabId: env.tabId }, 45_000);
          yield* env.log(`Customized ${host}`);
          if (result.error) return text(`Saved, but the JavaScript threw: ${result.error}`, true);
          const sizes = `CSS ${saved.css.length} chars, JS ${saved.js.length} chars`;
          return result.applied
            ? `Saved and applied to ${host} (${sizes}).`
            : `Saved for ${host} (${sizes}), but customizations are turned off in Settings, so it isn't applied.`;
        }),
    ),
  ];
});

// --- App tools -------------------------------------------------------------------------

const describeStatus = (status: RuntimeStatus, logs: LogLine[]) => {
  const head =
    status.state === "running"
      ? `Running (${status.mode === "dev" ? "dev server" : "built app"}) at ${status.url}.`
      : status.state === "crashed"
        ? `Not running: ${status.error ?? "it crashed"}.`
        : status.state === "stopped"
          ? "Stopped."
          : `Still ${status.state}…`;
  const tail = logs.map((l) => (l.stream === "err" ? `! ${l.text}` : l.text)).join("\n");
  return tail ? `${head}\n\nRecent output:\n${tail}` : head;
};

export const appTools = Effect.fn(function* (env: ToolEnv) {
  const apps = yield* Apps;
  const workspace = yield* Workspace;
  const runtime = yield* Runtime;
  const hub = yield* Hub;
  const appId = env.tabId;

  const statusText = (lines = 40) =>
    Effect.gen(function* () {
      const status = yield* runtime.settled(appId, 90_000);
      return describeStatus(status, runtime.logs(appId, lines));
    });

  return [
    tool(
      "create_project",
      `Set up the app's project from a preset and start it. Presets: ${presets.map((p) => `${p.id} (${p.stack})`).join("; ")}.`,
      Schema.Struct({
        preset: Schema.Literals(presets.map((p) => p.id) as [string, ...string[]]),
        name: Schema.optionalKey(Schema.String.annotate({ description: "The app's name" })),
      }),
      ({ preset, name }) =>
        Effect.gen(function* () {
          const app = yield* apps.get(appId);
          const appName = name ?? (app && app.name !== "New app" ? app.name : "My app");
          const project = yield* workspace.scaffold(appId, preset, appName);
          if (name) {
            const summary = yield* apps.setInfo(appId, { name });
            if (summary) yield* hub.publish({ type: "app", topic: topics.apps, app: summary });
          }
          yield* env.log(`Created the project (${preset})`);
          yield* runtime.setMode(appId, "dev");
          const files = Object.keys(presets.find((p) => p.id === preset)!.files).sort();
          return `Created in ${project.dir}:\n${files.join("\n")}\ngapp.json, src/tokens.css\n\n${yield* statusText(20)}`;
        }),
    ),

    tool("app_status", "Whether the app is running (and where), with its recent output.", NoArgs, () => statusText()),

    tool(
      "restart_app",
      "Restart the app: installs dependencies if package.json changed, then starts the dev server again. Use it after changing dependencies or gapp.json, or when the app crashed. Returns its status and output.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          yield* runtime.restart(appId);
          const status = yield* runtime.settled(appId, 120_000);
          yield* env.log(status.state === "running" ? "Restarted the app" : `App ${status.state}`);
          return describeStatus(status, runtime.logs(appId, 40));
        }),
    ),

    tool(
      "app_logs",
      "Recent output of the app's processes (dev server, installs, builds).",
      Schema.Struct({ lines: Schema.optionalKey(Schema.Finite) }),
      ({ lines }) =>
        Effect.sync(() => {
          const logs = runtime.logs(appId, Math.min(Math.max(lines ?? 80, 1), 500));
          return logs.map((l) => (l.stream === "err" ? `! ${l.text}` : l.text)).join("\n") || "No output yet.";
        }),
    ),

    tool(
      "run_command",
      "Run a shell command in the app's sandbox (project folder, the app's environment and database). For `bun add <package>`, scripts, migrations, tests. Times out after 2 minutes (or timeout_seconds).",
      Schema.Struct({ command: Schema.String, timeout_seconds: Schema.optionalKey(Schema.Finite) }),
      ({ command, timeout_seconds }) =>
        Effect.gen(function* () {
          const result = yield* runtime.exec(appId, command, Math.min(Math.max(timeout_seconds ?? 120, 1), 600) * 1000);
          yield* env.log(`Ran \`${command.length > 70 ? `${command.slice(0, 69)}…` : command}\``);
          const head = result.timedOut ? "Timed out." : `Exit code ${result.code}.`;
          return text(`${head}\n${result.output || "(no output)"}`, result.timedOut || result.code !== 0);
        }),
    ),

    tool(
      "set_app_info",
      "Set the app's name (short, shown in gApp's sidebar) and icon (a Lucide icon name; find one with search_icons).",
      Schema.Struct({ name: Schema.optionalKey(Schema.String), icon: Schema.optionalKey(Schema.String) }),
      ({ name, icon }) =>
        Effect.gen(function* () {
          if (icon && !isIcon(icon)) return text(`Unknown icon "${icon}". Use search_icons to find one.`, true);
          const summary = yield* apps.setInfo(appId, { name: name?.trim() || undefined, icon });
          if (summary) yield* hub.publish({ type: "app", topic: topics.apps, app: summary });
          return summary ? `Saved: ${summary.name}${summary.icon ? ` (${summary.icon})` : ""}.` : "The app no longer exists.";
        }),
    ),

    tool("search_icons", "Find Lucide icon names by keywords (e.g. 'money', 'calendar check').", Schema.Struct({ query: Schema.String }), ({ query }) =>
      Effect.sync(() => {
        const names = searchIcons(query);
        return names.length ? names.join(", ") : "No icons found. Try a more general word.";
      }),
    ),
  ];
});

