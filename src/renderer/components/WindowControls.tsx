// The window's minimize, maximize and close buttons, top right: the window is
// frameless (no title bar) except on macOS, which keeps its traffic lights.
// Top bars under them are padded (lib/windowChrome.ts).
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, Show } from "solid-js";
import { CONTROLS_WIDTH, hasOwnControls } from "../lib/windowChrome";
import { colors } from "../theme.stylex";
import { Icon } from "./Icon";

export function WindowControls() {
  const bridge = window.nathapp.window;
  const [maximized, setMaximized] = createSignal(false);
  onCleanup(bridge.onMaximized(setMaximized));
  return (
    <Show when={hasOwnControls}>
      <div {...stylex.attrs(styles.root)} style={{ width: `${CONTROLS_WIDTH}px` }} data-window-controls>
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
  // Above the tabs and their bars, below menus and dialogs.
  root: { position: "fixed", top: 0, right: 0, zIndex: 900, display: "flex", height: 44 },
  button: {
    display: "grid",
    placeItems: "center",
    flex: 1,
    padding: 0,
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "default",
  },
  close: { backgroundColor: { default: "transparent", ":hover": "#e81123" }, color: { default: colors.muted, ":hover": "#ffffff" } },
});
