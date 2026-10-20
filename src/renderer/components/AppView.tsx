// Renders a generated app from its spec.
import * as stylex from "@stylexjs/stylex";
import { ErrorBoundary, onCleanup } from "solid-js";
import type { AppSpec } from "../../shared/spec";
import { AppContext } from "../catalog/context";
import { Render } from "../catalog/components";
import { watchApp } from "../lib/realtime";
import { bumpData, bumpTables, reloadSpec, tableVersion } from "../lib/store";
import { colors, font, space } from "../theme.stylex";

export function AppView(props: { appId: string; spec: AppSpec }) {
  // Live data: the server pushes every change, from wherever it came.
  const stop = watchApp(props.appId, {
    tables: (tables) => bumpTables(props.appId, tables),
    spec: () => reloadSpec(props.appId),
  });
  onCleanup(stop);

  return (
    <AppContext.Provider
      value={{
        appId: props.appId,
        spec: () => props.spec,
        version: (table) => tableVersion(props.appId, table),
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
