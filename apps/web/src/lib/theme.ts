export type ThemePreference = "system" | "light" | "dark";

const storageKey = "pyai.leaderboard.theme";

/** Stored per browser only; no account or tracking. Storage may be unavailable. */
export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  try {
    if (preference === "system") window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, preference);
  } catch {
    // The preference still applies for this page view.
  }
}
