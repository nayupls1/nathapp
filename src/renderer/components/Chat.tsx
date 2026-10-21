import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js";
import type { ChatMessage } from "../../shared/api";
import { settings } from "../lib/settings";
import { sendPrompt, setAgentCollapsed, states, stopAgent } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { BackendDrawer, BackendPill, useRuntime } from "./BackendPanel";
import { Composer } from "./Composer";
import { Icon } from "./Icon";

export function Chat(props: {
  appId: string;
  /** Web tabs: the website agent, with picked elements above the composer. */
  web?: { top: JSX.Element; tools: JSX.Element; onSend: (prompt: string) => void };
}) {
  const state = () => states[props.appId]!;
  const runtime = useRuntime(() => (props.web ? null : props.appId));
  const [backendOpen, setBackendOpen] = createSignal(false);
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
        <span {...stylex.attrs(styles.headerTitle)}>{props.web ? "Website agent" : "Agent"}</span>
        <BackendPill appId={props.appId} runtime={runtime()} open={backendOpen()} onToggle={() => setBackendOpen((o) => !o)} />
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
      <Show when={backendOpen() && runtime()?.status.exists && runtime()}>
        {(info) => <BackendDrawer appId={props.appId} runtime={info()} />}
      </Show>
      <div ref={scroller} {...stylex.attrs(styles.messages)}>
        <Show when={props.web && !state().messages.length && !state().running}>
          <p {...stylex.attrs(styles.hint)}>
            Ask about this page, or pick elements with the crosshair and say how they should look or work. Changes are saved
            as customizations for the site.
          </p>
        </Show>
        <For each={state().messages.filter((m) => m.role !== "tool" || settings().agent.showToolMessages)}>
          {(m) => <Message message={m} />}
        </For>
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
          placeholder={props.web ? "Ask about or change this page…" : undefined}
          top={props.web?.top}
          tools={props.web?.tools}
          onSend={(prompt) => (props.web ? props.web.onSend(prompt) : sendPrompt(props.appId, prompt))}
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
      <Match when={props.message.role === "context"}>
        <PickedContext content={props.message.content} />
      </Match>
    </Switch>
  );
}

/** The elements the user picked with a message (stored as JSON). */
function PickedContext(props: { content: string }) {
  const picked = () => {
    try {
      return (JSON.parse(props.content) as { selection: { selector: string; tag: string; text: string }[] }).selection;
    } catch {
      return [];
    }
  };
  return (
    <div {...stylex.attrs(styles.context)}>
      <For each={picked()}>
        {(el) => (
          <span {...stylex.attrs(styles.chip)} title={el.selector}>
            <Icon name="crosshair" size={12} />
            {el.text ? `${el.tag} “${el.text.slice(0, 30)}${el.text.length > 30 ? "…" : ""}”` : el.selector}
          </span>
        )}
      </For>
    </div>
  );
}

/** A picked element shown as a removable chip. */
export function Chip(props: { label: string; title?: string; onRemove?: () => void }) {
  return (
    <span {...stylex.attrs(styles.chip)} title={props.title} data-picked-chip>
      <Icon name="crosshair" size={12} />
      <span {...stylex.attrs(styles.chipLabel)}>{props.label}</span>
      <Show when={props.onRemove}>
        <button type="button" title="Remove" onClick={() => props.onRemove!()} {...stylex.attrs(styles.chipRemove)}>
          <Icon name="x" size={12} />
        </button>
      </Show>
    </span>
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
  hint: { ...bubble, fontSize: font.sm, color: colors.muted },
  context: { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 4, marginBottom: -8 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    height: 22,
    paddingInline: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.text,
    fontSize: font.xs,
    whiteSpace: "nowrap",
  },
  chipLabel: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 },
  chipRemove: {
    display: "grid",
    placeItems: "center",
    width: 16,
    height: 16,
    marginRight: -3,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
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
