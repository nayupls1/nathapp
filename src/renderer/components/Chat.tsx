import * as stylex from "@stylexjs/stylex";
import { createEffect, For, Match, on, Show, Switch } from "solid-js";
import type { ChatMessage } from "../../shared/api";
import { sendPrompt, states, stopAgent } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Composer } from "./Composer";

export function Chat(props: { appId: string }) {
  const state = () => states[props.appId]!;
  let scroller!: HTMLDivElement;

  // Keep the newest message in view while the agent is talking.
  createEffect(
    on([() => state().messages.length, () => state().draft, () => props.appId], () => {
      queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );

  return (
    <aside {...stylex.attrs(styles.root)}>
      <div ref={scroller} {...stylex.attrs(styles.messages)}>
        <For each={state().messages}>{(m) => <Message message={m} />}</For>
        <Show when={state().running}>
          <Show when={state().draft} fallback={<p {...stylex.attrs(styles.working)}>Working…</p>}>
            <p {...stylex.attrs(styles.assistant)}>{state().draft}</p>
          </Show>
        </Show>
      </div>
      <div {...stylex.attrs(styles.composer)}>
        <Composer
          appId={props.appId}
          running={state().running}
          onSend={(prompt) => sendPrompt(props.appId, prompt)}
          onStop={() => stopAgent(props.appId)}
        />
      </div>
    </aside>
  );
}

function Message(props: { message: ChatMessage }) {
  return (
    <Switch>
      <Match when={props.message.role === "user"}>
        <p {...stylex.attrs(styles.user)}>{props.message.content}</p>
      </Match>
      <Match when={props.message.role === "assistant"}>
        <p {...stylex.attrs(styles.assistant)}>{props.message.content}</p>
      </Match>
      <Match when={props.message.role === "tool"}>
        <p {...stylex.attrs(styles.tool)}>✓ {props.message.content}</p>
      </Match>
      <Match when={props.message.role === "error"}>
        <p {...stylex.attrs(styles.errorMsg)}>{props.message.content}</p>
      </Match>
    </Switch>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.4 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.4 },
});

const bubble = {
  margin: 0,
  fontSize: font.md,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} as const;

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    width: 380,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
    backgroundColor: colors.bg,
    minHeight: 0,
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
  },
  composer: { padding: space.md, paddingTop: 0 },
  user: {
    ...bubble,
    alignSelf: "flex-end",
    maxWidth: "85%",
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
  },
  assistant: { ...bubble },
  tool: { ...bubble, fontSize: font.xs, color: colors.success },
  errorMsg: { ...bubble, fontSize: font.sm, color: colors.danger },
  working: {
    ...bubble,
    fontSize: font.sm,
    color: colors.muted,
    animationName: pulse,
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
  },
});
