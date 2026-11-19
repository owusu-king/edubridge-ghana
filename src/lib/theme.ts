/**
 * The person's colour theme. "system" follows the device; "light" and "dark" are explicit choices, kept in a
 * cookie so the server renders the right theme on the first paint (no flash, no inline script).
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_COOKIE = "theme";

/** The explicit theme in a cookie value, or null for "follow the system" (and for anything unexpected). */
export function explicitTheme(value: string | undefined | null): "light" | "dark" | null {
  return value === "light" || value === "dark" ? value : null;
}
