const isProduction = process.env.NODE_ENV === "production";

/** `__Host-` binds the cookie to this exact origin over HTTPS; plain name for local HTTP development. */
export const SESSION_COOKIE = isProduction ? "__Host-eb_session" : "eb_session";

export function sessionCookieOptions(lifetimeMs: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(lifetimeMs / 1000),
  };
}

/** Short-lived cookie carrying a pending two-step sign-in, readable only by /login routes. */
export const MFA_COOKIE = isProduction ? "__Secure-eb_mfa" : "eb_mfa";

export function mfaCookieOptions(lifetimeMs: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict" as const,
    path: "/login",
    maxAge: Math.floor(lifetimeMs / 1000),
  };
}

/** Parent sessions (SMS code sign-in) use their own cookie, separate from staff sessions. */
export const PARENT_COOKIE = isProduction ? "__Host-eb_parent" : "eb_parent";

/** The pending parent sign-in code request, readable only by /p/login routes. */
export const PARENT_CODE_COOKIE = isProduction ? "__Secure-eb_parent_code" : "eb_parent_code";

export function parentCodeCookieOptions(lifetimeMs: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict" as const,
    path: "/p/login",
    maxAge: Math.floor(lifetimeMs / 1000),
  };
}
