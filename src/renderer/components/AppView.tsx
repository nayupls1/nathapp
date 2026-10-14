// Renders a generated app from its spec.
import * as stylex from "@stylexjs/stylex";
import { ErrorBoundary } from "solid-js";
import type { AppSpec } from "../../shared/spec";
import { AppContext } from "../catalog/context";
import { Render } from "../catalog/components";
import { bumpData, states } from "../lib/store";
import { colors, font, space } from "../theme.stylex";

export function AppView(props: { appId: string; spec: AppSpec }) {
  return (
    <AppContext.Provider
      value={{
        appId: props.appId,
        spec: () => props.spec,
        dataVersion: () => states[props.appId]?.dataVersion ?? 0,
        invalidate: () => bumpData(props.appId),
      }}
    >
      <div {...stylex.attrs(styles.root)}>
        <ErrorBoundary fallback={(err) => <p {...stylex.attrs(styles.error)}>This app failed to render: {String(err)}</p>}>
          <Render node={props.spec.ui} />
        </ErrorBoundary>
      </div>
    </AppContext.Provider>
  );
}

const styles = stylex.create({
  root: {
    maxWidth: 960,
    marginInline: "auto",
    padding: space.xl,
    paddingBottom: space.xxl,
    fontSize: font.md,
  },
  error: { color: colors.danger },
});
