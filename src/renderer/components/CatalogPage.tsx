// Browsable reference of everything the agent can build with: every catalog
// component with a live example, its props, and all available icons.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, ErrorBoundary, For, Show } from "solid-js";
import {
  CATALOG_APP_ID,
  catalogSpec,
  chartExamples,
  componentDocs,
  type ComponentDoc,
} from "../../shared/catalog";
import type { UINode } from "../../shared/spec";
import { Render } from "../catalog/components";
import { AppContext } from "../catalog/context";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon, iconTags } from "./Icon";
import { Input } from "./ui";

const categories = [...new Set(componentDocs.map((d) => d.category))];

export function CatalogPage() {
  const [dataVersion, setDataVersion] = createSignal(0);

  return (
    <AppContext.Provider
      value={{
        appId: CATALOG_APP_ID,
        spec: () => catalogSpec,
        dataVersion,
        invalidate: () => setDataVersion((v) => v + 1),
      }}
    >
      <div {...stylex.attrs(styles.page)}>
        <header {...stylex.attrs(styles.header)}>
          <h1 {...stylex.attrs(styles.title)}>
            <Icon name="book-open" size={24} {...stylex.attrs(styles.accent)} />
            Catalog
          </h1>
          <p {...stylex.attrs(styles.muted)}>
            Everything the agent can build apps from. Examples are live and use demo data that resets when gApp
            restarts.
          </p>
          <nav {...stylex.attrs(styles.jump)}>
            <For each={[...categories, "Icons"]}>
              {(c) => (
                <a href={`#catalog-${c}`} {...stylex.attrs(styles.chip)}>
                  {c}
                </a>
              )}
            </For>
          </nav>
        </header>

        <For each={categories}>
          {(category) => (
            <section id={`catalog-${category}`} {...stylex.attrs(styles.section)}>
              <h2 {...stylex.attrs(styles.sectionTitle)}>{category}</h2>
              <For each={componentDocs.filter((d) => d.category === category)}>{(doc) => <ComponentEntry doc={doc} />}</For>
              <Show when={category === "Charts"}>
                <h3 {...stylex.attrs(styles.subTitle)}>More chart kinds</h3>
                <div {...stylex.attrs(styles.chartGrid)}>
                  <For each={chartExamples}>{(node) => <Example node={node} />}</For>
                </div>
              </Show>
            </section>
          )}
        </For>

        <IconBrowser />
      </div>
    </AppContext.Provider>
  );
}

