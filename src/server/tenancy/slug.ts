/** Top-level route segments that can never be used as a school slug. */
export const RESERVED_SLUGS = new Set([
  "api",
  "app",
  "admin",
  "auth",
  "login",
  "logout",
  "signin",
  "signup",
  "register",
  "schools",
  "account",
  "settings",
  "help",
  "support",
  "status",
  "docs",
  "design",
  "static",
  "public",
  "assets",
  "_next",
  "manifest",
  "icons",
  "favicon",
  "robots",
  "sitemap",
  "www",
  "mail",
  "billing",
  "platform",
  "offline",
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.has(slug);
}
