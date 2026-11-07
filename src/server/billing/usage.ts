import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client";
import { smsUsage, tenantEntitlements } from "../db/schema";

/**
 * SMS charged to schools. A row is written with each message the school pays for (fee reminders, parent
 * sign-in codes), in the same transaction that queues it; delivery comes from the outbox.
 */

/** Records a queued SMS against the school (call inside the school's tenant transaction). */
export async function recordSmsUsage(
  tx: Queryable,
  tenantId: string,
  kind: "fee_reminder" | "parent_code" | "absence_alert" | "payment_receipt" | "announcement",
  outboxId: string,
  /** The student the message is about, for their message history. */
  studentId: string | null = null,
): Promise<void> {
  await tx.insert(smsUsage).values({ tenantId, kind, outboxId, studentId });
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

/** SMS queued for the school this calendar month (in its time zone), whatever their kind. */
export async function smsUsedThisMonth(tx: Transaction, tenantId: string, timeZone: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(smsUsage)
    .where(
      and(
        eq(smsUsage.tenantId, tenantId),
        sql`(${smsUsage.createdAt} at time zone ${timeZone}) >= date_trunc('month', now() at time zone ${timeZone})`,
      ),
    );
  return row?.n ?? 0;
}

/** SMS the school may still send this month, or null when its plan has no limit. */
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
  return Math.max(0, plan.max - (await smsUsedThisMonth(tx, tenantId, timeZone)));
}
