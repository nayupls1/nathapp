// The "custom" catalog component: agent-written HTML/JS in an iframe served by
// the gApp server. The iframe gets the current theme, reports its height so it
// sizes to its content, and reports errors (shown here and to the agent).
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import type { UINode } from "../../shared/spec";
import { settings } from "../lib/settings";
import { systemDark } from "../lib/theme";
import { colors, font, radius, space } from "../theme.stylex";
import { useApp } from "./context";

type CustomNode = Extract<UINode, { type: "custom" }>;

const themeVars: [string, string][] = [
  ["--gapp-bg", colors.bg],
  ["--gapp-surface", colors.surface],
  ["--gapp-surface-hover", colors.surfaceHover],
  ["--gapp-text", colors.text],
  ["--gapp-muted", colors.muted],
  ["--gapp-border", colors.border],
  ["--gapp-accent", colors.accent],
  ["--gapp-accent-text", colors.accentText],
  ["--gapp-accent-soft", colors.accentSoft],
  ["--gapp-danger", colors.danger],
  ["--gapp-success", colors.success],
  ["--gapp-warning", colors.warning],
  ["--gapp-radius", radius.md],
  ["--gapp-radius-sm", radius.sm],
  ["--gapp-font", font.sans],
  ["--gapp-mono", font.mono],
];

const varName = (ref: string) => /var\((--[^),\s]+)/.exec(ref)?.[1] ?? ref;

/** Short content hash, so the iframe reloads when the agent changes the HTML. */
function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function Custom(props: { node: CustomNode }) {
  const app = useApp();
  let frame!: HTMLIFrameElement;
  const [height, setHeight] = createSignal(props.node.height ?? 80);
  const [error, setError] = createSignal<string>();
  const serverOrigin = new URL(window.gapp.serverUrl).origin;
  const src = () =>
    `${window.gapp.serverUrl}/frame/${encodeURIComponent(app.appId)}/${encodeURIComponent(props.node.name)}?v=${hash(props.node.html)}`;

  const sendTheme = () => {
    const style = getComputedStyle(frame);
    const vars = Object.fromEntries(themeVars.map(([name, ref]) => [name, style.getPropertyValue(varName(ref)).trim()]));
    frame.contentWindow?.postMessage({ type: "gapp:theme", vars, scheme: style.colorScheme }, serverOrigin);
  };

  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data?.source !== "gapp-frame") return;
      if (e.data.type === "ready") {
        setError();
        sendTheme();
      } else if (e.data.type === "height" && !props.node.height) {
        setHeight(Math.min(Math.max(e.data.height, 24), 4000));
      } else if (e.data.type === "error") {
        setError(String(e.data.message).split("\n")[0]);
      }
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });

  // Follow theme changes (global settings, OS dark mode, the app's own theme).
  createEffect(on([settings, systemDark, () => app.spec().theme], () => queueMicrotask(sendTheme), { defer: true }));

  return (
    <div {...stylex.attrs(s.root)} data-custom-component={props.node.name}>
      <iframe
        ref={frame}
        src={src()}
        title={props.node.name}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        {...stylex.attrs(s.frame)}
        style={{ height: `${props.node.height ?? height()}px` }}
      />
      <Show when={error()}>
        <p {...stylex.attrs(s.error)} data-render-error>
          {props.node.name}: {error()}
        </p>
      </Show>
    </div>
  );
}

const s = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 },
  frame: { display: "block", width: "100%", borderWidth: 0, backgroundColor: "transparent", colorScheme: "normal" },
  error: { margin: 0, fontSize: font.xs, color: colors.danger, fontFamily: font.mono },
});
