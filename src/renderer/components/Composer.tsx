import * as stylex from "@stylexjs/stylex";
import { createSignal, Show, type JSX } from "solid-js";
import { setAgentChoice, states } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { AgentPicker } from "./AgentPicker";
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
  // Clipped rather than running under Send in a narrow panel.
  options: { display: "flex", alignItems: "center", gap: 2, minWidth: 0, overflow: "hidden" },
});
