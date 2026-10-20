// The Settings tab: appearance, agent defaults and prompt additions, web tabs, backends.
import * as stylex from "@stylexjs/stylex";
import { createResource, For, onMount, Show, type JSX } from "solid-js";
import type { Effort } from "../../shared/api";
import { searchEngines, type GlobalTheme, type Settings } from "../../shared/settings";
import { api } from "../lib/api";
import { settings, updateSettings } from "../lib/settings";
import { loadModels, models } from "../lib/store";
import { resolveMode, systemDark, themePresets, themeVars } from "../lib/theme";
import { colors, font, radius, space } from "../theme.stylex";
import { effortLabels } from "./Composer";
import { Icon } from "./Icon";
import { Select } from "./ui";

export function SettingsPage() {
  onMount(() => {
    if (!models().length) loadModels();
  });
  const [health] = createResource(() => api.health());
  const set = <K extends keyof Settings>(key: K, value: Partial<Settings[K]>) =>
    updateSettings((s) => ({ ...s, [key]: typeof value === "object" ? { ...(s[key] as object), ...value } : value }));
  const setTheme = (value: Partial<GlobalTheme>) => set("theme", value);
  const theme = () => settings().theme;

  return (
    <div {...stylex.attrs(styles.page)} data-settings>
      <header {...stylex.attrs(styles.header)}>
        <h1 {...stylex.attrs(styles.title)}>
          <Icon name="settings" size={24} {...stylex.attrs(styles.accent)} />
          Settings
        </h1>
        <p {...stylex.attrs(styles.muted)}>Changes are saved automatically.</p>
      </header>

      <Section title="Appearance" icon="palette">
        <Row label="Theme presets" description="A starting point; tweak the colors below." wide>
          <div {...stylex.attrs(styles.presets)}>
            <For each={themePresets}>
              {(preset) => (
                <PresetButton
                  name={preset.name}
                  theme={{ mode: theme().mode, ...preset.theme }}
                  onClick={() => updateSettings((s) => ({ ...s, theme: { mode: s.theme.mode, ...preset.theme } }))}
                />
              )}
            </For>
          </div>
        </Row>
        <Row label="Mode">
          <Segmented
            value={theme().mode}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
            onChange={(mode) => setTheme({ mode })}
          />
        </Row>
        <Row label="Accent color">
          <ColorField value={theme().accent} onChange={(accent) => setTheme({ accent })} />
        </Row>
        <Row label="Background">
          <ColorField value={theme().background} onChange={(background) => setTheme({ background })} />
        </Row>
        <Row label="Surfaces" description="Cards, inputs, panels.">
          <ColorField value={theme().surface} onChange={(surface) => setTheme({ surface })} />
        </Row>
        <Row label="Text">
          <ColorField value={theme().text} onChange={(text) => setTheme({ text })} />
        </Row>
        <Row label="Corners">
          <Segmented
            value={theme().radius ?? "md"}
            options={[
              ["none", "Square"],
              ["sm", "Subtle"],
              ["md", "Rounded"],
              ["lg", "Round"],
            ]}
            onChange={(radius) => setTheme({ radius })}
          />
        </Row>
        <Row label="Font">
          <Segmented
            value={theme().font ?? "sans"}
            options={[
              ["sans", "Sans"],
              ["serif", "Serif"],
              ["mono", "Mono"],
              ["rounded", "Rounded"],
            ]}
            onChange={(font) => setTheme({ font })}
          />
        </Row>
        <Row label="App themes" description="Let apps use a look their agent picked instead of your theme.">
          <Toggle checked={settings().appThemes} onChange={(appThemes) => updateSettings((s) => ({ ...s, appThemes }))} />
        </Row>
      </Section>

      <Section title="Agent" icon="bot">
        <Row label="Default model" description="For new tabs. Each tab remembers its own choice.">
          <Select
            value={settings().agent.model ?? ""}
            onChange={(e) => set("agent", { model: e.currentTarget.value || null, effort: null })}
            xstyle={styles.select}
          >
            <option value="">Claude Code default</option>
            <For each={models().filter((m) => m.value !== "default")}>{(m) => <option value={m.value}>{m.displayName}</option>}</For>
          </Select>
        </Row>
        <Row label="Default effort">
          <Select
            value={settings().agent.effort ?? ""}
            onChange={(e) => set("agent", { effort: (e.currentTarget.value || null) as Effort | null })}
            xstyle={styles.select}
          >
            <option value="">Model default</option>
            <For each={models().find((m) => m.value === (settings().agent.model ?? "default"))?.efforts ?? []}>
              {(level) => <option value={level}>{effortLabels[level]}</option>}
            </For>
          </Select>
        </Row>
        <Row
          label="Instructions for building apps"
          description="Added to the app builder's prompt in every tab, e.g. your language, currency, style preferences."
          wide
        >
          <TextArea
            value={settings().agent.instructions}
            placeholder={"e.g. Answer in German. Amounts are in EUR. Prefer dark themes with a green accent."}
            onInput={(instructions) => set("agent", { instructions })}
            name="instructions"
          />
        </Row>
        <Row label="Instructions for customizing websites" description="Added to the website agent's prompt." wide>
          <TextArea
            value={settings().agent.webInstructions}
            placeholder={"e.g. Keep changes minimal. Never hide ads by removing content the page needs."}
            onInput={(webInstructions) => set("agent", { webInstructions })}
            name="webInstructions"
          />
        </Row>
        <Row label="Show tool activity" description='Lines like "Updated app" or "Added 3 rows" in the chat.'>
          <Toggle checked={settings().agent.showToolMessages} onChange={(showToolMessages) => set("agent", { showToolMessages })} />
        </Row>
      </Section>

      <Section title="Web tabs" icon="globe">
        <Row label="Home page" description="Opened by new web tabs.">
          <input
            value={settings().web.homePage}
            onChange={(e) => set("web", { homePage: e.currentTarget.value.trim() || "about:blank" })}
            {...stylex.attrs(styles.textInput)}
          />
        </Row>
        <Row label="Search engine" description="Used when the address bar input isn't a URL.">
          <Select
            value={settings().web.searchEngine}
            onChange={(e) => set("web", { searchEngine: e.currentTarget.value as Settings["web"]["searchEngine"] })}
            xstyle={styles.select}
          >
            <For each={Object.entries(searchEngines)}>{([key, engine]) => <option value={key}>{engine.label}</option>}</For>
          </Select>
        </Row>
        <Row label="Site customizations" description="Apply the CSS/JS changes the agent made to websites.">
          <Toggle checked={settings().web.overrides} onChange={(overrides) => set("web", { overrides })} />
        </Row>
      </Section>

      <Section title="App backends" icon="server">
        <Row label="Start automatically" description="Start an app's custom backend when you open the app.">
          <Toggle checked={settings().backends.autoStart} onChange={(autoStart) => set("backends", { autoStart })} />
        </Row>
      </Section>

      <Section title="About" icon="info">
        <dl {...stylex.attrs(styles.about)}>
          <dt>Data folder</dt>
          <dd {...stylex.attrs(styles.dd, styles.mono)}>{health()?.dataDir ?? "…"}</dd>
          <dt>Versions</dt>
          <dd {...stylex.attrs(styles.dd, styles.mono)}>
            Electron {window.gapp.versions.electron} · Chrome {window.gapp.versions.chrome} · Bun {health()?.bun ?? "…"}
          </dd>
        </dl>
      </Section>
    </div>
  );
}

