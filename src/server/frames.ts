// Pages for "custom" components: agent-written HTML/CSS/JS shown in an iframe.
// They're served from this server's origin so they can use the realtime SDK
// (/sdk/gapp.js) and the API directly, isolated from the gApp window.
import type { AppSpec, UINode } from "../shared/spec";

export function findCustom(spec: AppSpec, name: string): Extract<UINode, { type: "custom" }> | undefined {
  const walk = (node: UINode): Extract<UINode, { type: "custom" }> | undefined => {
    if (node.type === "custom") return node.name === name ? node : undefined;
    const children =
      "children" in node ? node.children : node.type === "tabs" ? node.tabs.flatMap((t) => t.children) : [];
    for (const child of children) {
      const hit = walk(child);
      if (hit) return hit;
    }
  };
  return walk(spec.ui);
}

// --- Errors reported by custom components (shown to the agent) ---------------

const errors = new Map<string, { at: string; component: string; message: string }[]>();

export function reportFrameError(appId: string, component: string, message: string) {
  const list = errors.get(appId) ?? [];
  list.push({ at: new Date().toISOString(), component, message: message.slice(0, 2000) });
  errors.set(appId, list.slice(-20));
}

export const frameErrors = (appId: string) => errors.get(appId) ?? [];
export const clearFrameErrors = (appId: string) => errors.delete(appId);

// --- Page ----------------------------------------------------------------------

/** Base styles so plain HTML matches the app; colors come from the host theme. */
const baseCss = `
:root {
  --gapp-bg: #fafafa; --gapp-surface: #fff; --gapp-surface-hover: #f4f4f5; --gapp-text: #18181b;
  --gapp-muted: #71717a; --gapp-border: #e4e4e7; --gapp-accent: #6d4aff; --gapp-accent-text: #fff;
  --gapp-accent-soft: #efebff; --gapp-danger: #dc2626; --gapp-success: #16a34a; --gapp-warning: #d97706;
  --gapp-radius: 10px; --gapp-radius-sm: 6px; --gapp-font: Inter, ui-sans-serif, system-ui, sans-serif;
  --gapp-mono: ui-monospace, "JetBrains Mono", monospace;
  color-scheme: light dark;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body { font: 14px/1.5 var(--gapp-font); color: var(--gapp-text); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4, p { margin: 0 0 0.5em; }
a { color: var(--gapp-accent); }
code, pre { font-family: var(--gapp-mono); font-size: 0.92em; }
button {
  font: inherit; font-weight: 500; height: 32px; padding: 0 12px; cursor: pointer;
  border: 1px solid var(--gapp-border); border-radius: var(--gapp-radius-sm);
  background: var(--gapp-surface); color: var(--gapp-text);
}
button:hover { background: var(--gapp-surface-hover); }
button.primary { background: var(--gapp-accent); border-color: var(--gapp-accent); color: var(--gapp-accent-text); }
input, select, textarea {
  font: inherit; color: inherit; height: 34px; padding: 0 10px;
  border: 1px solid var(--gapp-border); border-radius: var(--gapp-radius-sm); background: var(--gapp-surface);
}
textarea { height: auto; padding: 8px 10px; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--gapp-accent); }
.muted { color: var(--gapp-muted); }
.card { padding: 16px; border: 1px solid var(--gapp-border); border-radius: var(--gapp-radius); background: var(--gapp-surface); }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.stack { display: flex; flex-direction: column; gap: 12px; }
`;

/** Bridges the iframe and the gApp window: theme in, size and errors out. */
const bootstrap = (component: string) => `(() => {
const post = (msg) => parent.postMessage({ source: "gapp-frame", component: ${JSON.stringify(component)}, ...msg }, "*");
addEventListener("message", (e) => {
  if (e.source !== parent || e.data?.type !== "gapp:theme") return;
  for (const [k, v] of Object.entries(e.data.vars)) document.documentElement.style.setProperty(k, v);
  if (e.data.scheme) document.documentElement.style.colorScheme = e.data.scheme;
});
const report = (message) => {
  post({ type: "error", message });
  fetch("/api/apps/" + GAPP.appId + "/frame-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ component: ${JSON.stringify(component)}, message }),
  }).catch(() => {});
};
addEventListener("error", (e) => report(e.error?.stack || e.message));
addEventListener("unhandledrejection", (e) => report(e.reason?.stack || String(e.reason)));
const size = () => post({ type: "height", height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
new ResizeObserver(size).observe(document.documentElement);
addEventListener("load", size);
post({ type: "ready" });
})();`;

export function frameHtml(appId: string, node: Extract<UINode, { type: "custom" }>) {
  const config = JSON.stringify({ appId, component: node.name }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base target="_blank">
<script>window.GAPP = Object.assign(${config}, { url: location.origin });</script>
<script>${bootstrap(node.name)}</script>
<style>${baseCss}</style>
</head>
<body>
${node.html}
</body>
</html>`;
}
