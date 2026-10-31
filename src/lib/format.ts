/** Default locale (docs/02 §14). Becomes per-tenant when other markets are added. */
const LOCALE = "en-GH";

export function formatDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(value);
}

export function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(value);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

const COUNTRY_NAMES = new Intl.DisplayNames([LOCALE], { type: "region" });
export function countryName(code: string): string {
  return COUNTRY_NAMES.of(code) ?? code;
}

/** Only allow same-origin relative redirects, never `//host` or absolute URLs. */
export function safeRedirectPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  return value;
}