function ComponentEntry(props: { doc: ComponentDoc }) {
  return (
    <article {...stylex.attrs(styles.entry)} data-catalog-component={props.doc.type}>
      <div {...stylex.attrs(styles.entryHeader)}>
        <code {...stylex.attrs(styles.typeName)}>{props.doc.type}</code>
        <span {...stylex.attrs(styles.muted)}>{props.doc.summary}</span>
      </div>
      <Example node={props.doc.example} />
      <table {...stylex.attrs(styles.props)}>
        <tbody>
          <For each={props.doc.props}>
            {(p) => (
              <tr>
                <td {...stylex.attrs(styles.propCell, styles.propName)}>
                  {p.name}
                  {p.required ? "" : "?"}
                </td>
                <td {...stylex.attrs(styles.propCell, styles.propType)}>{p.type}</td>
                <td {...stylex.attrs(styles.propCell, styles.muted)}>{p.description}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <details>
        <summary {...stylex.attrs(styles.summary)}>Example spec</summary>
        <pre {...stylex.attrs(styles.code)}>{JSON.stringify(props.doc.example, null, 2)}</pre>
      </details>
    </article>
  );
}

function Example(props: { node: UINode }) {
  return (
    <div {...stylex.attrs(styles.example)} data-catalog-example>
      <ErrorBoundary
        fallback={(err) => (
          <p {...stylex.attrs(styles.error)} data-render-error>
            Failed to render: {String(err)}
          </p>
        )}
      >
        <Render node={props.node} />
      </ErrorBoundary>
    </div>
  );
}

const allIcons = Object.entries(iconTags);

function IconBrowser() {
  const [query, setQuery] = createSignal("");
  const [copied, setCopied] = createSignal<string>();
  const matches = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return allIcons.map(([name]) => name);
    return allIcons.filter(([name, tags]) => name.includes(q) || tags.some((t) => t.includes(q))).map(([name]) => name);
  });
  const shown = () => matches().slice(0, 240);

  const copy = async (name: string) => {
    await navigator.clipboard.writeText(name);
    setCopied(name);
    setTimeout(() => setCopied((c) => (c === name ? undefined : c)), 1200);
  };

  return (
    <section id="catalog-Icons" {...stylex.attrs(styles.section)}>
      <h2 {...stylex.attrs(styles.sectionTitle)}>Icons</h2>
      <p {...stylex.attrs(styles.muted)}>
        Any of the {allIcons.length} Lucide icons can be used by name (app icon, headings, cards, tabs, stats, lists,
        buttons, or the icon component). Click an icon to copy its name.
      </p>
      <Input
        placeholder="Search icons, e.g. money, calendar, heart"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <p {...stylex.attrs(styles.muted, styles.small)}>
        {matches().length} icons{matches().length > shown().length ? `, showing the first ${shown().length}` : ""}
      </p>
      <div {...stylex.attrs(styles.iconGrid)}>
        <For each={shown()}>
          {(name) => (
            <button type="button" title={name} onClick={() => copy(name)} {...stylex.attrs(styles.iconCell)}>
              <Icon name={name} size={22} />
              <span {...stylex.attrs(styles.iconName)}>{copied() === name ? "Copied!" : name}</span>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}

const styles = stylex.create({
  page: {
    maxWidth: 980,
    marginInline: "auto",
    padding: space.xl,
    paddingBottom: space.xxl,
    display: "flex",
    flexDirection: "column",
    gap: space.xxl,
  },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
  title: { margin: 0, display: "flex", alignItems: "center", gap: space.sm, fontSize: 28, fontWeight: 650 },
  accent: { color: colors.accent },
  muted: { color: colors.muted, fontSize: font.sm },
  small: { margin: 0, fontSize: font.xs },
  jump: { display: "flex", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
  chip: {
    paddingBlock: 4,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    color: colors.text,
    fontSize: font.sm,
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  section: { display: "flex", flexDirection: "column", gap: space.lg, scrollMarginTop: space.xl },
  sectionTitle: {
    margin: 0,
    fontSize: font.xl,
    fontWeight: 650,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  subTitle: { margin: 0, fontSize: font.lg, fontWeight: 600 },
  entry: { display: "flex", flexDirection: "column", gap: space.md },
  entryHeader: { display: "flex", alignItems: "baseline", gap: space.md, flexWrap: "wrap" },
  typeName: {
    fontFamily: font.mono,
    fontSize: font.md,
    fontWeight: 600,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingBlock: 2,
    paddingInline: space.sm,
    borderRadius: radius.sm,
  },
  example: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    minWidth: 0,
  },
  chartGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: space.lg },
  props: { width: "100%", borderCollapse: "collapse", fontSize: font.sm },
  propCell: {
    paddingBlock: 6,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    verticalAlign: "top",
  },
  propName: { fontFamily: font.mono, fontSize: font.xs, whiteSpace: "nowrap", fontWeight: 600 },
  propType: { fontFamily: font.mono, fontSize: font.xs, color: colors.accent },
  summary: { cursor: "pointer", color: colors.muted, fontSize: font.sm },
  code: {
    margin: 0,
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    fontFamily: font.mono,
    fontSize: font.xs,
    overflowX: "auto",
  },
  error: { margin: 0, color: colors.danger },
  iconGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: space.sm },
  iconCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "transparent", ":hover": colors.border },
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    color: colors.text,
    cursor: "pointer",
  },
  iconName: {
    maxWidth: "100%",
    fontSize: 11,
    color: colors.muted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
