import { NextResponse, type NextRequest } from "next/server";
import { SESSION_LIFETIME_MS } from "@/server/auth/policy";
import { SESSION_COOKIE, sessionCookieOptions } from "@/web/session-cookie";

const PUBLIC_PATHS = ["/login"];

/**
 * Optimistic routing only — no database access. Real session validation happens on the server in
 * src/web/auth.ts. Responsibilities:
 *  1. Send visitors without a session cookie to /login, remembering where they were going.
 *  2. Refresh the cookie's expiry on navigation; the database row remains the source of truth.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const isPublic = PUBLIC_PATHS.includes(pathname);

  if (!token) {
    if (isPublic) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  if (request.method === "GET")
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_LIFETIME_MS));
  return response;
}

export const config = {
  matcher: [
    "/((?!api/|_next/|icons/|manifest.webmanifest|icon.svg|apple-icon.png|favicon.ico|robots.txt).*)",
  ],
};