function Section(props: { title: string; icon: string; children: JSX.Element }) {
  return (
    <section {...stylex.attrs(styles.section)}>
      <h2 {...stylex.attrs(styles.sectionTitle)}>
        <Icon name={props.icon} size={18} {...stylex.attrs(styles.accent)} />
        {props.title}
      </h2>
      <div {...stylex.attrs(styles.rows)}>{props.children}</div>
    </section>
  );
}

function Row(props: { label: string; description?: string; wide?: boolean; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.row, props.wide && styles.rowWide)}>
      <div {...stylex.attrs(styles.rowText, props.wide && styles.rowTextWide)}>
        <span {...stylex.attrs(styles.rowLabel)}>{props.label}</span>
        <Show when={props.description}>
          <span {...stylex.attrs(styles.muted)}>{props.description}</span>
        </Show>
      </div>
      <div {...stylex.attrs(styles.control, props.wide && styles.controlWide)}>{props.children}</div>
    </div>
  );
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div {...stylex.attrs(styles.segmented)} role="radiogroup">
      <For each={props.options}>
        {([value, label]) => {
          const active = () => props.value === value;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active()}
              onClick={() => props.onChange(value)}
              {...stylex.attrs(styles.segment, active() && styles.segmentActive)}
            >
              {label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      {...stylex.attrs(styles.toggle, props.checked && styles.toggleOn)}
    >
      <span {...stylex.attrs(styles.knob, props.checked && styles.knobOn)} />
    </button>
  );
}

function ColorField(props: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  return (
    <div {...stylex.attrs(styles.colorField)}>
      <input
        type="color"
        value={props.value ?? "#808080"}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        {...stylex.attrs(styles.swatchInput)}
      />
      <span {...stylex.attrs(styles.mono, styles.colorValue)}>{props.value ?? "Default"}</span>
      <Show when={props.value}>
        <button type="button" onClick={() => props.onChange(undefined)} {...stylex.attrs(styles.linkButton)}>
          Reset
        </button>
      </Show>
    </div>
  );
}

