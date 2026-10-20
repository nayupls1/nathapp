// The content area for the selected app: a prompt for new apps, otherwise the
// rendered app next to the agent chat.
import * as stylex from "@stylexjs/stylex";
import { For, onCleanup, onMount, Show } from "solid-js";
import { settings } from "../lib/settings";
import { isAgentCollapsed, sendPrompt, states, stopAgent, toggleAgent } from "../lib/store";
import { appThemeVars, systemDark } from "../lib/theme";
import { colors, font, radius, space } from "../theme.stylex";
import { AppView } from "./AppView";
import { Chat, ShowAgentButton } from "./Chat";
import { Composer } from "./Composer";

const examples = [
  "A habit tracker with daily check-ins and a streak count",
  "Track my expenses by category with a monthly total",
  "A reading list with status (to read, reading, done) and ratings",
];

/** Ctrl/Cmd+J toggles the agent panel of the given tab. */
export function useAgentShortcut(appId: () => string) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleAgent(appId());
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
}

export function Workspace(props: { appId: string }) {
  const state = () => states[props.appId];
  const isNew = () => !state()?.spec && !state()?.messages.length;
  const collapsed = () => isAgentCollapsed(props.appId);
  useAgentShortcut(() => props.appId);
  // The app's own theme (if the agent gave it one) applies to the app area only.
  const appTheme = () =>
    settings().appThemes ? appThemeVars(state()?.spec?.theme, settings().theme, systemDark()) : {};

  return (
    <Show when={state()?.loaded}>
      <Show when={!isNew()} fallback={<NewApp appId={props.appId} />}>
        <div {...stylex.attrs(styles.split)}>
          <main {...stylex.attrs(styles.app)} style={appTheme()} data-app-area>
            <div {...stylex.attrs(styles.appScroll)}>
              <Show
                when={state()!.spec}
                fallback={<p {...stylex.attrs(styles.placeholder)}>{state()!.running ? "Building your app…" : "No app yet."}</p>}
              >
                {(spec) => <AppView appId={props.appId} spec={spec()} />}
              </Show>
            </div>
            <Show when={collapsed()}>
              <ShowAgentButton appId={props.appId} />
            </Show>
          </main>
          <Show when={!collapsed()}>
            <Chat appId={props.appId} />
          </Show>
        </div>
      </Show>
    </Show>
  );
}

function NewApp(props: { appId: string }) {
  const send = (prompt: string) => sendPrompt(props.appId, prompt);
  return (
    <div {...stylex.attrs(styles.newRoot)}>
      <div {...stylex.attrs(styles.newInner)}>
        <h1 {...stylex.attrs(styles.title)}>What do you want to build?</h1>
        <p {...stylex.attrs(styles.subtitle)}>Describe an app and the agent will build it. You can keep refining it afterwards.</p>
        <Composer
          appId={props.appId}
          large
          autofocus
          running={!!states[props.appId]?.running}
          placeholder="e.g. A simple CRM for tracking leads and follow-ups"
          onSend={send}
          onStop={() => stopAgent(props.appId)}
        />
        <div {...stylex.attrs(styles.examples)}>
          <For each={examples}>
            {(example) => (
              <button type="button" onClick={() => send(example)} {...stylex.attrs(styles.example)}>
                {example}
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

const styles = stylex.create({
  split: { display: "flex", height: "100%", minHeight: 0 },
  app: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.sans,
  },
  appScroll: { flex: 1, minHeight: 0, overflowY: "auto" },
  placeholder: { margin: 0, padding: space.xxl, textAlign: "center", color: colors.muted },
  newRoot: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: space.xl,
    overflowY: "auto",
  },
  newInner: { width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", gap: space.lg },
  title: { margin: 0, fontSize: 28, fontWeight: 650, letterSpacing: "-0.02em" },
  subtitle: { margin: 0, marginTop: -8, color: colors.muted, fontSize: font.md },
  examples: { display: "flex", flexWrap: "wrap", gap: space.sm },
  example: {
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
});
