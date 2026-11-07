import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { notificationOutbox, smsUsage } from "../db/schema";
import { loadFinanceStudent } from "../fees/access";
import type { TenantContext } from "../tenancy/service";

/**
 * Every SMS sent to a student's family (COM-03): fee reminders, payment receipts and absence alerts, with
 * whether it was delivered, so staff can answer "were we told?". Message text is not kept after sending
 * (privacy): the kind, number and time are.
 */

export interface StudentMessage {
  kind: "fee_reminder" | "payment_receipt" | "absence_alert";
  recipient: string;
  /** queued: waiting or being retried; sent: accepted by the SMS provider; failed: gave up. */
  state: "queued" | "sent" | "failed";
  queuedAt: Date;
  sentAt: Date | null;
}

export async function listStudentMessages(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<StudentMessage[]> {
  assertAllowed(ctx, "students.view_all");
  if (!z.string().uuid().safeParse(studentId).success) return [];
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      if (!(await loadFinanceStudent(tx, ctx, studentId))) return [];
      const rows = await tx
        .select({
          kind: smsUsage.kind,
          recipient: notificationOutbox.recipient,
          status: notificationOutbox.status,
          queuedAt: smsUsage.createdAt,
          sentAt: notificationOutbox.sentAt,
        })
        .from(smsUsage)
        .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
        .where(and(eq(smsUsage.tenantId, ctx.tenant.id), eq(smsUsage.studentId, studentId)))
        .orderBy(desc(smsUsage.createdAt))
        .limit(50);
      return rows
        .filter((r): r is typeof r & { kind: StudentMessage["kind"] } =>
          ["fee_reminder", "payment_receipt", "absence_alert"].includes(r.kind),
        )
        .map((r) => ({
          kind: r.kind,
          recipient: r.recipient,
          state: r.status === "sent" ? "sent" : r.status === "failed" ? "failed" : "queued",
          queuedAt: r.queuedAt,
          sentAt: r.sentAt,
        }));
    },
  );
}
