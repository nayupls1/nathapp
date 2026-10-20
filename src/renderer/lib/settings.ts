// The user's settings, loaded from the server and saved back (debounced) on change.
import { createEffect, createRoot, createSignal } from "solid-js";
import { defaultSettings, type Settings } from "../../shared/settings";
import { api } from "./api";
import { applyCachedTheme, applyGlobalTheme, systemDark } from "./theme";

const [settings, setSettingsSignal] = createSignal<Settings>(defaultSettings());
const [settingsLoaded, setSettingsLoaded] = createSignal(false);
export { settings, settingsLoaded };

applyCachedTheme();

createRoot(() => {
  createEffect(() => {
    systemDark(); // re-apply when the OS switches between light and dark
    if (settingsLoaded()) applyGlobalTheme(settings().theme);
  });
});

export async function loadSettings() {
  try {
    setSettingsSignal(await api.getSettings());
  } finally {
    setSettingsLoaded(true);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Updates settings immediately in the UI and saves them shortly after. */
export function updateSettings(update: (current: Settings) => Settings) {
  const next = update(structuredClone(settings()));
  setSettingsSignal(next);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveSettings(next).catch((err) => console.error("Saving settings failed:", err));
  }, 300);
}
