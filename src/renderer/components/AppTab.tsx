// An app tab: a prompt for new apps, otherwise the running app in a preview
// next to the agent. While the app is being edited the preview shows its dev
// server (changes appear live); once it's done, the built app.
import * as stylex from "@stylexjs/stylex";
import type { DidFailLoadEvent, WebviewTag } from "electron";
import { createEffect, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { appPartition, type AppMode, type ElementInfo, type LogLine, type PageContext, type RuntimeStatus } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { cancelPickScript, pickScript, unmarkScript } from "../lib/picker";
import { watchTopic } from "../lib/realtime";
import { isAgentCollapsed, sendPrompt, setAgentCollapsed, setRuntime, states, stopAgent } from "../lib/store";
import { registerPage, type PageInfo } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { Chat, Chip, ShowAgentButton } from "./Chat";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { DataPanel } from "./DataPanel";
import { HistoryPanel } from "./History";
import { SecretsPanel } from "./Secrets";

const examples = [
  "A habit tracker with daily check-ins and a streak count",
  "Track my expenses by category with a monthly total",
  "A shared grocery list that updates live on every device",
];

export function AppTab(props: { appId: string; active: boolean }) {
  const state = () => states[props.appId];
  const isNew = () => !state()?.project && !state()?.messages.length && !state()?.running;

  return (
    <Show when={state()?.loaded}>
      <Show when={!isNew()} fallback={<NewApp appId={props.appId} />}>
        <Workbench appId={props.appId} active={props.active} />
      </Show>
    </Show>
  );
}

function NewApp(props: { appId: string }) {
  const send = (prompt: string) => sendPrompt(props.appId, prompt);
  const [presets] = createResource(() => api.presets().catch(() => []));
  const [starting, setStarting] = createSignal<string>();

  const startFrom = async (preset: string) => {
    setStarting(preset);
    try {
      await api.createProject(props.appId, preset);
    } finally {
      setStarting();
    }
  };

  return (
    <div {...stylex.attrs(styles.newRoot)} data-app-tab={props.appId}>
      <div {...stylex.attrs(styles.newInner)}>
        <h1 {...stylex.attrs(styles.title)}>What do you want to build?</h1>
        <p {...stylex.attrs(styles.subtitle)}>
          Describe an app and the agent builds it: a real project with its own server and database, running right here.
        </p>
        <Composer
          appId={props.appId}
          large
          autofocus
          running={!!states[props.appId]?.running}
          placeholder="e.g. A simple CRM for tracking leads and follow-ups"
          onSend={send}
          onStop={() => stopAgent(props.appId)}
        />
        <div {...stylex.attrs(styles.chips)}>
          <For each={examples}>
            {(example) => (
              <button type="button" onClick={() => send(example)} {...stylex.attrs(styles.example)}>
                {example}
              </button>
            )}
          </For>
        </div>
        <Show when={presets()?.length}>
          <div {...stylex.attrs(styles.presets)}>
            <span {...stylex.attrs(styles.presetsLabel)}>Or start from a template</span>
            <div {...stylex.attrs(styles.chips)}>
              <For each={presets()}>
                {(preset) => (
                  <button
                    type="button"
                    title={preset.description}
                    disabled={!!starting()}
                    onClick={() => void startFrom(preset.id)}
                    {...stylex.attrs(styles.preset)}
                    data-template={preset.id}
                  >
                    <strong>{preset.name}</strong>
                    <span {...stylex.attrs(styles.presetStack)}>{starting() === preset.id ? "Setting up…" : preset.stack}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

const stateLabels: Record<RuntimeStatus["state"], string> = {
  stopped: "Stopped",
  installing: "Installing dependencies…",
  building: "Building…",
  starting: "Starting…",
  running: "Running",
  crashed: "Crashed",
};

function Workbench(props: { appId: string; active: boolean }) {
  const state = () => states[props.appId]!;
  const runtime = () => state().runtime;
  const mode = (): AppMode => runtime()?.mode ?? "dev";
  const running = () => runtime()?.state === "running" && !!runtime()?.url;
  const busy = () => ["installing", "building", "starting"].includes(runtime()?.state ?? "");
  const collapsed = () => isAgentCollapsed(props.appId);
  const isDev = () => mode() === "dev";
  const isLive = () => mode() === "live";
  const isRunning = () => runtime()?.state === "running";
  const isCrashed = () => runtime()?.state === "crashed";
  const [logsOpen, setLogsOpen] = createSignal(false);
  const [secretsOpen, setSecretsOpen] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [dataOpen, setDataOpen] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [picked, setPicked] = createSignal<ElementInfo[]>([]);
  const [loadError, setLoadError] = createSignal<string>();

  let webview: WebviewTag | undefined;
  let ready = false;

  // --- Runtime control ---------------------------------------------------------------

  const control = async (action: "start" | "stop" | "restart") => setRuntime(props.appId, await api.controlRuntime(props.appId, action));
  const switchMode = async (next: AppMode) => {
    if (next === mode() && running()) return;
    setRuntime(props.appId, await api.setMode(props.appId, next));
  };

  // --- The preview page --------------------------------------------------------------

  let loadWaiters: (() => void)[] = [];
  const loaded = () => {
    for (const fn of loadWaiters.splice(0)) fn();
  };
  const waitForLoad = (timeoutMs = 30_000) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      loadWaiters.push(() => (clearTimeout(timer), resolve()));
    });

  const requireReady = () => {
    if (!webview || !ready) throw new Error(running() ? "The preview is still loading" : `The app isn't running (${runtime()?.state ?? "no project"})`);
    return webview;
  };
  const info = (): PageInfo => (webview && ready ? { url: webview.getURL(), title: webview.getTitle() } : { url: runtime()?.url ?? "", title: "" });

  function attach(view: WebviewTag) {
    webview = view;
    ready = false;
    view.addEventListener("did-start-loading", () => setLoadError());
    view.addEventListener("did-stop-loading", loaded);
    view.addEventListener("did-fail-load", (e: DidFailLoadEvent) => {
      if (e.isMainFrame && e.errorCode !== -3) setLoadError(`${e.errorDescription || "Failed to load"} (${e.validatedURL})`);
      loaded();
    });
    view.addEventListener("did-navigate", () => setPicked([]));
    view.addEventListener("dom-ready", () => (ready = true));
  }

  const unregister = registerPage(props.appId, {
    info,
    eval: (code) => requireReady().executeJavaScript(code),
    capture: () => window.nathapp.web.capture(requireReady().getWebContentsId()),
    navigate: async (url) => {
      const view = requireReady();
      const target = new URL(url, runtime()!.url!).toString();
      const done = waitForLoad();
      await view.loadURL(target).catch(() => {});
      await done;
      return info();
    },
    reload: async () => {
      const view = requireReady();
      const done = waitForLoad();
      view.reload();
      await done;
      return info();
    },
    back: () => webview && ready && webview.goBack(),
    forward: () => webview && ready && webview.goForward(),
    focusAddress: () => {},
    applyOverride: async () => ({ applied: false }),
    overrideChanged: () => {},
    send,
    webContentsId: () => {
      throw new Error("Network traffic is only recorded in web tabs");
    },
  });
  onCleanup(unregister);

  // A new server (restart, mode switch) means a new page.
  const previewKey = () => (running() ? `${runtime()!.url}|${runtime()!.startedAt}|${runtime()!.mode}` : null);

  // --- Element picker ----------------------------------------------------------------

  async function pick() {
    if (!webview || !ready) return;
    if (picking()) return void webview.executeJavaScript(cancelPickScript).catch(() => {});
    setPicking(true);
    webview.focus();
    try {
      const element = (await webview.executeJavaScript(pickScript, true)) as ElementInfo | null;
      if (element) {
        setPicked((list) => (list.some((p) => p.selector === element.selector) ? list : [...list, element]));
        setAgentCollapsed(props.appId, false);
        queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(`[data-app-tab="${props.appId}"] [data-agent-panel] textarea`)?.focus());
      }
    } catch {
      // the page reloaded mid-pick
    } finally {
      setPicking(false);
    }
  }

  function unpick(element: ElementInfo) {
    setPicked((list) => list.filter((p) => p !== element));
    if (webview && ready) void webview.executeJavaScript(unmarkScript(element.selector)).catch(() => {});
  }

  function send(prompt: string) {
    const selection = picked();
    const page: PageContext | undefined =
      webview && ready && selection.length ? { url: webview.getURL(), title: webview.getTitle(), selection } : undefined;
    setPicked([]);
    if (webview && ready) void webview.executeJavaScript(unmarkScript()).catch(() => {});
    void sendPrompt(props.appId, prompt, page);
  }

  const pickButton = (size: number) => (
    <button
      type="button"
      title={picking() ? "Cancel picking (Esc)" : "Pick elements in the app for the agent"}
      disabled={!running()}
      onClick={pick}
      {...stylex.attrs(styles.iconButton, picking() && styles.iconButtonOn)}
      data-pick-element
    >
      <Icon name="crosshair" size={size} />
    </button>
  );

  return (
    <div {...stylex.attrs(styles.split)} data-app-tab={props.appId}>
      <div {...stylex.attrs(styles.main)}>
        <div {...stylex.attrs(styles.toolbar)}>
          <div {...stylex.attrs(styles.segmented)} role="group" aria-label="Mode">
            <button
              type="button"
              title="Editing: the dev server, changes appear live"
              disabled={!state().project}
              onClick={() => void switchMode("dev")}
              {...stylex.attrs(styles.segment, isDev() && styles.segmentOn)}
              data-mode="dev"
            >
              <Icon name="pencil" size={13} />
              Editing
            </button>
            <button
              type="button"
              title="Done: build the app and run the finished version"
              disabled={!state().project}
              onClick={() => void switchMode("live")}
              {...stylex.attrs(styles.segment, isLive() && styles.segmentOn)}
              data-mode="live"
            >
              <Icon name="circle-check" size={13} />
              Done
            </button>
          </div>
          <Show when={state().project}>
            <span {...stylex.attrs(styles.status)} title={runtime()?.error ?? undefined} data-runtime-state={runtime()?.state}>
              <span
                {...stylex.attrs(
                  styles.dot,
                  isRunning() && styles.dotRunning,
                  busy() && styles.dotBusy,
                  isCrashed() && styles.dotCrashed,
                )}
              />
              {stateLabels[runtime()?.state ?? "stopped"]}
            </span>
          </Show>
          <span {...stylex.attrs(styles.url)}>{running() ? runtime()!.url!.replace(/^http:\/\//, "") : ""}</span>
          {pickButton(16)}
          <button
            type="button"
            title="Restart the app"
            disabled={!state().project || busy()}
            onClick={() => void control("restart")}
            {...stylex.attrs(styles.iconButton)}
            data-restart
          >
            <Icon name="rotate-cw" size={15} />
          </button>
          <button
            type="button"
            title="Logs"
            disabled={!state().project}
            onClick={() => setLogsOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, logsOpen() && styles.iconButtonOn)}
            data-logs
          >
            <Icon name="terminal" size={15} />
          </button>
          <button
            type="button"
            title="Secrets (API keys, passwords) for this app"
            onClick={() => setSecretsOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, secretsOpen() && styles.iconButtonOn)}
            data-secrets
          >
            <Icon name="key-round" size={15} />
          </button>
          <button
            type="button"
            title="History: undo changes, restore earlier versions"
            disabled={!state().project}
            onClick={() => setHistoryOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, historyOpen() && styles.iconButtonOn)}
            data-history-button
          >
            <Icon name="file-clock" size={15} />
          </button>
          <button
            type="button"
            title="Data: what the app has stored"
            disabled={!state().project}
            onClick={() => setDataOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, dataOpen() && styles.iconButtonOn)}
            data-data-button
          >
            <Icon name="database" size={15} />
          </button>
          <button
            type="button"
            title="Open in your browser"
            disabled={!running()}
            onClick={() => window.nathapp.web.openExternal(runtime()!.url!)}
            {...stylex.attrs(styles.iconButton)}
          >
            <Icon name="external-link" size={15} />
          </button>
        </div>
        <div {...stylex.attrs(styles.viewport)}>
          <Show
            when={previewKey()}
            keyed
            fallback={
              <Placeholder appId={props.appId} onStart={() => void control("start")} onLogs={() => setLogsOpen(true)} onHistory={() => setHistoryOpen(true)} />
            }
          >
            {(_) => (
              <webview ref={attach} src={runtime()!.url!} partition={appPartition(props.appId)} {...stylex.attrs(styles.webview)} />
            )}
          </Show>
          <Show when={picking()}>
            <div {...stylex.attrs(styles.banner)}>Click an element to pick it · Esc to cancel</div>
          </Show>
          <Show when={loadError() && running()}>
            <div {...stylex.attrs(styles.banner, styles.bannerError)}>
              {loadError()}
              <button type="button" onClick={() => webview?.reload()} {...stylex.attrs(styles.bannerButton)}>
                Retry
              </button>
            </div>
          </Show>
          <Show when={collapsed()}>
            <ShowAgentButton appId={props.appId} />
          </Show>
        </div>
        <Show when={logsOpen()}>
          <Logs appId={props.appId} onClose={() => setLogsOpen(false)} />
        </Show>
        <Show when={secretsOpen()}>
          <SecretsPanel appId={props.appId} onClose={() => setSecretsOpen(false)} />
        </Show>
        <Show when={historyOpen()}>
          <HistoryPanel appId={props.appId} onClose={() => setHistoryOpen(false)} />
        </Show>
        <Show when={dataOpen()}>
          <DataPanel appId={props.appId} onClose={() => setDataOpen(false)} />
        </Show>
      </div>
      <Show when={!collapsed()}>
        <Chat
          appId={props.appId}
          page={{
            onSend: send,
            tools: pickButton(15),
            top: (
              <Show when={picked().length}>
                <div {...stylex.attrs(styles.pickedChips)}>
                  <For each={picked()}>
                    {(el) => (
                      <Chip
                        label={el.text ? `${el.tag} “${el.text.slice(0, 24)}${el.text.length > 24 ? "…" : ""}”` : el.selector}
                        title={el.selector}
                        onRemove={() => unpick(el)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            ),
          }}
        />
      </Show>
    </div>
  );
}

/** What the preview shows while there's nothing to show. */
function Placeholder(props: { appId: string; onStart: () => void; onLogs: () => void; onHistory: () => void }) {
  const state = () => states[props.appId]!;
  const runtime = () => state().runtime;
  // A crash right after the agent changed something: offer to take that change back.
  const [undoError, setUndoError] = createSignal<string>();
  const [lastChange] = createResource(
    () => (runtime()?.state === "crashed" ? props.appId : undefined),
    async (id) => (await api.history({ target: `app:${id}`, limit: 20 })).find((e) => e.actor === "agent" && !e.first) ?? null,
  );
  const undoLast = async () => {
    setUndoError();
    try {
      await api.undoSnapshot(lastChange()!.id);
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div {...stylex.attrs(styles.placeholder)}>
      <Switch>
        <Match when={!state().project}>
          <Icon name="hammer" size={28} {...stylex.attrs(styles.placeholderIcon)} />
          <p>{state().running ? "The agent is setting up your app…" : "No app yet. Describe what you want in the chat."}</p>
        </Match>
        <Match when={runtime()?.state === "crashed"}>
          <Icon name="triangle-alert" size={28} {...stylex.attrs(styles.placeholderError)} />
          <p>{runtime()?.error ?? "The app stopped unexpectedly."}</p>
          <div {...stylex.attrs(styles.placeholderActions)}>
            <button type="button" onClick={props.onStart} {...stylex.attrs(styles.pillButton)}>
              Try again
            </button>
            <button type="button" onClick={props.onLogs} {...stylex.attrs(styles.pillButton)}>
              Show logs
            </button>
            <Show when={lastChange()}>
              <button type="button" onClick={() => void undoLast()} title={lastChange()!.summary} {...stylex.attrs(styles.pillButton)} data-undo-last>
                Undo the agent's last change
              </button>
            </Show>
            <button type="button" onClick={props.onHistory} {...stylex.attrs(styles.pillButton)}>
              History
            </button>
          </div>
          <Show when={undoError()}>
            <p {...stylex.attrs(styles.placeholderErrorText)}>{undoError()}</p>
          </Show>
        </Match>
        <Match when={!runtime() || runtime()!.state === "stopped"}>
          <Icon name="play" size={28} {...stylex.attrs(styles.placeholderIcon)} />
          <p>The app isn't running.</p>
          <button type="button" onClick={props.onStart} {...stylex.attrs(styles.pillButton)} data-start>
            Start
          </button>
        </Match>
        <Match when={true}>
          <span {...stylex.attrs(styles.spinner)} />
          <p>{stateLabels[runtime()!.state]}</p>
        </Match>
      </Switch>
    </div>
  );
}

/** The app's output (install, build, server), live. */
function Logs(props: { appId: string; onClose: () => void }) {
  const [lines, setLines] = createSignal<LogLine[]>([]);
  let scroller!: HTMLDivElement;
  let stick = true;

  api.runtime(props.appId).then((r) => setLines(r.logs), () => {});
  const stop = watchTopic(topics.logs(props.appId), (msg) => {
    if (msg.type === "log") setLines((l) => [...l, ...msg.lines].slice(-2000));
  });
  onCleanup(stop);

  createEffect(
    on(lines, () => {
      if (stick) queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );

  return (
    <div {...stylex.attrs(styles.logs)} data-logs-panel>
      <div {...stylex.attrs(styles.logsHeader)}>
        <Icon name="terminal" size={14} />
        <span {...stylex.attrs(styles.logsTitle)}>Logs</span>
        <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div
        ref={scroller}
        onScroll={() => (stick = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8)}
        {...stylex.attrs(styles.logsBody)}
      >
        <For each={lines()} fallback={<span {...stylex.attrs(styles.logSystem)}>No output yet.</span>}>
          {(line) => {
            const isErr = () => line.stream === "err";
            const isSystem = () => line.stream === "system";
            return <div {...stylex.attrs(styles.logLine, isErr() && styles.logErr, isSystem() && styles.logSystem)}>{line.text}</div>;
          }}
        </For>
      </div>
    </div>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.35 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.35 },
});

const spin = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  placeholderErrorText: { margin: 0, maxWidth: 480, color: colors.danger, fontSize: font.sm, textAlign: "center" },
  split: { display: "flex", height: "100%", minHeight: 0 },
  main: { position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    height: 44,
    flexShrink: 0,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  segmented: {
    display: "flex",
    padding: 2,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
  },
  segment: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 26,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    fontSize: font.xs,
    fontWeight: 500,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.5 },
  },
  segmentOn: {
    backgroundColor: colors.surface,
    color: { default: colors.text, ":hover": colors.text },
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.1)",
  },
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    marginLeft: space.sm,
    color: colors.muted,
    fontSize: font.xs,
    whiteSpace: "nowrap",
  },
  dot: { width: 7, height: 7, borderRadius: radius.full, backgroundColor: colors.muted },
  dotRunning: { backgroundColor: colors.success },
  dotBusy: { backgroundColor: colors.warning, animationName: pulse, animationDuration: "1.2s", animationIterationCount: "infinite" },
  dotCrashed: { backgroundColor: colors.danger },
  url: {
    flex: 1,
    minWidth: 0,
    paddingInline: space.sm,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.muted,
    fontFamily: font.mono,
    fontSize: 11.5,
    textAlign: "right",
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 30,
    height: 30,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text, ":disabled": colors.muted },
    opacity: { default: 1, ":disabled": 0.4 },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  iconButtonOn: { backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft }, color: { default: colors.accent, ":hover": colors.accent } },
  viewport: { position: "relative", flex: 1, minHeight: 0, backgroundColor: colors.bg },
  webview: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  placeholder: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    height: "100%",
    padding: space.xl,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  placeholderIcon: { color: colors.accent },
  placeholderError: { color: colors.danger },
  placeholderActions: { display: "flex", gap: space.sm },
  pillButton: {
    paddingBlock: 6,
    paddingInline: space.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
  },
  spinner: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: colors.border,
    borderTopColor: colors.accent,
    animationName: spin,
    animationDuration: "0.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  banner: {
    position: "absolute",
    top: space.md,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    maxWidth: "90%",
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontSize: font.sm,
    fontWeight: 500,
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.18)",
    pointerEvents: "none",
  },
  bannerError: { backgroundColor: colors.danger, pointerEvents: "auto" },
  bannerButton: {
    paddingBlock: 2,
    paddingInline: space.sm,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: "rgb(255 255 255 / 0.2)",
    color: "inherit",
    fontSize: font.xs,
    fontWeight: 600,
    cursor: "pointer",
  },
  logs: {
    display: "flex",
    flexDirection: "column",
    height: 220,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  logsHeader: { display: "flex", alignItems: "center", gap: 6, height: 34, flexShrink: 0, paddingInline: space.md, color: colors.muted },
  logsTitle: { flex: 1, fontSize: font.xs, fontWeight: 600 },
  logsBody: {
    flex: 1,
    overflowY: "auto",
    paddingInline: space.md,
    paddingBottom: space.sm,
    fontFamily: font.mono,
    fontSize: 11.5,
    lineHeight: 1.5,
  },
  logLine: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  logErr: { color: colors.danger },
  logSystem: { color: colors.muted },
  pickedChips: { display: "flex", flexWrap: "wrap", gap: 4, paddingInline: 4, paddingTop: 2 },
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
  subtitle: { margin: 0, marginTop: -8, color: colors.muted, fontSize: font.md, lineHeight: 1.5 },
  chips: { display: "flex", flexWrap: "wrap", gap: space.sm },
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
  presets: { display: "flex", flexDirection: "column", gap: space.sm, marginTop: space.sm },
  presetsLabel: { color: colors.muted, fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" },
  preset: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "progress" },
  },
  presetStack: { color: colors.muted, fontSize: font.xs },
});
