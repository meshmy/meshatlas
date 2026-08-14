import { getStoredValue } from "./sidebarSettings";

export type Theme = "day" | "night";

const THEME_TOGGLE_ID = "theme-toggle";

/** Stored "theme-toggle" checkbox state (from the shared sidebar-settings
 * blob -- see sidebarSettings.ts) if the user has ever actually flipped the
 * toggle, else the OS's prefers-color-scheme. Deliberately not persisting
 * the matchMedia fallback: leaving it unsaved means the app keeps following
 * OS light/dark scheduling on later visits until the user picks explicitly. */
export function resolveInitialTheme(): Theme {
  const stored = getStoredValue(THEME_TOGGLE_ID);
  const isDay = typeof stored === "boolean" ? stored : matchMedia("(prefers-color-scheme: light)").matches;
  return isDay ? "day" : "night";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
