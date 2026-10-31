import "server-only";
import { isIP } from "node:net";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import {
  revokeSessionToken,
  SESSION_LIFETIME_MS,
  validateSessionToken,
  type SessionUser,
  type ValidatedSession,
} from "@/server/auth/sessions";
import { hasMfa } from "@/server/auth/mfa";
import { db } from "@/server/db/client";
import { isPlatformAdmin } from "@/server/platform/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { SESSION_COOKIE, sessionCookieOptions } from "./session-cookie";

/**
 * Next.js adapter for authentication. Domain logic lives in src/server; this file only deals with
 * cookies, headers and redirects. Authorization is always re-checked here on the server — the proxy's
 * cookie check is only an optimisation.
 */

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_LIFETIME_MS));
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Current session for this request, or null. Memoised per request. */
export const getCurrentSession = cache(async (): Promise<ValidatedSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(db(), token);
});

export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await getCurrentSession())?.user ?? null;
}

export async function requireSession(): Promise<ValidatedSession> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * The signed-in user's context in a school. Responds 404 when the school does not exist or the user
 * is not a member, so school existence is not disclosed.
 */
export const requireTenant = cache(
  async (slug: string): Promise<{ user: SessionUser; ctx: TenantContext }> => {
    const user = await requireUser();
    const ctx = await resolveTenantContext(db(), slug, user.id);
    if (!ctx) notFound();
    return { user, ctx };
  },
);

export async function signOutCurrentSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(db(), token);
  await clearSessionCookie();
}

/**
 * Client IP and user agent. X-Forwarded-For is only trustworthy behind a reverse proxy that
 * overwrites it, which production must have.
 * Invalid values are discarded (the column type is inet).
 */
export async function getClientInfo(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "";
  return { ipAddress: isIP(forwarded) ? forwarded : null, userAgent: h.get("user-agent") };
}

/** The signed-in platform administrator. Everyone else gets a 404, so the area is not disclosed. */
export const requirePlatformAdmin = cache(async (): Promise<SessionUser> => {
  const user = await requireUser();
  if (!(await isPlatformAdmin(db(), user.id))) notFound();
  // Platform administrators can reach every school: two-step verification is mandatory (D-03).
  if (!(await hasMfa(db(), user.id))) redirect("/account/security?required=platform");
  return user;
});
