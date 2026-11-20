/**
 * The person's colour theme. "system" follows the device; "light" and "dark" are explicit choices, kept in a
 * cookie so the server renders the right theme on the first paint (no flash, no inline script).
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_COOKIE = "theme";

/** The canvas colour of each theme (globals.css): the browser's and an installed window's title-bar colour. */
export const THEME_CANVAS = { light: "#f7f6f3", dark: "#111113" } as const;

/** The explicit theme in a cookie value, or null for "follow the system" (and for anything unexpected). */
export function explicitTheme(value: string | undefined | null): "light" | "dark" | null {
  return value === "light" || value === "dark" ? value : null;
}

/**
 * The device's own light or dark setting, as Chrome and Edge report it when asked (the Sec-CH-Prefers-Color-Scheme
 * client hint, requested by the proxy). Lets the server give an installed app's title bar the right single colour
 * for "System", which some installed windows need: they take the first of a light and a dark colour, not the one for
 * the device's setting. Null when the browser does not say.
 */
export const SCHEME_HINT = "sec-ch-prefers-color-scheme";
export function hintedScheme(value: string | undefined | null): "light" | "dark" | null {
  const v = value?.replace(/"/g, "").trim();
  return v === "light" || v === "dark" ? v : null;
}
