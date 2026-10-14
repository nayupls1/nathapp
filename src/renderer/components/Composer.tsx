import * as stylex from "@stylexjs/stylex";
import { createSignal, Show } from "solid-js";
import { colors, font, radius, space } from "../theme.stylex";
import { Button } from "./ui";

export function Composer(props: {
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
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.04)",
  },
  large: { flexDirection: "column", alignItems: "stretch", padding: space.md },
  input: {
    flex: 1,
    minWidth: 0,
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
  actions: { display: "flex", justifyContent: "flex-end" },
});
