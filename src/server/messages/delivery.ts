import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { notificationOutbox, smsUsage, students } from "../db/schema";
import type { TenantContext } from "../tenancy/service";

/**
 * Delivery report (R3 notification foundation): what happened to the SMS the school paid for recently, by
 * kind, and the latest that could not be delivered with the reason. Built from the school's own usage
 * records (row-level security), joined to the outbox for each message's state; message text is never kept.
 *
 * "Sent" means the SMS provider accepted the message. Handset delivery receipts are not recorded yet: they
 * need the provider's delivery callbacks, which have not been verified against its documentation.
 */

export const SMS_KIND_LABELS: Record<(typeof smsUsage.$inferSelect)["kind"], string> = {
  fee_reminder: "Fee reminders",
  parent_code: "Parent sign-in codes",
  absence_alert: "Absence SMS",
  payment_receipt: "Payment receipts",
  announcement: "Announcements",
  portal_invitation: "Parent-view invitations",
  fees_billed: "Fees billed",
  application_code: "Online application codes",
  consent_request: "Consent forms",
  event_reminder: "Event reminders",
};

export interface DeliveryRow {
  kind: keyof typeof SMS_KIND_LABELS;
  sent: number;
  waiting: number;
  failed: number;
  /** SMS segments charged (sent and waiting by SMS; failed messages are not charged). */
  segments: number;
  /** Of those sent, how many went by WhatsApp (WAB-01), and how many WhatsApp confirmed delivered (NOT-07). */
  whatsapp: number;
  delivered: number;
}

export interface FailedMessage {
  kind: keyof typeof SMS_KIND_LABELS;
  /** The number with all but the last three digits hidden. */
  recipient: string;
  student: string | null;
  reason: string | null;
  queuedAt: Date;
}

export interface DeliveryReport {
  days: number;
  rows: DeliveryRow[];
  failures: FailedMessage[];
}

/** "+233245550101" → "+233 ••• ••• 101". */
export function maskNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  const country = phone.startsWith("+") ? `+${digits.slice(0, 3)} ` : "";
  return `${country}••• ••• ${digits.slice(-3)}`;
}

export async function getDeliveryReport(
  database: Database,
  ctx: TenantContext,
  days = 30,
): Promise<DeliveryReport> {
  assertAllowed(ctx, "plan.view");
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      const since = new Date(Date.now() - days * 86_400_000);
      const grouped = await tx
        .select({
          kind: smsUsage.kind,
          status: notificationOutbox.status,
          n: sql<number>`count(*)::int`,
          segments: sql<number>`sum(case when ${notificationOutbox.sentVia} = 'whatsapp' then 0 else ${smsUsage.segments} end)::int`,
          whatsapp: sql<number>`count(*) filter (where ${notificationOutbox.sentVia} = 'whatsapp')::int`,
          delivered: sql<number>`count(*) filter (where ${notificationOutbox.deliveredAt} is not null)::int`,
        })
        .from(smsUsage)
        .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
        .where(and(eq(smsUsage.tenantId, ctx.tenant.id), gte(smsUsage.createdAt, since)))
        .groupBy(smsUsage.kind, notificationOutbox.status);
      const rows: DeliveryRow[] = (Object.keys(SMS_KIND_LABELS) as DeliveryRow["kind"][])
        .map((kind) => {
          const of = grouped.filter((g) => g.kind === kind);
          const sum = (
            test: (s: string) => boolean,
            field: "n" | "segments" | "whatsapp" | "delivered" = "n",
          ) => of.filter((g) => test(g.status)).reduce((a, g) => a + g[field], 0);
          return {
            kind,
            sent: sum((s) => s === "sent"),
            waiting: sum((s) => s === "pending" || s === "sending"),
            failed: sum((s) => s === "failed"),
            segments: sum((s) => s !== "failed", "segments"),
            whatsapp: sum((s) => s === "sent", "whatsapp"),
            delivered: sum((s) => s === "sent", "delivered"),
          };
        })
        .filter((r) => r.sent + r.waiting + r.failed > 0);
      const failed = await tx
        .select({
          kind: smsUsage.kind,
          recipient: notificationOutbox.recipient,
          reason: notificationOutbox.lastError,
          queuedAt: smsUsage.createdAt,
          firstName: students.firstName,
          lastName: students.lastName,
        })
        .from(smsUsage)
        .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
        .leftJoin(students, eq(students.id, smsUsage.studentId))
        .where(
          and(
            eq(smsUsage.tenantId, ctx.tenant.id),
            gte(smsUsage.createdAt, since),
            eq(notificationOutbox.status, "failed"),
          ),
        )
        .orderBy(desc(smsUsage.createdAt))
        .limit(20);
      return {
        days,
        rows,
        failures: failed.map((f) => ({
          kind: f.kind,
          recipient: maskNumber(f.recipient),
          student: f.firstName ? `${f.firstName} ${f.lastName}` : null,
          reason: f.reason,
          queuedAt: f.queuedAt,
        })),
      };
    },
  );
}
