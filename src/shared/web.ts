// Helpers for web tabs shared by the renderer and the website agent.
import { searchEngines, type Settings } from "./settings";

/** Computed styles reported for picked and inspected elements. */
export const inspectedStyles = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
] as const;

export function hostOf(url: string | null | undefined) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Turns address bar input into a URL: URLs stay as they are, things that look
 * like a domain get https:// (http:// for local addresses), anything else is
 * searched for.
 */
export function normalizeUrl(input: string, engine: Settings["web"]["searchEngine"] = "duckduckgo") {
  const text = input.trim();
  if (!text) return "";
  if (/^(https?:\/\/|about:)/i.test(text)) return text;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(text);
  if (local) return `http://${text}`;
  const looksLikeHost = !/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text);
  if (looksLikeHost) return `https://${text}`;
  return searchEngines[engine].url.replace("%s", encodeURIComponent(text));
}

/**
 * Wraps a site override's JavaScript for injection. It runs once per page load;
 * `onElement(selector, fn)` calls `fn` for every matching element, now and
 * whenever the page adds more (single-page apps re-render all the time).
 * Evaluates to an error message or null.
 */
export function overrideScript(js: string) {
  return `(() => {
  const onElement = (selector, fn) => {
    const seen = new WeakSet();
    let queued = false;
    const run = () => {
      queued = false;
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        try { fn(el); } catch (e) { console.error("[gApp override]", e); }
      }
    };
    run();
    new MutationObserver(() => {
      if (!queued) { queued = true; requestAnimationFrame(run); }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  try {
${js}
  } catch (e) {
    console.error("[gApp override]", e);
    return String((e && e.stack) || e);
  }
  return null;
})()`;
}
