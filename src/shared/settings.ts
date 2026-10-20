// User settings (Settings tab) and the theme shape shared by the global theme
// and per-app themes chosen by the agent.
import { z } from "zod";
import { efforts } from "./api";

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex color like "#6d4aff"');

export const Radius = z.enum(["none", "sm", "md", "lg"]);
export const FontStyle = z.enum(["sans", "serif", "mono", "rounded"]);

/** Visual theme. Unset fields fall back to the base palette of the mode. */
export const Theme = z.object({
  mode: z.enum(["light", "dark"]).optional(),
  accent: HexColor.optional(),
  background: HexColor.optional(),
  surface: HexColor.optional(),
  text: HexColor.optional(),
  radius: Radius.optional(),
  font: FontStyle.optional(),
});
export type Theme = z.infer<typeof Theme>;

export const GlobalTheme = Theme.extend({ mode: z.enum(["system", "light", "dark"]).default("system") });
export type GlobalTheme = z.infer<typeof GlobalTheme>;

export const searchEngines = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { label: "Google", url: "https://www.google.com/search?q=%s" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=%s" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  kagi: { label: "Kagi", url: "https://kagi.com/search?q=%s" },
} as const;
export const SearchEngine = z.enum(Object.keys(searchEngines) as [keyof typeof searchEngines, ...(keyof typeof searchEngines)[]]);

export const Settings = z.object({
  theme: GlobalTheme.prefault({}),
  /** Let apps use the theme their agent picked instead of the global one. */
  appThemes: z.boolean().default(true),
  agent: z
    .object({
      /** Defaults for new tabs; null = Claude Code's default. */
      model: z.string().nullable().default(null),
      effort: z.enum(efforts).nullable().default(null),
      /** Appended to the app builder's system prompt. */
      instructions: z.string().max(10_000).default(""),
      /** Appended to the website agent's system prompt. */
      webInstructions: z.string().max(10_000).default(""),
      /** Show tool activity ("Updated app", "Added 3 rows") in the chat. */
      showToolMessages: z.boolean().default(true),
    })
    .prefault({}),
  web: z
    .object({
      homePage: z.string().default("https://duckduckgo.com"),
      searchEngine: SearchEngine.default("duckduckgo"),
      /** Apply site customizations (CSS/JS overrides) in web tabs. */
      overrides: z.boolean().default(true),
    })
    .prefault({}),
  backends: z
    .object({
      /** Start an app's custom backend when the app is opened. */
      autoStart: z.boolean().default(true),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof Settings>;

export const defaultSettings = (): Settings => Settings.parse({});
