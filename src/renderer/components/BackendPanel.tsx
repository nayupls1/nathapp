// Status of an app's custom backend, shown in the agent panel: a pill with the
// state, opening live logs, the backend's files and start/stop controls.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { BackendStatus, RuntimeInfo } from "../../shared/api";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { states } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

const stateLabels: Record<BackendStatus["state"], string> = {
  stopped: "stopped",
  starting: "starting…",
  running: "running",
  crashed: "crashed",
};

export function BackendPill(props: { appId: string; open: boolean; onToggle: () => void; runtime: RuntimeInfo | undefined }) {
  const status = () => props.runtime?.status;
  const dotStyle = () => {
    const state = status()?.state;
    return state === "running" ? styles.dotRunning : state === "crashed" ? styles.dotCrashed : styles.dotIdle;
  };
  return (
    <Show when={status()?.exists}>
      <button
        type="button"
        onClick={() => props.onToggle()}
        title="Custom backend"
        {...stylex.attrs(styles.pill, props.open && styles.pillOpen)}
        data-backend-pill={status()!.state}
      >
        <span {...stylex.attrs(styles.dot, dotStyle())} />
        Backend
        <Show when={status()!.state === "running" && status()!.port}>
          <span {...stylex.attrs(styles.muted)}>:{status()!.port}</span>
        </Show>
        <Show when={status()!.state !== "running"}>
          <span {...stylex.attrs(styles.muted)}>{stateLabels[status()!.state]}</span>
        </Show>
      </button>
    </Show>
  );
}

/** Loads and live-updates an app's backend runtime info. */
export function useRuntime(appId: () => string) {
  const [runtime, setRuntime] = createStore<{ info?: RuntimeInfo }>({});
  const [loaded] = createResource(appId, (id) => api.runtime(id).catch(() => undefined));
  createEffect(() => {
    const info = loaded();
    if (info) setRuntime({ info });
  });
  // Re-check after agent runs (it may have created or changed the backend).
  createEffect(
    on(
      () => states[appId()]?.running,
      (running, wasRunning) => {
        if (wasRunning && !running) api.runtime(appId()).then((info) => setRuntime({ info }), () => {});
      },
    ),
  );
  createEffect(() => {
    const id = appId();
    const stop = watchTopic(`backend:${id}`, (msg) => {
      if (msg.type !== "backend") return;
      setRuntime(
        produce((r) => {
          if (!r.info) r.info = { status: msg.status as BackendStatus, logs: [], files: [] };
          if (msg.status) r.info.status = msg.status as BackendStatus;
          if (msg.log !== undefined) {
            r.info.logs.push(msg.log);
            if (r.info.logs.length > 500) r.info.logs.splice(0, r.info.logs.length - 500);
          }
        }),
      );
      // On state changes, reload everything: output from before we subscribed
      // (e.g. the startup logs) and files the agent may have written.
      if (msg.status) api.runtime(id).then((info) => setRuntime({ info }), () => {});
    });
    onCleanup(stop);
  });
  return () => runtime.info;
}

export function BackendDrawer(props: { appId: string; runtime: RuntimeInfo }) {
  const [tab, setTab] = createSignal<"logs" | "files">("logs");
  const [file, setFile] = createSignal<string>();
  const [content] = createResource(file, (path) => api.readFile(props.appId, path).catch((e) => String(e)));
  const [busy, setBusy] = createSignal(false);
  let logBox: HTMLPreElement | undefined;

  createEffect(
    on([() => props.runtime.logs.length, tab], () => {
      queueMicrotask(() => logBox?.scrollTo({ top: logBox.scrollHeight }));
    }),
  );

  const control = async (action: "start" | "stop" | "restart") => {
    setBusy(true);
    try {
      await api.controlBackend(props.appId, action);
    } finally {
      setBusy(false);
    }
  };
  const running = () => props.runtime.status.state === "running";

  return (
    <div {...stylex.attrs(styles.drawer)} data-backend-drawer>
      <div {...stylex.attrs(styles.toolbar)}>
        <button type="button" onClick={() => setTab("logs")} {...stylex.attrs(styles.tab, tab() === "logs" && styles.tabActive)}>
          Logs
        </button>
        <button type="button" onClick={() => setTab("files")} {...stylex.attrs(styles.tab, tab() === "files" && styles.tabActive)}>
          Files
        </button>
        <span {...stylex.attrs(styles.spacer)} />
        <button type="button" disabled={busy()} onClick={() => control("restart")} title="Restart" {...stylex.attrs(styles.iconButton)}>
          <Icon name="rotate-cw" size={14} />
        </button>
        <Show
          when={running()}
          fallback={
            <button type="button" disabled={busy()} onClick={() => control("start")} title="Start" {...stylex.attrs(styles.iconButton)}>
              <Icon name="play" size={14} />
            </button>
          }
        >
          <button type="button" disabled={busy()} onClick={() => control("stop")} title="Stop" {...stylex.attrs(styles.iconButton)}>
            <Icon name="square" size={14} />
          </button>
        </Show>
      </div>
      <Show when={tab() === "logs"}>
        <pre ref={logBox} {...stylex.attrs(styles.logs)}>
          {props.runtime.logs.length ? props.runtime.logs.join("\n") : "No output yet."}
        </pre>
      </Show>
      <Show when={tab() === "files"}>
        <div {...stylex.attrs(styles.files)}>
          <ul {...stylex.attrs(styles.fileList)}>
            <For each={props.runtime.files}>
              {(f) => (
                <li>
                  <button
                    type="button"
                    onClick={() => setFile(file() === f.path ? undefined : f.path)}
                    {...stylex.attrs(styles.fileButton, file() === f.path && styles.fileActive)}
                  >
                    <Icon name="file-code" size={13} />
                    {f.path}
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={file()}>
            <pre {...stylex.attrs(styles.logs)}>{content.latest ?? "…"}</pre>
          </Show>
        </div>
      </Show>
    </div>
  );
}

const styles = stylex.create({
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 24,
    paddingInline: space.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
  pillOpen: { backgroundColor: colors.surfaceHover },
  dot: { width: 7, height: 7, borderRadius: radius.full },
  dotRunning: { backgroundColor: colors.success },
  dotCrashed: { backgroundColor: colors.danger },
  dotIdle: { backgroundColor: colors.muted },
  muted: { color: colors.muted, fontWeight: 400 },
  drawer: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "45%",
    minHeight: 160,
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  toolbar: { display: "flex", alignItems: "center", gap: 2, paddingInline: space.sm, paddingBlock: space.xs },
  tab: {
    height: 26,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
  tabActive: { color: colors.text, backgroundColor: colors.surfaceHover },
  spacer: { flex: 1 },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: { default: "pointer", ":disabled": "default" },
  },
  logs: {
    flex: 1,
    minHeight: 0,
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    overflow: "auto",
    fontFamily: font.mono,
    fontSize: 11,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color: colors.text,
    backgroundColor: colors.bg,
  },
  files: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  fileList: { listStyle: "none", margin: 0, paddingInline: space.sm, paddingBottom: space.xs },
  fileButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    height: 26,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 11,
    textAlign: "left",
    cursor: "pointer",
  },
  fileActive: { backgroundColor: colors.accentSoft },
});
