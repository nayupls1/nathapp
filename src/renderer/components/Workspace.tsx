// The content area for the selected app: a prompt for new apps, otherwise the
// rendered app next to the agent chat.
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import { sendPrompt, states, stopAgent } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { AppView } from "./AppView";
import { Chat } from "./Chat";
import { Composer } from "./Composer";

const examples = [
  "A habit tracker with daily check-ins and a streak count",
  "Track my expenses by category with a monthly total",
  "A reading list with status (to read, reading, done) and ratings",
];

export function Workspace(props: { appId: string }) {
  const state = () => states[props.appId];
  const isNew = () => !state()?.spec && !state()?.messages.length;

  return (
    <Show when={state()?.loaded}>
      <Show when={!isNew()} fallback={<NewApp appId={props.appId} />}>
        <div {...stylex.attrs(styles.split)}>
          <main {...stylex.attrs(styles.app)}>
            <Show
              when={state()!.spec}
              fallback={<p {...stylex.attrs(styles.placeholder)}>{state()!.running ? "Building your app…" : "No app yet."}</p>}
            >
              {(spec) => <AppView appId={props.appId} spec={spec()} />}
            </Show>
          </main>
          <Chat appId={props.appId} />
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
  app: { flex: 1, overflowY: "auto", minWidth: 0 },
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
