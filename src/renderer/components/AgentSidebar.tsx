// The agent sidebar: one panel, right of the tabs, that looks and works the
// same for every kind of tab (web pages, apps, extension pages). It shows the
// agent of the tab that has the focus (in a split view, the focused pane's):
// editing an app, customizing a site and using it all happen here. Open or
// closed per tab (store: isAgentCollapsed).
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import { appById, isAgentCollapsed, isTab, selectedId, states } from "../lib/store";
import { colors } from "../theme.stylex";
import { Chat } from "./Chat";

/** The tab whose agent is shown, if its sidebar is open. */
export const agentTab = () => {
  const id = selectedId();
  return isTab(id) && appById(id) && states[id]?.loaded && !isAgentCollapsed(id) ? id : null;
};

export function AgentSidebar() {
  return (
    <Show when={agentTab()} keyed>
      {(tabId) => (
        <div {...stylex.attrs(styles.root)} style={{ width: "380px" }} data-agent-sidebar data-agent-for={tabId}>
          <Chat appId={tabId} />
        </div>
      )}
    </Show>
  );
}

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    // Never more than most of the window.
    maxWidth: "70vw",
    minHeight: 0,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
    backgroundColor: colors.bg,
  },
});
