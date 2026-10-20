import * as stylex from "@stylexjs/stylex";
import { createEffect, For, Match, on, Show, Switch } from "solid-js";
import type { ChatMessage } from "../../shared/api";
import { sendPrompt, setAgentCollapsed, states, stopAgent } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Composer } from "./Composer";
import { Icon } from "./Icon";

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
    <aside {...stylex.attrs(styles.root)} data-agent-panel>
      <header {...stylex.attrs(styles.header)}>
        <Icon name="bot" size={16} {...stylex.attrs(styles.headerIcon)} />
        <span {...stylex.attrs(styles.headerTitle)}>Agent</span>
        <button
          type="button"
          title="Hide agent (Ctrl+J)"
          onClick={() => setAgentCollapsed(props.appId, true)}
          {...stylex.attrs(styles.headerButton)}
          data-agent-hide
        >
          <Icon name="panel-right-close" size={16} />
        </button>
      </header>
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
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 44,
    flexShrink: 0,
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  headerIcon: { color: colors.accent },
  headerTitle: { flex: 1, fontSize: font.sm, fontWeight: 600 },
  headerButton: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  showButton: {
    position: "absolute",
    top: space.md,
    right: space.md,
    zIndex: 10,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.08)",
    color: colors.text,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  showDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
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

/** Floating button that brings a hidden agent panel back. */
export function ShowAgentButton(props: { appId: string }) {
  const running = () => !!states[props.appId]?.running;
  return (
    <button
      type="button"
      title="Show agent (Ctrl+J)"
      onClick={() => setAgentCollapsed(props.appId, false)}
      {...stylex.attrs(styles.showButton)}
      data-agent-show
    >
      <Icon name="bot" size={16} />
      Agent
      <Show when={running()}>
        <span {...stylex.attrs(styles.showDot)} />
      </Show>
    </button>
  );
}
