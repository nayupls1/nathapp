import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import type { ChatMessage } from "../../shared/api";
import { markdownToHtml } from "../../shared/markdown";
import { isPicking, picksOf } from "../lib/picks";
import { settings } from "../lib/settings";
import { handOver, refusal, sendWithShares } from "../lib/sharing";
import { appById, apps, setAgentCollapsed, states, stopAgent } from "../lib/store";
import { pageOf, pagesVersion } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { Composer } from "./Composer";
import { SecretRequestCard } from "./Secrets";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { toast } from "./Toast";

/**
 * The agent of a tab: its conversation and composer, in the agent sidebar
 * (AgentSidebar). Works the same for every kind of tab: the elements picked
 * in the tab's page (lib/picks.ts) come with the message, and the tab's page
 * handle sends it with the page.
 */
export function Chat(props: { appId: string }) {
  const state = () => states[props.appId]!;
  const tab = () => appById(props.appId);
  const web = () => tab()?.kind === "web";
  // The tab's page (a web page or an app's preview), once it's registered.
  const page = () => (pagesVersion(), pageOf(props.appId));
  let scroller!: HTMLDivElement;

  // Keep the newest message in view while the agent is talking.
  createEffect(
    on([() => state().messages.length, () => state().draft, () => props.appId], () => {
      queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );

  return (
    <aside {...stylex.attrs(styles.root)} data-agent-panel>
      <header {...stylex.attrs(styles.header)} data-titlebar>
        <Icon name="bot" size={16} {...stylex.attrs(styles.headerIcon)} />
        <span {...stylex.attrs(styles.headerTitle)}>Agent</span>
        <span {...stylex.attrs(styles.headerTab)} title="The tab the agent works on" data-agent-tab-name>
          {tab()?.name ?? ""}
        </span>
        <button
          type="button"
          title={editsApp(props.appId) ? "Done: hide the agent and run the finished app (Ctrl+J)" : "Hide agent (Ctrl+J)"}
          onClick={() => setAgentCollapsed(props.appId, true)}
          {...stylex.attrs(styles.headerButton)}
          data-agent-hide
        >
          <Icon name="panel-right-close" size={16} />
        </button>
      </header>
      <div ref={scroller} {...stylex.attrs(styles.messages)}>
        <Show when={web() && !state().messages.length && !state().running}>
          <p {...stylex.attrs(styles.hint)}>
            Ask about this page, or pick elements with the crosshair and say how they should look or work. Changes are saved
            as customizations for the site.
          </p>
        </Show>
        <For each={state().messages.filter((m) => m.role !== "tool" || settings().agent.showToolMessages)}>
          {(m) => <Message appId={props.appId} message={m} />}
        </For>
        <Show when={state().running}>
          <Show when={state().draft} fallback={<p {...stylex.attrs(styles.working)}>Working…</p>}>
            <Markdown text={state().draft} />
          </Show>
        </Show>
      </div>
      <div {...stylex.attrs(styles.composer)}>
        <Composer
          appId={props.appId}
          running={state().running}
          placeholder={web() ? "Ask about or change this page…" : state().project ? undefined : "Describe the app you want…"}
          top={
            <Show when={picksOf(props.appId).length}>
              <div {...stylex.attrs(styles.chips)}>
                <For each={picksOf(props.appId)}>
                  {(el) => (
                    <Chip
                      label={el.text ? `${el.tag} “${el.text.slice(0, 24)}${el.text.length > 24 ? "…" : ""}”` : el.selector}
                      title={el.selector}
                      onRemove={() => page()?.unpick(el.selector)}
                    />
                  )}
                </For>
              </div>
            </Show>
          }
          tools={
            <Show when={page()}>
              <button
                type="button"
                title={isPicking(props.appId) ? "Cancel picking (Esc)" : web() ? "Pick elements on the page for the agent" : "Pick elements in the app for the agent"}
                onClick={() => void page()?.pick()}
                {...stylex.attrs(styles.pick, isPicking(props.appId) && styles.pickOn)}
                data-pick-element
              >
                <Icon name="crosshair" size={15} />
              </button>
            </Show>
          }
          onSend={(prompt) => {
            const handle = page();
            if (handle) handle.send(prompt);
            else void sendWithShares(props.appId, prompt);
          }}
          onStop={() => stopAgent(props.appId)}
        />
      </div>
    </aside>
  );
}

function Message(props: { appId: string; message: ChatMessage }) {
  return (
    <Switch>
      <Match when={props.message.role === "user"}>
        <p {...stylex.attrs(styles.user)}>{props.message.content}</p>
      </Match>
      <Match when={props.message.role === "assistant"}>
        <Reply appId={props.appId} message={props.message} />
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
      <Match when={props.message.role === "secret"}>
        <SecretRequestCard appId={props.appId} content={props.message.content} />
      </Match>
    </Switch>
  );
}

/** An agent's reply, with "Send to…": hands it over to another tab's agent (lib/sharing.ts). */
function Reply(props: { appId: string; message: ChatMessage }) {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const targets = (): MenuItem[] => {
    const self = appById(props.appId);
    if (!self) return [];
    return apps
      .filter((t) => t.workspaceId === self.workspaceId && t.id !== self.id)
      .sort((a, b) => a.position - b.position)
      .map((t) => {
        // Asked the other way round: may this tab's reply go to t?
        const why = refusal(t.id, self.id);
        return {
          label: why ? `${t.name} (not for app builders)` : t.name,
          icon: t.kind === "web" ? "globe" : "app-window",
          disabled: !!why,
          onSelect: () =>
            void handOver(self.id, props.message.id, t.id).then((err) => err && toast({ message: err, kind: "error" })),
        };
      });
  };
  return (
    <div {...stylex.attrs(stylex.defaultMarker(), styles.reply)} data-reply={props.message.id}>
      <Markdown text={props.message.content} />
      <Show when={props.message.id > 0}>
        <button
          type="button"
          title="Send this reply to another tab's agent"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu() ? undefined : { x: r.left, y: r.bottom + 4 });
          }}
          {...stylex.attrs(styles.handOver)}
          data-hand-over
        >
          <Icon name="forward" size={13} />
          Send to…
        </button>
      </Show>
      <Show when={menu()}>
        {(position) => (
          <ContextMenu
            items={targets().length ? targets() : [{ label: "No other tabs here", disabled: true, onSelect: () => {} }]}
            position={position()}
            onClose={() => setMenu()}
          />
        )}
      </Show>
    </div>
  );
}

