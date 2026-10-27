// The window's minimize, maximize and close buttons, at the top of the sidebar
// (a column when it's collapsed), like Zen Browser: the window is frameless
// (no title bar) except on macOS, which keeps its traffic lights.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, Show } from "solid-js";
import { hasOwnControls } from "../lib/windowChrome";
import { colors } from "../theme.stylex";
import { Icon } from "./Icon";

export function WindowControls(props: { vertical?: boolean }) {
  const bridge = window.nathapp.window;
  const [maximized, setMaximized] = createSignal(false);
  onCleanup(bridge.onMaximized(setMaximized));
  return (
    <Show when={hasOwnControls}>
      <div {...stylex.attrs(styles.root, props.vertical && styles.vertical)} data-window-controls>
        <button type="button" title="Minimize" onClick={() => bridge.minimize()} {...stylex.attrs(styles.button)}>
          <Icon name="minus" size={16} />
        </button>
        <button type="button" title={maximized() ? "Restore" : "Maximize"} onClick={() => bridge.toggleMaximize()} {...stylex.attrs(styles.button)}>
          <Icon name={maximized() ? "copy" : "square"} size={13} />
        </button>
        <button type="button" title="Close" onClick={() => bridge.close()} {...stylex.attrs(styles.button, styles.close)}>
          <Icon name="x" size={17} />
        </button>
      </div>
    </Show>
  );
}

const styles = stylex.create({
  root: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0 },
  vertical: { flexDirection: "column" },
  button: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: 6,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "default",
  },
  close: { backgroundColor: { default: "transparent", ":hover": "#e81123" }, color: { default: colors.muted, ":hover": "#ffffff" } },
});