function TextArea(props: { value: string; placeholder?: string; name?: string; onInput: (value: string) => void }) {
  return (
    <textarea
      name={props.name}
      value={props.value}
      placeholder={props.placeholder}
      rows={4}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      {...stylex.attrs(styles.textarea)}
    />
  );
}

/** A tiny preview of a preset: background, surface card, accent dot. */
function PresetButton(props: { name: string; theme: GlobalTheme; onClick: () => void }) {
  const vars = () => {
    const mode = resolveMode(props.theme, systemDark());
    const v = themeVars(props.theme, mode);
    return { bg: v[varOf(colors.bg)]!, surface: v[varOf(colors.surface)]!, accent: v[varOf(colors.accent)]!, text: v[varOf(colors.text)]! };
  };
  return (
    <button type="button" onClick={props.onClick} title={props.name} {...stylex.attrs(styles.preset)} data-preset={props.name}>
      <span {...stylex.attrs(styles.presetPreview)} style={{ "background-color": vars().bg }}>
        <span {...stylex.attrs(styles.presetCard)} style={{ "background-color": vars().surface }}>
          <span {...stylex.attrs(styles.presetDot)} style={{ "background-color": vars().accent }} />
          <span {...stylex.attrs(styles.presetLine)} style={{ "background-color": vars().text }} />
        </span>
      </span>
      <span {...stylex.attrs(styles.presetName)}>{props.name}</span>
    </button>
  );
}

const varOf = (ref: string) => /var\((--[^),\s]+)/.exec(ref)?.[1] ?? ref;

const styles = stylex.create({
  page: {
    maxWidth: 820,
    marginInline: "auto",
    padding: space.xl,
    paddingBottom: space.xxl,
    display: "flex",
    flexDirection: "column",
    gap: space.xxl,
  },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
  title: { margin: 0, display: "flex", alignItems: "center", gap: space.sm, fontSize: 28, fontWeight: 650 },
  accent: { color: colors.accent, flexShrink: 0 },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm },
  mono: { fontFamily: font.mono, fontSize: font.xs },
  dd: { margin: 0, overflowWrap: "anywhere" },
  section: { display: "flex", flexDirection: "column", gap: space.md },
  sectionTitle: { margin: 0, display: "flex", alignItems: "center", gap: space.sm, fontSize: font.xl, fontWeight: 650 },
  rows: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    flexWrap: "wrap",
  },
  rowWide: { flexDirection: "column", alignItems: "stretch" },
  rowText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 200, flex: "1 1 240px" },
  rowTextWide: { flex: "none" },
  rowLabel: { fontSize: font.md, fontWeight: 500 },
  control: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  controlWide: { width: "100%" },
  select: { width: 220 },
  textInput: {
    width: 280,
    height: 34,
    paddingInline: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    outline: "none",
    fontSize: font.sm,
  },
  textarea: {
    width: "100%",
    minHeight: 88,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    outline: "none",
    fontSize: font.sm,
    lineHeight: 1.5,
    resize: "vertical",
  },
  segmented: {
    display: "inline-flex",
    padding: 2,
    gap: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  segment: {
    height: 28,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
  segmentActive: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    color: colors.text,
    fontWeight: 500,
    boxShadow: `0 0 0 1px ${colors.border}, 0 1px 2px rgb(0 0 0 / 0.06)`,
  },
  toggle: {
    position: "relative",
    width: 38,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    cursor: "pointer",
    transition: "background-color 150ms",
  },
  toggleOn: { backgroundColor: colors.accent },
  knob: {
    position: "absolute",
    top: 3,
    left: 3,
    width: 16,
    height: 16,
    borderRadius: radius.full,
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.25)",
    transition: "transform 150ms",
  },
  knobOn: { transform: "translateX(16px)" },
  colorField: { display: "flex", alignItems: "center", gap: space.sm },
  swatchInput: {
    width: 34,
    height: 28,
    padding: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    cursor: "pointer",
  },
  colorValue: { minWidth: 64, color: colors.muted },
  linkButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontSize: font.sm,
    cursor: "pointer",
  },
  presets: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: space.sm, width: "100%" },
  preset: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.accent },
    backgroundColor: "transparent",
    cursor: "pointer",
    color: colors.text,
  },
  presetPreview: { display: "flex", alignItems: "flex-end", height: 44, padding: 6, borderRadius: radius.sm },
  presetCard: { display: "flex", alignItems: "center", gap: 4, width: "100%", height: 18, paddingInline: 4, borderRadius: 4 },
  presetDot: { width: 8, height: 8, borderRadius: radius.full, flexShrink: 0 },
  presetLine: { height: 3, flex: 1, borderRadius: 2, opacity: 0.6 },
  presetName: { fontSize: font.xs },
  about: {
    margin: 0,
    paddingBlock: space.md,
    paddingInline: space.lg,
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: space.sm,
    columnGap: space.lg,
    fontSize: font.sm,
  },
});
