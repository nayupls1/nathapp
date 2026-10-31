// The conversation of a tab's agent, as a timeline: your messages, its
// replies, its tool calls (consecutive ones grouped and summed up, "Ran 2
// commands, edited 3 files"), and where each turn ended ("Worked for 42s").
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import {
  parseToolActivity,
  type Attachment,
  type ChatMessage,
  type ToolActivity,
  type ToolKind,
} from "../../shared/api";
import { markdownToHtml } from "../../shared/markdown";
import { attachmentUrl } from "../lib/attachments";
import { buildRows, formatElapsed, summarize, type Row, type WorkEntry } from "../lib/timeline";
import { settings } from "../lib/settings";
import { handOver, refusal } from "../lib/sharing";
import { appById, apps, states } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { SecretRequestCard } from "./Secrets";
import { toast } from "./Toast";

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fullTimeOf = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const kindIcons: Record<ToolKind, string> = {
  read: "eye",
  edit: "square-pen",
  create: "file-plus",
  command: "terminal",
  search: "search",
  web: "globe",
  page: "scan-eye",
  browse: "mouse-pointer-click",
  screenshot: "camera",
  inspect: "scan-search",
  code: "code-xml",
  performance: "gauge",
  network: "network",
  plan: "list-todo",
  agent: "bot",
  app: "app-window",
  customize: "paintbrush",
  schedule: "calendar-clock",
  snapshot: "history",
  secret: "key-round",
  source: "folder-git-2",
  tab: "layers",
  other: "wrench",
};

