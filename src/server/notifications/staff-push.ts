import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { can, isRole, type Permission } from "../authz/permissions";
import type { Database, Queryable } from "../db/client";
import { memberships, pushSubscriptions, sessions } from "../db/schema";
import { DomainError } from "../errors";
import { subscriptionSchema, pushAvailable } from "../parents/push";

/**
 * Web push for staff (PSH-01): a member turns notifications on per device under Account; the subscription
 * belongs to that sign-in and ends with it (sign-out or expiry, by a foreign key). Like family push, a
 * notification says only what kind of thing is new and opens the page after sign-in (PSH-02).
 */

export async function saveStaffPushSubscription(
  database: Database,
  session: { sessionId: string; userId: string },
  input: unknown,
): Promise<void> {
  if (!pushAvailable()) throw new DomainError("push_unavailable", "Notifications are not available yet.");
  const data = subscriptionSchema.parse(input);
  await database
    .insert(pushSubscriptions)
    .values({
      staffSessionId: session.sessionId,
      userId: session.userId,
      endpoint: data.endpoint,
      p256dh: data.keys.p256dh,
      auth: data.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        staffSessionId: session.sessionId,
        userId: session.userId,
        parentSessionId: null,
        phone: null,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        createdAt: sql`now()`,
      },
    });
}

export async function removeStaffPushSubscription(
  database: Database,
  session: { sessionId: string },
  endpoint: unknown,
): Promise<void> {
  const parsed = z.string().max(1000).safeParse(endpoint);
  if (!parsed.success) return;
  await database
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, parsed.data),
        eq(pushSubscriptions.staffSessionId, session.sessionId),
      ),
    );
}

/**
 * Live staff devices at a school for members who may act on it (active membership whose roles grant the
 * permission), inside the school's tenant transaction.
 */
export async function staffDevicesFor(
  tx: Queryable,
  tenantId: string,
  permission: Permission,
  now = new Date(),
): Promise<string[]> {
  const rows = await tx
    .select({ id: pushSubscriptions.id, roles: memberships.roles })
    .from(pushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, pushSubscriptions.staffSessionId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, pushSubscriptions.userId), eq(memberships.tenantId, tenantId)),
    )
    .where(and(eq(memberships.status, "active"), gt(sessions.expiresAt, now)));
  return rows.filter((r) => can(r.roles.filter(isRole), permission)).map((r) => r.id);
}
