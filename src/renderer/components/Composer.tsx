import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onMount, Show } from "solid-js";
import type { Effort } from "../../shared/api";
import { loadModels, models, setAgentOptions, states } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Button } from "./ui";

const effortLabels: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Model and effort pickers for an app's agent. */
function AgentOptions(props: { appId: string }) {
  onMount(() => {
    if (!models().length) loadModels();
  });
  const state = () => states[props.appId];
  const model = () => state()?.model ?? null;
  const effort = () => state()?.effort ?? null;
  // Effort levels the selected model supports ("default" when none is picked).
  const supported = () => models().find((m) => m.value === (model() ?? "default"))?.efforts ?? [];

  const set = (next: { model?: string | null; effort?: Effort | null }) => {
    const m = next.model !== undefined ? next.model : model();
    let e = next.effort !== undefined ? next.effort : effort();
    const efforts = models().find((x) => x.value === (m ?? "default"))?.efforts ?? [];
    if (e && !efforts.includes(e)) e = null;
    setAgentOptions(props.appId, { model: m, effort: e });
  };

  return (
    <div {...stylex.attrs(styles.options)}>
      <select
        title="Model"
        value={model() ?? ""}
        onChange={(e) => set({ model: e.currentTarget.value || null })}
        {...stylex.attrs(styles.select)}
      >
        <option value="">Default model</option>
        <For each={models().filter((m) => m.value !== "default")}>
          {(m) => (
            <option value={m.value} title={m.description}>
              {m.displayName}
            </option>
          )}
        </For>
      </select>
      <Show when={supported().length}>
        <select
          title="Effort"
          value={effort() ?? ""}
          onChange={(e) => set({ effort: (e.currentTarget.value || null) as Effort | null })}
          {...stylex.attrs(styles.select)}
        >
          <option value="">Default effort</option>
          <For each={supported()}>{(level) => <option value={level}>{effortLabels[level]} effort</option>}</For>
        </select>
      </Show>
    </div>
  );
}

export function Composer(props: {
  appId: string;
  running: boolean;
  placeholder?: string;
  autofocus?: boolean;
  large?: boolean;
  onSend: (prompt: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = createSignal("");
  let textarea!: HTMLTextAreaElement;

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
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        {...stylex.attrs(styles.input, props.large && styles.inputLarge)}
      />
      <div {...stylex.attrs(styles.actions)}>
        <AgentOptions appId={props.appId} />
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
  },
  inputLarge: { fontSize: font.lg, minHeight: 72 },
  actions: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  options: { display: "flex", alignItems: "center", gap: 2, minWidth: 0 },
  select: {
    height: 28,
    maxWidth: 150,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.xs,
    cursor: "pointer",
    outline: "none",
  },
});
