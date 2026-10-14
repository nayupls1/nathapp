import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

export const colors = stylex.defineVars({
  bg: { default: "#fafafa", [DARK]: "#111113" },
  surface: { default: "#ffffff", [DARK]: "#18181b" },
  surfaceHover: { default: "#f4f4f5", [DARK]: "#232327" },
  sidebar: { default: "#f4f4f5", [DARK]: "#0c0c0e" },
  border: { default: "#e4e4e7", [DARK]: "#2a2a2f" },
  text: { default: "#18181b", [DARK]: "#ececef" },
  muted: { default: "#71717a", [DARK]: "#8b8b94" },
  accent: { default: "#6d4aff", [DARK]: "#8b70ff" },
  accentText: { default: "#ffffff", [DARK]: "#ffffff" },
  accentSoft: { default: "#efebff", [DARK]: "#272040" },
  danger: { default: "#dc2626", [DARK]: "#f05252" },
  success: { default: "#16a34a", [DARK]: "#3ecf73" },
  warning: { default: "#d97706", [DARK]: "#f5a524" },
});

/** Categorical palette for charts. */
export const chartColors = stylex.defineVars({
  c1: { default: "#6d4aff", [DARK]: "#8b70ff" },
  c2: { default: "#0ea5e9", [DARK]: "#38bdf8" },
  c3: { default: "#f97316", [DARK]: "#fb923c" },
  c4: { default: "#10b981", [DARK]: "#34d399" },
  c5: { default: "#ec4899", [DARK]: "#f472b6" },
  c6: { default: "#eab308", [DARK]: "#facc15" },
});

export const space = stylex.defineVars({
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "40px",
});

export const radius = stylex.defineVars({
  sm: "6px",
  md: "10px",
  lg: "14px",
  full: "999px",
});

export const font = stylex.defineVars({
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", monospace',
  xs: "12px",
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "20px",
  xxl: "26px",
});
