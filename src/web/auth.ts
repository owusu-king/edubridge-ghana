import "server-only";
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
import { moduleForSchoolPath } from "@/lib/modules";
import { clientIpFrom } from "@/server/auth/client-ip";
import { hasMfa } from "@/server/auth/mfa";
import { db } from "@/server/db/client";
import { isPlatformAdmin } from "@/server/platform/service";
import { recordSupportView } from "@/server/support/access";
import { listUserSchools, resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { LAST_SCHOOL_COOKIE, rememberedSchool } from "./last-school";
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
  await keepDemoVisitorInDemo(session.user);
  return session;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  await keepDemoVisitorInDemo(user);
  return user;
}

/**
 * The demo visitor account is shared by everyone who presses "Try the demo school", so it stays inside its school:
 * its own account settings, invitations, the school picker and the platform area all lead back to the school.
 * (Inside the school the database refuses every change: db/context.ts.) The path comes from the proxy, which
 * always overwrites it, so a page cannot be reached by claiming another path.
 */
async function keepDemoVisitorInDemo(user: SessionUser): Promise<void> {
  if (!user.demoVisitor) return;
  const path = (await headers()).get("x-edubridge-path") ?? "";
  if (path === "/" || path.startsWith("/s/")) return;
  redirect("/");
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
    const h = await headers();
    // ENT-03: a module's own pages, their forms and downloads are "not found" unless the module is active for
    // the school, whatever the member's role. The path comes from the proxy (always overwritten), never the
    // client; pages keep their own permission checks as a second layer.
    const path = h.get("x-edubridge-path");
    const routeModule = path ? moduleForSchoolPath(path, slug) : null;
    // A read-only module (ENT-08) keeps its pages for viewing; its services refuse changes.
    const routeState = routeModule ? ctx.modules[routeModule]?.state : null;
    if (routeModule && routeState !== "active" && routeState !== "read_only") notFound();
    // The school's policy may require two-step verification for this member's roles.
    if (ctx.mfaRequired && !(await hasMfa(db(), user.id))) redirect("/account/security?required=school");
    // EduBridge support: every page opened and every form sent is recorded for the Proprietor (PLT-02).
    if (ctx.support) {
      await recordSupportView(
        db(),
        ctx,
        h.get("x-edubridge-path") ?? `/s/${slug}`,
        h.has("next-action") ? "action" : "view",
      );
    }
    return { user, ctx };
  },
);

/**
 * Which part of the product frames a person's account pages: the school they last opened (or else their
 * first school), or the platform area for a platform administrator with no school. Only schools the person
 * is a member of are used, and never while that school's two-step rule is still unmet: null then, so the
 * account pages show just the setup they need, without a way into the school before it is done (and
 * without the redirect loop requireTenant would cause here).
 */
export async function resolveAccountArea(
  user: SessionUser,
): Promise<{ kind: "school"; ctx: TenantContext } | { kind: "platform" } | null> {
  const remembered = rememberedSchool((await cookies()).get(LAST_SCHOOL_COOKIE)?.value);
  const [schools, platformAdmin, mfa] = await Promise.all([
    listUserSchools(db(), user.id),
    isPlatformAdmin(db(), user.id),
    hasMfa(db(), user.id),
  ]);
  const slug = schools.find((s) => s.slug === remembered)?.slug ?? schools[0]?.slug;
  if (slug) {
    const ctx = await resolveTenantContext(db(), slug, user.id);
    if (ctx && !ctx.support) return ctx.mfaRequired && !mfa ? null : { kind: "school", ctx };
  }
  if (platformAdmin && (process.env.PLATFORM_MFA_REQUIRED === "false" || mfa)) return { kind: "platform" };
  return null;
}

export async function signOutCurrentSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(db(), token);
  await clearSessionCookie();
}

/** Client IP (see `clientIpFrom` for which address is trusted) and user agent. */
export async function getClientInfo(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ipAddress: clientIpFrom(h), userAgent: h.get("user-agent") };
}

/** The signed-in platform administrator. Everyone else gets a 404, so the area is not disclosed. */
export const requirePlatformAdmin = cache(async (): Promise<SessionUser> => {
  const user = await requireUser();
  if (!(await isPlatformAdmin(db(), user.id))) notFound();
  // Platform administrators can reach every school, so two-step verification is required (D-03)
  // unless explicitly disabled for an environment with PLATFORM_MFA_REQUIRED=false.
  if (process.env.PLATFORM_MFA_REQUIRED !== "false" && !(await hasMfa(db(), user.id))) {
    redirect("/account/security?required=platform");
  }
  return user;
});
