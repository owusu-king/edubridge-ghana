import "server-only";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Queryable } from "../db/client";
import { parentSessions, pushSubscriptions } from "../db/schema";
import { DomainError } from "../errors";
import { vapidPublicKey } from "../notifications/providers";
import type { ParentSession } from "./sessions";

/**
 * Web push for families (R3-2, PSH-01). A parent turns notifications on in the parent view, on each phone;
 * the subscription belongs to that sign-in and ends with it. Schools send to a family's phones only while
 * the number is still a guardian there (worked out when sending, like everything in the parent view).
 */

const base64url = z
  .string()
  .min(10)
  .regex(/^[A-Za-z0-9_-]+=*$/, "Not a push key.");

export const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((v) => v.startsWith("https://"), "Not a push endpoint."),
  keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }),
});

/** Whether web push is set up on this deployment (the parent view hides the switch otherwise). */
export function pushAvailable(): boolean {
  return vapidPublicKey() !== null;
}

export function pushPublicKey(): string | null {
  return vapidPublicKey();
}

/**
 * Saves this phone's subscription for the signed-in parent. The same browser signing in again (or as
 * another number) moves the subscription to the new sign-in, so it never reaches the earlier family.
 */
export async function savePushSubscription(
  database: Database,
  session: ParentSession,
  input: unknown,
): Promise<void> {
  if (!pushAvailable()) throw new DomainError("push_unavailable", "Notifications are not available yet.");
  const data = subscriptionSchema.parse(input);
  await database
    .insert(pushSubscriptions)
    .values({
      parentSessionId: session.sessionId,
      phone: session.phone,
      endpoint: data.endpoint,
      p256dh: data.keys.p256dh,
      auth: data.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        parentSessionId: session.sessionId,
        phone: session.phone,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        createdAt: sql`now()`,
      },
    });
}

/** Turns notifications off on this phone (only the signed-in parent's own subscription). */
export async function removePushSubscription(
  database: Database,
  session: ParentSession,
  endpoint: unknown,
): Promise<void> {
  const parsed = z.string().max(1000).safeParse(endpoint);
  if (!parsed.success) return;
  await database
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, parsed.data),
        eq(pushSubscriptions.parentSessionId, session.sessionId),
      ),
    );
}

/** How many phones have notifications on for this sign-in. */
export async function countPushDevices(database: Database, session: ParentSession): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.parentSessionId, session.sessionId));
  return row?.n ?? 0;
}

/** Live subscriptions (signed-in phones) for these numbers, for a school sending to its families. */
export async function pushSubscriptionsFor(
  tx: Queryable,
  phones: readonly string[],
  now = new Date(),
): Promise<{ id: string; phone: string }[]> {
  if (phones.length === 0) return [];
  return tx
    .select({ id: pushSubscriptions.id, phone: pushSubscriptions.phone })
    .from(pushSubscriptions)
    .innerJoin(parentSessions, eq(parentSessions.id, pushSubscriptions.parentSessionId))
    .where(and(inArray(pushSubscriptions.phone, [...phones]), gt(parentSessions.expiresAt, now)))
    .then((rows) => rows.map((r) => ({ id: r.id, phone: r.phone! })));
}
