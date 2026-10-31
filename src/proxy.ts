import { NextResponse, type NextRequest } from "next/server";
import { SESSION_LIFETIME_MS } from "@/server/auth/policy";
import { buildCsp } from "@/web/csp";
import { SESSION_COOKIE, sessionCookieOptions } from "@/web/session-cookie";

const PUBLIC_PATHS = ["/login", "/login/verify"];
const PUBLIC_PREFIXES = ["/invite/"];

/**
 * No database access here: real session validation happens on the server in src/web/auth.ts.
 *  1. Send visitors without a session cookie to /login, remembering where they were going.
 *  2. Refresh the cookie's expiry on navigation; the database row remains the source of truth.
 *  3. Attach a nonce-based Content-Security-Policy to every page.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  const isPublic = PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  if (!token && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  if (token && request.method === "GET") {
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_LIFETIME_MS));
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api/|_next/|icons/|manifest.webmanifest|icon.svg|apple-icon.png|favicon.ico|robots.txt).*)",
  ],
};
