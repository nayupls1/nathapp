// Theme palette, shared by the renderer (Rune Browser's own look) and the server (the
// design tokens every new app starts with).
import type { GlobalTheme, Theme } from "./settings";

export type Mode = "light" | "dark";

const base: Record<
  Mode,
  { bg: string; surface: string; text: string; accent: string; danger: string; success: string; warning: string }
> = {
  light: {
    bg: "#fafafa",
    surface: "#ffffff",
    text: "#18181b",
    accent: "#6d4aff",
    danger: "#dc2626",
    success: "#16a34a",
    warning: "#d97706",
  },
  dark: {
    bg: "#111113",
    surface: "#18181b",
    text: "#ececef",
    accent: "#8b70ff",
    danger: "#f05252",
    success: "#3ecf73",
    warning: "#f5a524",
  },
};

const radii = {
  none: ["0px", "0px", "0px"],
  sm: ["4px", "6px", "8px"],
  md: ["6px", "10px", "14px"],
  lg: ["10px", "16px", "22px"],
} as const;

export const fonts = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, "Iowan Old Style", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", system-ui, sans-serif',
} as const;

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

export interface Palette {
  bg: string;
  surface: string;
  surfaceHover: string;
  sidebar: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  danger: string;
  success: string;
  warning: string;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  font: string;
}

export function palette(theme: Omit<Theme, "mode">, mode: Mode): Palette {
  const b = base[mode];
  const bg = theme.background ?? b.bg;
  const surface = theme.surface ?? b.surface;
  const text = theme.text ?? b.text;
  const accent = theme.accent ?? b.accent;
  const dark = mode === "dark";
  const [radiusSm, radiusMd, radiusLg] = radii[theme.radius ?? "md"];
  return {
    bg,
    surface,
    surfaceHover: mix(surface, text, dark ? 8 : 5),
    sidebar: dark ? mix(bg, "#000000", 30) : mix(bg, text, 4),
    border: mix(surface, text, dark ? 14 : 12),
    text,
    muted: mix(text, bg, 45),
    accent,
    accentText: readableOn(accent),
    accentSoft: mix(surface, accent, dark ? 22 : 12),
    danger: b.danger,
    success: b.success,
    warning: b.warning,
    radiusSm,
    radiusMd,
    radiusLg,
    font: fonts[theme.font ?? "sans"],
  };
}

export const resolveMode = (theme: GlobalTheme, systemDark: boolean): Mode =>
  theme.mode === "system" ? (systemDark ? "dark" : "light") : theme.mode;

function tokenBlock(p: Palette, indent: string) {
  const lines = [
    ["--color-bg", p.bg],
    ["--color-surface", p.surface],
    ["--color-surface-hover", p.surfaceHover],
    ["--color-border", p.border],
    ["--color-text", p.text],
    ["--color-muted", p.muted],
    ["--color-accent", p.accent],
    ["--color-accent-text", p.accentText],
    ["--color-accent-soft", p.accentSoft],
    ["--color-danger", p.danger],
    ["--color-success", p.success],
    ["--color-warning", p.warning],
    ["--radius-sm", p.radiusSm],
    ["--radius-md", p.radiusMd],
    ["--radius-lg", p.radiusLg],
    ["--font-sans", p.font],
    ["--font-mono", fonts.mono],
  ];
  return lines.map(([k, v]) => `${indent}${k}: ${v};`).join("\n");
}

/**
 * The design tokens a new app starts with (tokens.css): CSS custom properties
 * from the user's theme. With the "system" mode the app follows the OS between
 * light and dark, like Rune Browser does.
 */
export function tokensCss(theme: GlobalTheme): string {
  const head = `/* Design tokens. Rune Browser generated them from your theme; change them freely. */\n`;
  const shared = `\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 16px;\n  --space-5: 24px;\n  --space-6: 40px;\n  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.06);\n  --shadow-md: 0 4px 16px rgb(0 0 0 / 0.1);\n`;
  if (theme.mode !== "system") {
    return `${head}:root {\n  color-scheme: ${theme.mode};\n${tokenBlock(palette(theme, theme.mode), "  ")}${shared}}\n`;
  }
  return (
    `${head}:root {\n  color-scheme: light dark;\n${tokenBlock(palette(theme, "light"), "  ")}${shared}}\n\n` +
    `@media (prefers-color-scheme: dark) {\n  :root {\n${tokenBlock(palette(theme, "dark"), "    ")}\n  }\n}\n`
  );
}
