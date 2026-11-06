import "server-only";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { feeReminders, ledgerEntries } from "../db/schema";
import { enqueue } from "../notifications/outbox";
import { createBalanceLink } from "../parents/balance-links";
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";
import { contactsFor, type OwingContact } from "./owing";

/**
 * SMS fee reminders to guardians, queued in the notification outbox in the same transaction as the
 * reminder record (sent if and only if it commits). At most one per student per school day. Each carries
 * the balance and a 7-day read-only balance link for the guardian it goes to.
 */

/** Large enough for a class or a filtered list in one go, small enough to stay one quick transaction. */
export const MAX_REMINDERS_PER_SEND = 200;

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

const sendSchema = z.object({
  studentIds: z
    .array(z.string().uuid())
    .min(1, "Choose at least one student.")
    .max(MAX_REMINDERS_PER_SEND, `Send at most ${MAX_REMINDERS_PER_SEND} reminders at a time.`),
});

export type SkipReason = "not_found" | "not_owing" | "no_phone" | "already_today";

export interface ReminderResult {
  sent: number;
  skipped: { studentId: string; reason: SkipReason }[];
}

export async function sendFeeReminders(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<ReminderResult> {
  assertCan(ctx.roles, "fees.remind");
  const { studentIds } = sendSchema.parse(input);
  const unique = [...new Set(studentIds)];
  const today = todayIn(ctx.tenant.timezone);

  return withTenant(database, scope(ctx), async (tx) => {
    const result: ReminderResult = { sent: 0, skipped: [] };
    const balances = new Map(
      (
        await tx
          .select({
            studentId: ledgerEntries.studentId,
            balance: sql<string>`sum(${ledgerEntries.amountPesewas})`,
          })
          .from(ledgerEntries)
          .where(and(eq(ledgerEntries.tenantId, ctx.tenant.id), inArray(ledgerEntries.studentId, unique)))
          .groupBy(ledgerEntries.studentId)
      ).map((r) => [r.studentId, Number(r.balance)]),
    );
    const contacts = await contactsFor(tx, ctx, unique);
    const sentTo: string[] = [];

    for (const studentId of unique) {
      const student = await loadFinanceStudent(tx, ctx, studentId);
      const balance = balances.get(studentId) ?? 0;
      const contact = contacts.get(studentId);
      const skip = (reason: SkipReason) => result.skipped.push({ studentId, reason });
      if (!student) skip("not_found");
      else if (balance <= 0) skip("not_owing");
      else if (!contact?.phone) skip("no_phone");
      else {
        const [reminder] = await tx
          .insert(feeReminders)
          .values({
            tenantId: ctx.tenant.id,
            studentId,
            guardianId: contact.guardianId,
            channel: "sms",
            recipient: contact.phone,
            sentOn: today,
            balancePesewas: balance,
            sentByUserId: ctx.userId,
          })
          .onConflictDoNothing()
          .returning({ id: feeReminders.id });
        if (!reminder) {
          skip("already_today");
          continue;
        }
        const balanceLinkToken = await createBalanceLink(tx, {
          tenantId: ctx.tenant.id,
          studentId,
          guardianId: contact.guardianId,
          recipient: contact.phone,
        });
        await enqueue(tx, {
          channel: "sms",
          recipient: contact.phone,
          template: "fee_reminder",
          payload: {
            schoolName: ctx.tenant.name,
            studentFirstName: student.firstName,
            balancePesewas: balance,
            balanceLinkToken,
          },
        });
        sentTo.push(studentId);
        result.sent++;
      }
    }

    if (result.sent > 0)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "fees.reminders_sent",
        entityType: "fee_reminder",
        metadata: { count: result.sent, studentIds: sentTo },
      });
    return result;
  });
}

export interface ReminderState {
  /** Who a reminder would go to; null when no guardian is recorded. */
  contact: OwingContact | null;
  lastRemindedOn: string | null;
  remindedToday: boolean;
}

/** For the student's page: who a reminder would reach, and when the family was last reminded. */
export async function getReminderState(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<ReminderState | null> {
  assertCan(ctx.roles, "fees.view");
  if (!z.string().uuid().safeParse(studentId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await loadFinanceStudent(tx, ctx, studentId))) return null;
    const contact = (await contactsFor(tx, ctx, [studentId])).get(studentId) ?? null;
    const [last] = await tx
      .select({ on: max(feeReminders.sentOn) })
      .from(feeReminders)
      .where(and(eq(feeReminders.tenantId, ctx.tenant.id), eq(feeReminders.studentId, studentId)));
    const lastRemindedOn = last?.on ?? null;
    return { contact, lastRemindedOn, remindedToday: lastRemindedOn === todayIn(ctx.tenant.timezone) };
  });
}
