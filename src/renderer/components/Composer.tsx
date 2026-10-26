import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, type JSX } from "solid-js";
import { addShare, refusal, removeShare, sharesOf, type ShareRef } from "../lib/sharing";
import { appById, apps, setAgentChoice, states } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { AgentPicker } from "./AgentPicker";
import { Icon } from "./Icon";
import { TabIcon } from "./TabIcon";
import { toast } from "./Toast";
import { Button } from "./ui";

export function Composer(props: {
  appId: string;
  running: boolean;
  placeholder?: string;
  autofocus?: boolean;
  large?: boolean;
  /** Shown above the text field (e.g. picked elements). */
  top?: JSX.Element;
  /** Extra buttons next to the agent picker. */
  tools?: JSX.Element;
  onSend: (prompt: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = createSignal("");
  let textarea!: HTMLTextAreaElement;

  // @name shares another tab of the workspace with the message (lib/sharing.ts).
  const [mention, setMention] = createSignal<{ start: number; query: string } | null>(null);
  const [active, setActive] = createSignal(0);
  const candidates = () => {
    const m = mention();
    const self = appById(props.appId);
    if (!m || !self) return [];
    const q = m.query.toLowerCase();
    return apps
      .filter((t) => t.workspaceId === self.workspaceId && t.id !== self.id && t.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.position - b.position)
      .slice(0, 8);
  };
  const findMention = () => {
    const caret = textarea.selectionStart ?? value().length;
    const match = /(^|\s)@([^\s@]{0,40})$/.exec(value().slice(0, caret));
    setMention(match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null);
    setActive(0);
  };
  const choose = (tabId: string) => {
    const m = mention();
    if (!m) return;
    const why = addShare(props.appId, { tabId });
    if (why) return void toast({ message: why, kind: "error" });
    const caret = m.start + 1 + m.query.length;
    setValue(value().slice(0, m.start) + value().slice(caret));
    setMention(null);
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(m.start, m.start);
      resize();
    });
  };
  const shareLabel = (ref: ShareRef) => `${appById(ref.tabId)?.name ?? "A closed tab"}${ref.messageId !== undefined ? " · reply" : ""}`;

  const resize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  };

  const send = () => {
    const prompt = value().trim();
    if (!prompt || props.running) return;
    props.onSend(prompt);
    setValue("");
    queueMicrotask(resize);
  };

  return (
    <div {...stylex.attrs(styles.root, props.large && styles.large)}>
      {props.top}
      <Show when={sharesOf(props.appId).length}>
        <div {...stylex.attrs(styles.shares)}>
          <For each={sharesOf(props.appId)}>
            {(ref) => (
              <span
                {...stylex.attrs(styles.share)}
                title={ref.messageId !== undefined ? "A reply of that tab's agent, sent with your message" : "Shared with your message: what the tab shows or can do"}
                data-share-chip={ref.tabId}
              >
                <Icon name={ref.messageId !== undefined ? "reply" : "at-sign"} size={12} />
                <span {...stylex.attrs(styles.shareLabel)}>{shareLabel(ref)}</span>
                <button type="button" title="Don't share" onClick={() => removeShare(props.appId, ref)} {...stylex.attrs(styles.shareRemove)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={mention() && candidates().length}>
        <div role="listbox" {...stylex.attrs(styles.mentions)} data-mentions>
          <div {...stylex.attrs(styles.mentionsTitle)}>Share a tab with your message</div>
          <For each={candidates()}>
            {(tab, i) => {
              const why = () => refusal(props.appId, tab.id);
              const isActive = () => i() === active();
              const isOff = () => why() !== null;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive()}
                  aria-disabled={isOff()}
                  title={why() ?? undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(tab.id)}
                  {...stylex.attrs(styles.mention, isActive() && styles.mentionActive, isOff() && styles.mentionOff)}
                  data-mention={tab.id}
                >
                  <TabIcon tab={tab} size={14} />
                  <span {...stylex.attrs(styles.shareLabel)}>{tab.name}</span>
                  <span {...stylex.attrs(styles.mentionKind)}>{why() ? "can't be shared here" : tab.kind === "web" ? "web page" : "app"}</span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <textarea
        ref={(el) => {
          textarea = el;
          if (props.autofocus) queueMicrotask(() => el.focus());
        }}
        rows={props.large ? 3 : 1}
        value={value()}
        placeholder={props.placeholder ?? "Ask for a change…"}
        onInput={(e) => {
          setValue(e.currentTarget.value);
          resize();
          findMention();
        }}
        onBlur={() => setMention(null)}
        onKeyDown={(e) => {
          const list = candidates();
          if (mention() && list.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
              e.preventDefault();
              choose(list[active()]!.id);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        {...stylex.attrs(styles.input, props.large && styles.inputLarge)}
      />
      <div {...stylex.attrs(styles.actions)}>
        <div {...stylex.attrs(styles.options)}>
          {props.tools}
          <Show when={states[props.appId]}>
            {(state) => <AgentPicker choice={state().agent} onChange={(choice) => setAgentChoice(props.appId, choice)} />}
          </Show>
        </div>
        <Show
          when={props.running}
          fallback={
            <Button variant="primary" disabled={!value().trim()} onClick={send}>
              Send
            </Button>
          }
        >
          <Button onClick={props.onStop}>Stop</Button>
        </Show>
      </div>
    </div>
  );
}

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.04)",
  },
  large: { padding: space.md },
  input: {
    width: "100%",
    minHeight: 32,
    maxHeight: 240,
    paddingBlock: 6,
    paddingInline: space.sm,
    borderStyle: "none",
    outline: "none",
    resize: "none",
    backgroundColor: "transparent",
    fontSize: font.md,
    lineHeight: 1.45,
    // One line in a narrow panel (e.g. in a split view), instead of a wrapped placeholder with a scrollbar.
    "::placeholder": { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  },
  inputLarge: { fontSize: font.lg, minHeight: 72 },
  actions: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  shares: { display: "flex", flexWrap: "wrap", gap: 4, paddingInline: 4, paddingTop: 2 },
  share: {
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
  shareLabel: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220, minWidth: 0 },
  shareRemove: {
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
  mentions: {
    position: "absolute",
    left: space.sm,
    right: space.sm,
    bottom: "calc(100% + 6px)",
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14)",
  },
  mentionsTitle: { paddingBlock: 4, paddingInline: space.sm, color: colors.muted, fontSize: font.xs, fontWeight: 600 },
  mention: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 30,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
  },
  mentionActive: { backgroundColor: { default: colors.surfaceHover, ":hover": colors.surfaceHover } },
  mentionOff: { opacity: 0.5 },
  mentionKind: { marginLeft: "auto", flexShrink: 0, color: colors.muted, fontSize: font.xs },
  // Clipped rather than running under Send in a narrow panel.
  options: { display: "flex", alignItems: "center", gap: 2, minWidth: 0, overflow: "hidden" },
});