/** A title with its `code` spans set in monospace. */
function InlineCode(props: { text: string }) {
  const parts = () => props.text.split(/`([^`]+)`/);
  return (
    <For each={parts()}>
      {(part, i) => (
        <Show when={i() % 2} fallback={part}>
          <code {...stylex.attrs(styles.inlineCode)}>{part}</code>
        </Show>
      )}
    </For>
  );
}

// --- The timeline ---------------------------------------------------------------------------

export function Timeline(props: { appId: string }) {
  const state = () => states[props.appId]!;
  const rows = createMemo(() => buildRows(state().messages, state().running, settings().agent.showToolMessages));
  const lastIndex = () => rows().length - 1;
  return (
    <>
      <Index each={rows()}>
        {(row, i) => {
          // The tool calls the agent is making right now.
          const live = () => state().running && i === lastIndex() && !state().draft;
          return (
            <Switch>
              <Match when={row().type === "work" && (row() as Extract<Row, { type: "work" }>)}>
                {(work) => <WorkGroup entries={work().entries} live={live()} />}
              </Match>
              <Match when={row().type === "turn-end" && (row() as Extract<Row, { type: "turn-end" }>)}>
                {(end) => <TurnEnd ms={end().ms} stopped={end().stopped} />}
              </Match>
              <Match when={row().type === "message" && (row() as Extract<Row, { type: "message" }>)}>
                {(m) => <Message appId={props.appId} message={m().message} />}
              </Match>
            </Switch>
          );
        }}
      </Index>
      <Show when={state().running}>
        <Show when={state().draft}>
          <div {...stylex.attrs(styles.assistantRow)}>
            <Markdown text={state().draft} />
          </div>
        </Show>
        <Working since={turnStartOf(state().messages)} />
      </Show>
    </>
  );
}

/** When the current turn started: its `user` message (now if it isn't there yet). */
const turnStartOf = (messages: readonly ChatMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return messages[i]!.createdAt;
  return new Date().toISOString();
};

/** A ticking clock while `live`. */
function useNow(live: () => boolean) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!live()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}

/** The agent is at it: "Working… 12s". */
function Working(props: { since: string }) {
  const now = useNow(() => true);
  return (
    <div {...stylex.attrs(styles.working)} role="status" data-agent-working>
      <span {...stylex.attrs(styles.workingDots)} aria-hidden="true">
        <span {...stylex.attrs(styles.dot)} />
        <span {...stylex.attrs(styles.dot, styles.dot2)} />
        <span {...stylex.attrs(styles.dot, styles.dot3)} />
      </span>
      <span {...stylex.attrs(styles.workingLabel)}>Working…</span>
      <span {...stylex.attrs(styles.workingTime)}>{formatElapsed(now() - Date.parse(props.since))}</span>
    </div>
  );
}

/** Where a turn ended: "Worked for 42s", or "Stopped after 12s". */
function TurnEnd(props: { ms: number; stopped: boolean }) {
  const stopped = () => props.stopped;
  return (
    <div {...stylex.attrs(styles.divider, stopped() && styles.dividerStopped)} data-turn-end>
      <span {...stylex.attrs(styles.dividerLine)} />
      <span {...stylex.attrs(styles.dividerLabel)}>
        <Icon name={props.stopped ? "square" : "check"} size={12} />
        {props.stopped ? `Stopped after ${formatElapsed(props.ms)}` : `Worked for ${formatElapsed(props.ms)}`}
      </span>
      <span {...stylex.attrs(styles.dividerLine)} />
    </div>
  );
}

// --- Tool calls -------------------------------------------------------------------------------

/** Consecutive tool calls: one row, or a summary that opens to all of them (open while they're happening). */
function WorkGroup(props: { entries: WorkEntry[]; live: boolean }) {
  const [open, setOpen] = createSignal<boolean>();
  const expanded = () => open() ?? props.live;
  const failed = () => props.entries.filter((e) => e.activity.failed).length;
  const icon = () => {
    const kinds = new Set(props.entries.map((e) => e.activity.kind));
    return kinds.size === 1 ? kindIcons[props.entries[0]!.activity.kind] : "layers";
  };
  const single = () => props.entries.length === 1;
  return (
    <Show when={!single()} fallback={<WorkRow activity={props.entries[0]!.activity} />}>
      <section {...stylex.attrs(styles.group)} aria-label="Tool calls" data-tool-group>
        <button
          type="button"
          aria-expanded={expanded()}
          onClick={() => setOpen(!expanded())}
          {...stylex.attrs(styles.row, styles.rowButton)}
          data-tool-group-toggle
        >
          <span {...stylex.attrs(styles.rowIcon)}>
            <Icon name={icon()} size={14} />
          </span>
          <span {...stylex.attrs(styles.rowTitle)}>{summarize(props.entries)}</span>
          <Show when={failed()}>
            <span {...stylex.attrs(styles.failedBadge)}>{failed()} failed</span>
          </Show>
          <span {...stylex.attrs(styles.chevron, expanded() && styles.chevronOpen)}>
            <Icon name="chevron-right" size={14} />
          </span>
        </button>
        <Show when={expanded()}>
          <div {...stylex.attrs(styles.groupEntries)}>
            <For each={props.entries}>{(entry) => <WorkRow activity={entry.activity} />}</For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

/** One tool call: its icon and line; opens to its detail (the whole command, the arguments). */
function WorkRow(props: { activity: ToolActivity }) {
  const [open, setOpen] = createSignal(false);
  const failed = () => !!props.activity.failed;
  const hasDetail = () => !!props.activity.detail;
  return (
    <div {...stylex.attrs(styles.entry)} data-tool-call={props.activity.kind}>
      <button
        type="button"
        disabled={!hasDetail()}
        aria-expanded={hasDetail() ? open() : undefined}
        title={props.activity.title}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(stylex.defaultMarker(), styles.row, hasDetail() && styles.rowButton)}
      >
        <span {...stylex.attrs(styles.rowIcon, failed() && styles.rowIconFailed)}>
          <Icon name={failed() ? "circle-alert" : kindIcons[props.activity.kind]} size={14} />
        </span>
        <span {...stylex.attrs(styles.rowTitle)}>
          <InlineCode text={props.activity.title} />
        </span>
        <Show when={failed()}>
          <span {...stylex.attrs(styles.failedBadge)}>failed</span>
        </Show>
        <Show when={hasDetail()}>
          <span {...stylex.attrs(styles.chevron, styles.chevronHover, open() && styles.chevronOpen)}>
            <Icon name="chevron-right" size={14} />
          </span>
        </Show>
      </button>
      <Show when={open() && props.activity.detail}>
        {(detail) => <pre {...stylex.attrs(styles.detail)}>{detail()}</pre>}
      </Show>
    </div>
  );
}

// --- Messages -------------------------------------------------------------------------------

function Message(props: { appId: string; message: ChatMessage }) {
  return (
    <Switch>
      <Match when={props.message.role === "user"}>
        <UserMessage message={props.message} />
      </Match>
      <Match when={props.message.role === "assistant"}>
        <Reply appId={props.appId} message={props.message} />
      </Match>
      <Match when={props.message.role === "error"}>
        <div {...stylex.attrs(styles.error)} role="alert" data-chat-error>
          <Icon name="circle-alert" size={15} />
          <span {...stylex.attrs(styles.errorText)}>{props.message.content}</span>
        </div>
      </Match>
      <Match when={props.message.role === "context"}>
        <PickedContext content={props.message.content} />
      </Match>
      <Match when={props.message.role === "attachments"}>
        <SentAttachments appId={props.appId} content={props.message.content} />
      </Match>
      <Match when={props.message.role === "secret"}>
        <SecretRequestCard appId={props.appId} content={props.message.content} />
      </Match>
    </Switch>
  );
}

/** Copies `text`; shows a check for a moment. */
function CopyButton(props: { text: () => string; label: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return (
    <button
      type="button"
      title={copied() ? "Copied" : props.label}
      aria-label={props.label}
      onClick={() =>
        void navigator.clipboard.writeText(props.text()).then(() => {
          setCopied(true);
          clearTimeout(timer);
          timer = setTimeout(() => setCopied(false), 1500);
        })
      }
      {...stylex.attrs(styles.action, copied() && styles.actionDone)}
      data-copy-message
    >
      <Icon name={copied() ? "check" : "copy"} size={13} />
    </button>
  );
}

/** Your message: a bubble on the right; long ones are folded. */
function UserMessage(props: { message: ChatMessage }) {
  const [unfolded, setUnfolded] = createSignal(false);
  const [long, setLong] = createSignal(false);
  let body!: HTMLParagraphElement;
  // Folded beyond 12 lines (the fold's max height).
  onMount(() =>
    requestAnimationFrame(() => setLong(body.scrollHeight > parseFloat(getComputedStyle(body).lineHeight) * 12 + 4)),
  );
  const folded = () => long() && !unfolded();
  return (
    <div {...stylex.attrs(stylex.defaultMarker(), styles.userRow)} data-user-message>
      <div {...stylex.attrs(styles.user)}>
        <p ref={body} {...stylex.attrs(styles.userText, folded() && styles.userFolded)}>
          {props.message.content}
        </p>
        <Show when={long()}>
          <button type="button" onClick={() => setUnfolded(!unfolded())} {...stylex.attrs(styles.unfold)}>
            {unfolded() ? "Show less" : "Show more"}
          </button>
        </Show>
      </div>
      <div {...stylex.attrs(styles.actions, styles.actionsUser)}>
        <span {...stylex.attrs(styles.time)} title={fullTimeOf(props.message.createdAt)}>
          {timeOf(props.message.createdAt)}
        </span>
        <CopyButton text={() => props.message.content} label="Copy message" />
      </div>
    </div>
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
  const saved = () => props.message.id > 0;
  return (
    <div {...stylex.attrs(stylex.defaultMarker(), styles.assistantRow)} data-reply={props.message.id}>
      <Markdown text={props.message.content} />
      <div {...stylex.attrs(styles.actions, styles.actionsStart)}>
        <CopyButton text={() => props.message.content} label="Copy reply" />
        <Show when={saved()}>
          <button
            type="button"
            title="Send this reply to another tab's agent"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu(menu() ? undefined : { x: r.left, y: r.bottom + 4 });
            }}
            {...stylex.attrs(styles.action, styles.actionLabelled)}
            data-hand-over
          >
            <Icon name="forward" size={13} />
            Send to…
          </button>
        </Show>
        <span {...stylex.attrs(styles.time)} title={fullTimeOf(props.message.createdAt)}>
          {timeOf(props.message.createdAt)}
        </span>
      </div>
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

/** Assistant text (Markdown; escaped, so it can't inject markup). Links open as web tabs; code blocks get a copy button. */
export function Markdown(props: { text: string }) {
  let root!: HTMLDivElement;
  createEffect(() => {
    root.innerHTML = markdownToHtml(props.text);
    for (const pre of root.querySelectorAll("pre")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rune-copy-code";
      button.textContent = "Copy";
      button.addEventListener("click", () => {
        void navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "").then(() => {
          button.textContent = "Copied";
          setTimeout(() => (button.textContent = "Copy"), 1500);
        });
      });
      pre.append(button);
    }
  });
  return (
    <div {...stylex.attrs(styles.markdown)}>
      <div ref={root} class="rune-markdown" />
    </div>
  );
}

/** Files sent with the next message: images as thumbnails, others by name. */
function SentAttachments(props: { appId: string; content: string }) {
  const files = () => {
    try {
      return JSON.parse(props.content) as Attachment[];
    } catch {
      return [];
    }
  };
  return (
    <div {...stylex.attrs(styles.sentFiles)} data-sent-attachments>
      <For each={files()}>
        {(file) => (
          <Show
            when={file.mime.startsWith("image/")}
            fallback={
              <span {...stylex.attrs(styles.sentFile)} title={file.name}>
                <Icon name="file-text" size={14} />
                <span {...stylex.attrs(styles.chipLabel)}>{file.name}</span>
              </span>
            }
          >
            <img
              src={attachmentUrl(props.appId, file.id)}
              alt={file.name}
              title={file.name}
              {...stylex.attrs(styles.sentImage)}
            />
          </Show>
        )}
      </For>
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
          <span
            {...stylex.attrs(styles.chip)}
            title={
              tab.what === "reply"
                ? "A reply of its agent"
                : tab.kind === "web"
                  ? "What the page showed"
                  : "What the app can do and how its data is laid out"
            }
            data-shared-context
          >
            <Icon name={tab.what === "reply" ? "reply" : "at-sign"} size={12} />
            <span {...stylex.attrs(styles.chipLabel)}>{tab.name}</span>
          </span>
        )}
      </For>
      <For each={picked()}>
        {(el) => (
          <span {...stylex.attrs(styles.chip)} title={el.selector}>
            <Icon name="crosshair" size={12} />
            <span {...stylex.attrs(styles.chipLabel)}>
              {el.text ? `${el.tag} “${el.text.slice(0, 30)}${el.text.length > 30 ? "…" : ""}”` : el.selector}
            </span>
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

// --- Styles -------------------------------------------------------------------------------

const bounce = stylex.keyframes({
  "0%": { opacity: 0.25, transform: "translateY(0)" },
  "40%": { opacity: 1, transform: "translateY(-2px)" },
  "80%": { opacity: 0.25, transform: "translateY(0)" },
  "100%": { opacity: 0.25, transform: "translateY(0)" },
});

const styles = stylex.create({
  inlineCode: {
    fontFamily: font.mono,
    fontSize: "0.92em",
    color: colors.text,
  },
  // Tool calls.
  group: { display: "flex", flexDirection: "column", minWidth: 0 },
  groupEntries: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    marginLeft: 9,
    paddingLeft: 8,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
  },
  entry: { display: "flex", flexDirection: "column", minWidth: 0 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    minWidth: 0,
    minHeight: 26,
    paddingBlock: 2,
    paddingInline: 2,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.muted,
    fontFamily: "inherit",
    fontSize: font.sm,
    lineHeight: 1.4,
    textAlign: "left",
    cursor: "default",
  },
  rowButton: {
    cursor: "pointer",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
  },
  rowIcon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 18,
    height: 18,
    opacity: 0.85,
  },
  rowIconFailed: { color: colors.danger, opacity: 1 },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    color: colors.muted,
    transition: "transform 150ms, opacity 150ms",
  },
  chevronHover: { opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1 } },
  chevronOpen: { transform: "rotate(90deg)", opacity: 1 },
  failedBadge: {
    flexShrink: 0,
    paddingBlock: 1,
    paddingInline: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "color-mix(in oklab, transparent, #dc2626 30%)",
    backgroundColor: "color-mix(in oklab, transparent, #dc2626 8%)",
    color: colors.danger,
    fontSize: 11,
    fontWeight: 500,
  },
  detail: {
    margin: 0,
    marginLeft: 26,
    marginBlock: 4,
    maxHeight: 260,
    overflow: "auto",
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.sm,
    backgroundColor: "rgb(127 127 127 / 0.08)",
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    userSelect: "text",
  },
  // The end of a turn.
  divider: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    paddingBlock: 2,
    color: colors.muted,
    fontSize: 11.5,
  },
  dividerStopped: { color: colors.warning },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerLabel: { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, fontWeight: 500 },
  // Working.
  working: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minHeight: 26,
    paddingInline: 2,
    color: colors.muted,
    fontSize: font.sm,
  },
  workingDots: { display: "inline-flex", alignItems: "center", gap: 3, width: 18, justifyContent: "center" },
  dot: {
    width: 4,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: bounce,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  dot2: { animationDelay: "0.15s" },
  dot3: { animationDelay: "0.3s" },
  workingLabel: { color: colors.text },
  workingTime: { fontVariantNumeric: "tabular-nums" },
  // Messages.
  userRow: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, minWidth: 0 },
  user: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    maxWidth: "88%",
    minWidth: 0,
    paddingBlock: 9,
    paddingInline: 13,
    borderRadius: 18,
    borderTopRightRadius: 6,
    backgroundColor: colors.accentSoft,
    color: colors.text,
  },
  userText: {
    margin: 0,
    maxWidth: "100%",
    fontSize: font.md,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    userSelect: "text",
  },
  userFolded: {
    maxHeight: "12lh",
    overflow: "hidden",
    maskImage: "linear-gradient(to bottom, black 70%, transparent)",
  },
  unfold: {
    marginTop: 4,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
  assistantRow: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, width: "100%" },
  markdown: {
    minWidth: 0,
    maxWidth: "100%",
    fontSize: font.md,
    lineHeight: 1.6,
    overflowWrap: "anywhere",
    userSelect: "text",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    minHeight: 24,
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, [stylex.when.ancestor(":focus-within")]: 1 },
    transition: "opacity 150ms",
  },
  actionsStart: { marginLeft: -4 },
  actionsUser: { marginBottom: -10 },
  action: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minWidth: 24,
    height: 24,
    paddingInline: 5,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    fontSize: font.xs,
    cursor: "pointer",
  },
  actionLabelled: { paddingInline: 7 },
  actionDone: { color: { default: colors.success, ":hover": colors.success } },
  time: { paddingInline: 6, color: colors.muted, fontSize: 11.5, fontVariantNumeric: "tabular-nums" },
  error: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    minWidth: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "color-mix(in oklab, transparent, #dc2626 25%)",
    backgroundColor: "color-mix(in oklab, transparent, #dc2626 7%)",
    color: colors.danger,
    fontSize: font.sm,
    lineHeight: 1.45,
  },
  errorText: { flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" },
  sentFiles: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
    alignSelf: "flex-end",
    maxWidth: "88%",
    minWidth: 0,
    marginBottom: -6,
  },
  sentImage: {
    display: "block",
    maxHeight: 140,
    maxWidth: "min(220px, 100%)",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    objectFit: "cover",
  },
  sentFile: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    height: 30,
    paddingInline: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    fontSize: font.xs,
  },
  context: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 4,
    minWidth: 0,
    marginBottom: -6,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    minWidth: 0,
    height: 22,
    paddingInline: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.text,
    fontSize: font.xs,
    whiteSpace: "nowrap",
  },
  chipLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 },
  chipRemove: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
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
});
