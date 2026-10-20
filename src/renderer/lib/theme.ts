// Runtime theming. StyleX compiles `defineVars` to CSS custom properties, so a
// theme is applied by overriding those properties on an element: the document
// root for the global theme, an app's container for an app theme.
import { createSignal } from "solid-js";
import type { GlobalTheme, Theme } from "../../shared/settings";
import { chartColors, colors, font, radius } from "../theme.stylex";

type Mode = "light" | "dark";

const base: Record<Mode, { bg: string; surface: string; text: string; accent: string; danger: string; success: string; warning: string }> = {
  light: { bg: "#fafafa", surface: "#ffffff", text: "#18181b", accent: "#6d4aff", danger: "#dc2626", success: "#16a34a", warning: "#d97706" },
  dark: { bg: "#111113", surface: "#18181b", text: "#ececef", accent: "#8b70ff", danger: "#f05252", success: "#3ecf73", warning: "#f5a524" },
};

const radii = {
  none: ["0px", "0px", "0px"],
  sm: ["4px", "6px", "8px"],
  md: ["6px", "10px", "14px"],
  lg: ["10px", "16px", "22px"],
} as const;

const fonts = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, "Iowan Old Style", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", system-ui, sans-serif',
} as const;

/** `var(--x1abc)` → `--x1abc` */
const varName = (ref: string) => /var\((--[^),\s]+)/.exec(ref)?.[1] ?? ref;

const mix = (a: string, b: string, pct: number) => `color-mix(in oklab, ${a}, ${b} ${pct}%)`;

/** Black or white, whichever reads better on the given hex color. */
function readableOn(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#111111" : "#ffffff";
}

/** CSS custom properties (StyleX var name → value) for a theme. */
export function themeVars(theme: Omit<Theme, "mode">, mode: Mode): Record<string, string> {
  const b = base[mode];
  const bg = theme.background ?? b.bg;
  const surface = theme.surface ?? b.surface;
  const text = theme.text ?? b.text;
  const accent = theme.accent ?? b.accent;
  const dark = mode === "dark";
  const [sm, md, lg] = radii[theme.radius ?? "md"];

  const vars: Record<string, string> = {
    [colors.bg]: bg,
    [colors.surface]: surface,
    [colors.surfaceHover]: mix(surface, text, dark ? 8 : 5),
    [colors.sidebar]: dark ? mix(bg, "#000000", 30) : mix(bg, text, 4),
    [colors.border]: mix(surface, text, dark ? 14 : 12),
    [colors.text]: text,
    [colors.muted]: mix(text, bg, 45),
    [colors.accent]: accent,
    [colors.accentText]: readableOn(accent),
    [colors.accentSoft]: mix(surface, accent, dark ? 22 : 12),
    [colors.danger]: b.danger,
    [colors.success]: b.success,
    [colors.warning]: b.warning,
    [chartColors.c1]: accent,
    [radius.sm]: sm,
    [radius.md]: md,
    [radius.lg]: lg,
    [font.sans]: fonts[theme.font ?? "sans"],
  };
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [varName(k), v]));
}

/** Like themeVars, but only for what an app theme actually sets on top of the global theme. */
export function appThemeVars(app: Theme | undefined, global: GlobalTheme, systemDark: boolean): Record<string, string> {
  if (!app || !Object.keys(app).length) return {};
  // App colors are layered over the global theme; an app that picks a mode
  // gets that mode's base palette instead of the user's custom colors.
  const merged: Omit<Theme, "mode"> = app.mode ? app : { ...global, ...app };
  const mode = app.mode ?? resolveMode(global, systemDark);
  return { ...themeVars(merged, mode), "color-scheme": mode };
}

export const resolveMode = (theme: GlobalTheme, systemDark: boolean): Mode =>
  theme.mode === "system" ? (systemDark ? "dark" : "light") : theme.mode;

// --- System preference ---------------------------------------------------------------

const media = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(media.matches);
media.addEventListener("change", (e) => setSystemDark(e.matches));
export { systemDark };

// --- Global theme ----------------------------------------------------------------------

const CACHE_KEY = "gapp.theme";
let applied: string[] = [];

/** Applies the global theme to the document root. */
export function applyGlobalTheme(theme: GlobalTheme) {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  const mode = resolveMode(theme, systemDark());
  const vars = themeVars(theme, mode);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = mode;
  applied = Object.keys(vars);
  localStorage.setItem(CACHE_KEY, JSON.stringify(theme));
}

/** Applies the last used theme before settings arrive from the server, so there is no flash. */
export function applyCachedTheme() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyGlobalTheme(JSON.parse(cached) as GlobalTheme);
  } catch {
    // ignore a corrupt cache
  }
}

/** Presets shown in Settings. */
export const themePresets: { name: string; theme: Omit<GlobalTheme, "mode"> & { mode?: GlobalTheme["mode"] } }[] = [
  { name: "Default", theme: {} },
  { name: "Ocean", theme: { accent: "#0284c7" } },
  { name: "Forest", theme: { accent: "#15803d", radius: "sm" } },
  { name: "Rose", theme: { accent: "#e11d48", radius: "lg" } },
  { name: "Amber", theme: { accent: "#d97706" } },
  { name: "Graphite", theme: { accent: "#52525b", radius: "sm" } },
  { name: "Midnight", theme: { mode: "dark", accent: "#7c9cff", background: "#0b1020", surface: "#121a2e", text: "#e3e8f7" } },
  { name: "Paper", theme: { mode: "light", accent: "#9a3412", background: "#f6f1e7", surface: "#fffdf8", text: "#2b2118", font: "serif" } },
  { name: "Terminal", theme: { mode: "dark", accent: "#22c55e", background: "#0a0a0a", surface: "#111111", text: "#d4d4d4", font: "mono", radius: "none" } },
];
