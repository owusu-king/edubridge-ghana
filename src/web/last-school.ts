/**
 * The school a person last opened, so pages outside any one school (their account) can keep that school's
 * sidebar around them. Holds only the school's address (its slug): it grants nothing, and the account area
 * checks membership before using it. Set by the proxy on every school page visit.
 */
export const LAST_SCHOOL_COOKIE = "eb_last_school";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The school slug in a /s/<slug> path, when it looks like one. */
export function schoolSlugFromPath(pathname: string): string | null {
  const match = /^\/s\/([^/]+)/.exec(pathname);
  return match?.[1] && SLUG.test(match[1]) ? match[1] : null;
}

/** The remembered slug, or null for anything that is not a plain slug. */
export function rememberedSchool(value: string | undefined | null): string | null {
  return value && SLUG.test(value) ? value : null;
}

export const lastSchoolCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};