/** Assistant text (Markdown; escaped, so it can't inject markup). Links open as web tabs. */
function Markdown(props: { text: string }) {
  return (
    <div {...stylex.attrs(styles.assistant, styles.markdown)}>
      <div class="nathapp-markdown" innerHTML={markdownToHtml(props.text)} />
    </div>
  );
}

/** What came with a message (stored as JSON): the elements the user picked, or the tabs they shared. */
function PickedContext(props: { content: string }) {
  const parsed = () => {
    try {
      return JSON.parse(props.content) as {
        selection?: { selector: string; tag: string; text: string }[];
        shared?: { tabId: string; name: string; kind: string; what: string }[];
      };
    } catch {
      return {};
    }
  };
  const picked = () => parsed().selection ?? [];
  return (
    <div {...stylex.attrs(styles.context)}>
      <For each={parsed().shared ?? []}>
        {(tab) => (
          <span {...stylex.attrs(styles.chip)} title={tab.what === "reply" ? "A reply of its agent" : tab.kind === "web" ? "What the page showed" : "What the app can do and how its data is laid out"} data-shared-context>
            <Icon name={tab.what === "reply" ? "reply" : "at-sign"} size={12} />
            {tab.name}
          </span>
        )}
      </For>
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
  // The agent sidebar sizes it.
  root: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, backgroundColor: colors.bg },
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
  headerTitle: { flexShrink: 0, fontSize: font.sm, fontWeight: 600 },
  headerTab: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.muted, fontSize: font.sm },
  chips: { display: "flex", flexWrap: "wrap", gap: 4, paddingInline: 4, paddingTop: 2 },
  pick: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  pickOn: { backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft }, color: { default: colors.accent, ":hover": colors.accent } },
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
  markdown: { whiteSpace: "normal" },
  tool: { ...bubble, fontSize: font.xs, color: colors.success },
  errorMsg: { ...bubble, fontSize: font.sm, color: colors.danger },
  hint: { ...bubble, fontSize: font.sm, color: colors.muted },
  reply: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 },
  handOver: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 22,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.xs,
    cursor: "pointer",
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, ":focus-visible": 1 },
  },
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

/** Whether the agent panel stands for editing an app (its mode follows the panel). */
const editsApp = (id: string) => appById(id)?.kind === "app" && !!states[id]?.project;

/** Floating button that brings a hidden agent panel back (for an app: back to editing). */
export function ShowAgentButton(props: { appId: string }) {
  const running = () => !!states[props.appId]?.running;
  return (
    <button
      type="button"
      title={editsApp(props.appId) ? "Edit: show the agent and run the dev server (Ctrl+J)" : "Show agent (Ctrl+J)"}
      onClick={() => setAgentCollapsed(props.appId, false)}
      {...stylex.attrs(styles.showButton)}
      data-agent-show
    >
      <Icon name={editsApp(props.appId) ? "pencil" : "bot"} size={16} />
      {editsApp(props.appId) ? "Edit" : "Agent"}
      <Show when={running()}>
        <span {...stylex.attrs(styles.showDot)} />
      </Show>
    </button>
  );
}
