// Asks the user when an app or agent wants to do something new (use AI, a
// global secret, customize a site). One request at a time, oldest first;
// unanswered requests are denied by the server after a while.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { PermissionRequest } from "../../shared/api";
import { answerPermission, permissionRequests } from "../lib/security";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

const icons: Record<PermissionRequest["action"], string> = {
  "app.ai": "sparkles",
  "app.secret": "key-round",
  "agent.site": "paintbrush",
};

/** Mount once at the app root. */
export function PermissionHost() {
  return (
    <Show when={permissionRequests()[0]} keyed>
      {(request) => <Prompt request={request} more={permissionRequests().length - 1} />}
    </Show>
  );
}

function Prompt(props: { request: PermissionRequest; more: number }) {
  const [remember, setRemember] = createSignal(false);
  let allowButton!: HTMLButtonElement;
  onMount(() => allowButton.focus());
  const answer = (allow: boolean, always = false) => void answerPermission(props.request.id, allow, always || remember());

  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)}>
        <div role="alertdialog" aria-modal="true" aria-labelledby="permission-title" {...stylex.attrs(styles.dialog)} data-permission-request={props.request.action}>
          <div {...stylex.attrs(styles.head)}>
            <span {...stylex.attrs(styles.icon)}>
              <Icon name={icons[props.request.action]} size={18} />
            </span>
            <div {...stylex.attrs(styles.text)}>
              <span {...stylex.attrs(styles.who)}>{props.request.subjectName}</span>
              <h2 id="permission-title" {...stylex.attrs(styles.title)}>
                {props.request.title}
              </h2>
            </div>
          </div>
          <p {...stylex.attrs(styles.detail)}>{props.request.detail}</p>
          <label {...stylex.attrs(styles.remember)}>
            <input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
            Remember my choice (you can change it in Settings → Permissions)
          </label>
          <div {...stylex.attrs(styles.actions)}>
            <Show when={props.more > 0}>
              <span {...stylex.attrs(styles.more)}>{props.more} more waiting</span>
            </Show>
            <Button onClick={() => answer(false)} data-deny>
              Don't allow
            </Button>
            <Button ref={allowButton} variant="primary" onClick={() => answer(true)} data-allow>
              Allow
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2100,
    display: "grid",
    placeItems: "center",
    padding: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.35)",
    animationName: fadeIn,
    animationDuration: "120ms",
  },
  dialog: {
    width: "min(460px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    boxShadow: "0 20px 50px rgb(0 0 0 / 0.25)",
  },
  head: { display: "flex", alignItems: "center", gap: space.md },
  icon: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  text: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  who: { color: colors.muted, fontSize: font.xs, fontWeight: 600 },
  title: { margin: 0, fontSize: font.lg, fontWeight: 600, lineHeight: 1.3, overflowWrap: "anywhere" },
  detail: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  remember: { display: "flex", alignItems: "center", gap: space.sm, fontSize: font.sm, cursor: "pointer" },
  actions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: space.sm },
  more: { marginRight: "auto", color: colors.muted, fontSize: font.xs },
});
