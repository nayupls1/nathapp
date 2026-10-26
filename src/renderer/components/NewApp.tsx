// The screen of a new app tab (no project yet): describing the app happens in
// the agent sidebar; here are ideas, templates, and importing a project from
// Git or a folder. Each way ends in the same app lifecycle (server: Projects).
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api } from "../lib/api";
import { sendWithShares } from "../lib/sharing";
import { isAgentCollapsed, setAgentCollapsed } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

const examples = [
  "A habit tracker with daily check-ins and a streak count",
  "Track my expenses by category with a monthly total",
  "A shared grocery list that updates live on every device",
];

/** A new app tab: describe the app to the agent, pick an idea or a template, or bring an existing project. */
export function NewApp(props: { appId: string }) {
  const send = (prompt: string) => sendWithShares(props.appId, prompt);
  // Ready to type: the agent sidebar's composer.
  onMount(() => queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(`[data-agent-for="${props.appId}"] textarea`)?.focus()));
  const [presets] = createResource(() => api.presets().catch(() => []));
  const [starting, setStarting] = createSignal<string>();

  const [gitUrl, setGitUrl] = createSignal("");
  const [importing, setImporting] = createSignal<string>();
  const [importError, setImportError] = createSignal<string>();
  const failed = () => !!importError();
  /** Cloned or copied in, then it's an app like any other (Projects.importApp). */
  const importFrom = async (source: { git: string } | { folder: string }) => {
    setImportError();
    setImporting("git" in source ? "Cloning…" : "Copying…");
    try {
      await api.importApp(props.appId, source);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting();
    }
  };
  const pickFolder = async () => {
    const folder = await window.nathapp.pickFolder("Import an app from a folder");
    if (folder) await importFrom({ folder });
  };

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
          Describe an app to the agent and it builds it: a real project with its own server and database, running right here.
        </p>
        <Show
          when={isAgentCollapsed(props.appId)}
          fallback={
            <p {...stylex.attrs(styles.describeHint)}>
              Describe it in the agent panel
              <Icon name="arrow-right" size={16} />
            </p>
          }
        >
          <Button variant="primary" onClick={() => setAgentCollapsed(props.appId, false)} data-agent-show>
            <Icon name="bot" size={16} />
            Describe it to the agent
          </Button>
        </Show>
        <span {...stylex.attrs(styles.presetsLabel)}>Or pick an idea</span>
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
        <div {...stylex.attrs(styles.presets)}>
          <span {...stylex.attrs(styles.presetsLabel)}>Or bring an app you have</span>
          <div {...stylex.attrs(styles.importRow)}>
            <input
              value={gitUrl()}
              placeholder="https://github.com/owner/repo"
              spellcheck={false}
              disabled={!!importing()}
              onInput={(e) => setGitUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && gitUrl().trim() && void importFrom({ git: gitUrl().trim() })}
              {...stylex.attrs(styles.importInput)}
              data-import-git
            />
            <Button disabled={!!importing() || !gitUrl().trim()} onClick={() => void importFrom({ git: gitUrl().trim() })} data-import-clone>
              <Icon name="git-branch" size={14} />
              Clone
            </Button>
            <Button disabled={!!importing()} onClick={() => void pickFolder()} data-import-folder>
              <Icon name="folder-open" size={14} />
              Import a folder…
            </Button>
          </div>
          <Show when={importing() ?? importError()}>
            {(text) => <span {...stylex.attrs(styles.presetStack, failed() && styles.importError)}>{text()}</span>}
          </Show>
        </div>
      </div>
    </div>
  );
}


const styles = stylex.create({
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
  describeHint: { display: "flex", alignItems: "center", gap: space.sm, margin: 0, color: colors.accent, fontSize: font.md, fontWeight: 600 },
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
  importRow: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  importInput: {
    flex: 1,
    minWidth: 220,
    height: 32,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: font.sm,
    outline: "none",
  },
  importError: { color: colors.danger },
});
