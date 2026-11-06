import { NextResponse, type NextRequest } from "next/server";
import { SESSION_LIFETIME_MS } from "@/server/auth/policy";
import { PARENT_SESSION_LIFETIME_MS } from "@/server/parents/policy";
import { buildCsp } from "@/web/csp";
import { PARENT_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/web/session-cookie";

const PUBLIC_PATHS = ["/login", "/login/verify", "/forgot-password", "/p/login", "/p/login/verify"];
/** Balance links (/b/) are read-only and carry their own secret. */
const PUBLIC_PREFIXES = ["/invite/", "/reset-password/", "/b/"];

/**
 * No database access here: real session validation happens on the server in src/web/auth.ts.
 *  1. Send visitors without a session cookie to sign in, remembering where they were going. The parent
 *     area (/p) has its own session cookie and sign-in page.
 *  2. Refresh the cookie's expiry on navigation; the database row remains the source of truth.
 *  3. Attach a nonce-based Content-Security-Policy to every page.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const parentArea = pathname === "/p" || pathname.startsWith("/p/");
  const cookie = parentArea ? PARENT_COOKIE : SESSION_COOKIE;
  const token = request.cookies.get(cookie)?.value;

  const isPublic = PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  if (!token && !isPublic) {
    const url = request.nextUrl.clone();
    // A parent (signed in to the parent view only) opening the site's home goes to their children.
    if (pathname === "/" && request.cookies.get(PARENT_COOKIE)) {
      url.pathname = "/p";
      return NextResponse.redirect(url);
    }
    url.pathname = parentArea ? "/p/login" : "/login";
    url.search =
      pathname === "/" || pathname === "/p" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  if (token && request.method === "GET") {
    const lifetime = parentArea ? PARENT_SESSION_LIFETIME_MS : SESSION_LIFETIME_MS;
    response.cookies.set(cookie, token, sessionCookieOptions(lifetime));
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api/|_next/|icons/|manifest.webmanifest|icon.svg|apple-icon.png|favicon.ico|robots.txt).*)",
  ],
};
