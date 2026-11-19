import "server-only";
import { moduleActive } from "../entitlements/service";
import { and, eq, sql } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client";
import { notificationOutbox, smsTopUps, smsUsage, tenantEntitlements } from "../db/schema";
import { todayIn } from "../../lib/format";
import { WHATSAPP_KINDS } from "../notifications/whatsapp";

/**
 * SMS charged to schools. A row is written with each message the school pays for (fee reminders, parent
 * sign-in codes), in the same transaction that queues it; delivery comes from the outbox.
 */

/**
 * Records a queued SMS against the school (call inside the school's tenant transaction). Returns the
 * segments charged, which the database copies from the queued message.
 */
export async function recordSmsUsage(
  tx: Queryable,
  tenantId: string,
  kind: (typeof smsUsage.$inferInsert)["kind"],
  outboxId: string,
  /** The student the message is about, for their message history. */
  studentId: string | null = null,
): Promise<number> {
  const [row] = await tx
    .insert(smsUsage)
    .values({ tenantId, kind, outboxId, studentId })
    .returning({ segments: smsUsage.segments });
  // WAB-01: a family message the school's plan lets go by WhatsApp; the dispatcher decides per number.
  if ((WHATSAPP_KINDS as readonly string[]).includes(kind)) {
    if (await moduleActive(tx, tenantId, "whatsapp"))
      await tx
        .update(notificationOutbox)
        .set({ whatsappAllowed: true })
        .where(and(eq(notificationOutbox.id, outboxId), eq(notificationOutbox.channel, "sms")));
  }
  return row?.segments ?? 1;
}

/**
 * Records a parent sign-in code against every school that has the number on file. The request is not in
 * any one school's context, so a database function checks it is a code just queued and writes the rows.
 */
export async function recordParentCodeUsage(
  tx: Queryable,
  outboxId: string,
  tenantIds: string[],
): Promise<void> {
  if (tenantIds.length === 0) return;
  await tx.execute(
    sql`select record_parent_code_usage(${outboxId}::uuid, ${`{${tenantIds.join(",")}}`}::uuid[])`,
  );
}

/**
 * SMS segments queued for the school this calendar month (in its time zone), whatever their kind. Messages
 * that went by WhatsApp instead are not SMS and do not count.
 */
export async function smsUsedThisMonth(tx: Transaction, tenantId: string, timeZone: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${smsUsage.segments}), 0)::int` })
    .from(smsUsage)
    .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
    .where(
      and(
        eq(smsUsage.tenantId, tenantId),
        sql`${notificationOutbox.sentVia} is distinct from 'whatsapp'`,
        sql`(${smsUsage.createdAt} at time zone ${timeZone}) >= date_trunc('month', now() at time zone ${timeZone})`,
      ),
    );
  return row?.n ?? 0;
}

/** SMS segments the school may still send this month, or null when its plan has no limit. */
export async function smsAllowance(
  tx: Transaction,
  tenantId: string,
  timeZone: string,
): Promise<number | null> {
  const [plan] = await tx
    .select({ max: tenantEntitlements.maxSmsPerMonth })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  if (plan?.max === null || plan?.max === undefined) return null;
  // Top-ups added for this month raise its allowance (charged on the next invoice).
  const [extra] = await tx
    .select({ n: sql<number>`coalesce(sum(${smsTopUps.messages}), 0)::int` })
    .from(smsTopUps)
    .where(and(eq(smsTopUps.tenantId, tenantId), eq(smsTopUps.month, todayIn(timeZone).slice(0, 7))));
  return Math.max(0, plan.max + (extra?.n ?? 0) - (await smsUsedThisMonth(tx, tenantId, timeZone)));
}
