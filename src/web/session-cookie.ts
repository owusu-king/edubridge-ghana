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
