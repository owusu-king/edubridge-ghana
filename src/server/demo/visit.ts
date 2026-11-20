import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { createSession, type ClientInfo } from "../auth/sessions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { demoVisitors, memberships, sessions, tenants } from "../db/schema";
import { DomainError } from "../errors";

/**
 * "Try the demo school" on the landing page (2026-11-19): a short visit to the demo school as its shared visitor
 * account, which can look at everything and change nothing (db/context.ts, web/auth.ts). Offered only when the
 * deployment names the school (DEMO_SCHOOL_SLUG) and that school is a demo with a visitor (npm run demo:visitor).
 */

/** Two hours; a demo visit is never extended (auth/sessions.ts). */
export const DEMO_VISIT_MS = 2 * 60 * 60 * 1000;
/** Visits opened from one address in an hour, so the button cannot be used to fill the sessions table. */
export const DEMO_VISITS_PER_HOUR = 20;

/** The demo school the landing page offers, from the deployment's settings; null when there is none. */
export function demoSchoolSlug(env: Record<string, string | undefined> = process.env): string | null {
  const slug = env.DEMO_SCHOOL_SLUG?.trim();
  return slug && /^[a-z0-9-]{2,63}$/.test(slug) ? slug : null;
}

/** The demo school and its visitor account, when both exist and the school is a demo; otherwise null. */
export async function findDemoVisit(
  database: Database,
  slug: string,
): Promise<{ tenantId: string; slug: string; visitorId: string } | null> {
  const [school] = await database
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.isDemo, true), eq(tenants.status, "active")))
    .limit(1);
  if (!school) return null;
  const [visitor] = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
    tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(demoVisitors, eq(demoVisitors.userId, memberships.userId))
      .where(and(eq(memberships.tenantId, school.id), eq(memberships.status, "active")))
      .limit(1),
  );
  return visitor ? { tenantId: school.id, slug, visitorId: visitor.userId } : null;
}

/** Opens a visit: a session for the visitor account that ends after two hours. */
export async function startDemoVisit(
  database: Database,
  slug: string,
  client: ClientInfo,
  now = new Date(),
): Promise<{ token: string; slug: string }> {
  const visit = await findDemoVisit(database, slug);
  if (!visit) throw new DomainError("demo_unavailable", "The demo school is not available at the moment.");
  if (client.ipAddress) {
    const [recent] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, visit.visitorId),
          eq(sessions.ipAddress, client.ipAddress),
          gt(sessions.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      );
    if ((recent?.n ?? 0) >= DEMO_VISITS_PER_HOUR)
      throw new DomainError("demo_busy", "Too many demo visits from this connection. Try again in an hour.");
  }
  const { token } = await createSession(database, visit.visitorId, client, now, DEMO_VISIT_MS);
  return { token, slug: visit.slug };
}
