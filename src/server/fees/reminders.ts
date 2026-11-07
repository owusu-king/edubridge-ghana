import "server-only";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { feeReminders, ledgerEntries, schoolPreferences, tenantEntitlements, tenants } from "../db/schema";
import { readBillingState } from "../billing/state";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import { readPreferences } from "../tenancy/preferences";
import { enqueue } from "../notifications/outbox";
import { createBalanceLink } from "../parents/balance-links";
import { DomainError } from "../errors";
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

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const sendSchema = z.object({
  studentIds: z
    .array(z.string().uuid())
    .min(1, "Choose at least one student.")
    .max(MAX_REMINDERS_PER_SEND, `Send at most ${MAX_REMINDERS_PER_SEND} reminders at a time.`),
});

/** School-initiated SMS stop while an EduBridge invoice is overdue past its grace period. */
export function smsPaused(): DomainError {
  return new DomainError(
    "sms_paused",
    "SMS to families are paused because an EduBridge invoice is overdue. Everything else works as usual; SMS resume as soon as it is paid.",
  );
}

export type SkipReason = "not_found" | "not_owing" | "no_phone" | "already_today" | "sms_limit";

export interface ReminderResult {
  sent: number;
  skipped: { studentId: string; reason: SkipReason }[];
}

/** Who sends reminders: a member, or the school's automatic reminders (no user). */
export interface ReminderSender {
  tenant: Pick<TenantContext["tenant"], "id" | "name" | "timezone" | "isDemo">;
  userId: string | null;
  /** Balance links open the parent view, so they are only sent when the plan includes it. */
  withLinks: boolean;
}

/**
 * Queues one reminder per student who owes and has a phone, at most one per school day, within the plan's
 * monthly SMS limit. Shared by reminders sent by staff and the school's automatic reminders.
 */
export async function queueFeeReminders(
  tx: Transaction,
  sender: ReminderSender,
  students: readonly { id: string; firstName: string }[],
): Promise<ReminderResult & { sentTo: string[] }> {
  const { tenant } = sender;
  const result: ReminderResult & { sentTo: string[] } = { sent: 0, skipped: [], sentTo: [] };
  if (students.length === 0) return result;
  const ids = students.map((s) => s.id);
  const today = todayIn(tenant.timezone);
  const balances = new Map(
    (
      await tx
        .select({
          studentId: ledgerEntries.studentId,
          balance: sql<string>`sum(${ledgerEntries.amountPesewas})`,
        })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, tenant.id), inArray(ledgerEntries.studentId, ids)))
        .groupBy(ledgerEntries.studentId)
    ).map((r) => [r.studentId, Number(r.balance)]),
  );
  const contacts = await contactsFor(tx, { tenant }, ids);
  // The plan's monthly SMS limit: once reached, the rest are skipped (and say so).
  let allowance = tenant.isDemo ? null : await smsAllowance(tx, tenant.id, tenant.timezone);

  for (const student of students) {
    const balance = balances.get(student.id) ?? 0;
    const contact = contacts.get(student.id);
    const skip = (reason: SkipReason) => result.skipped.push({ studentId: student.id, reason });
    if (balance <= 0) skip("not_owing");
    else if (!contact?.phone) skip("no_phone");
    else if (allowance !== null && allowance <= 0) skip("sms_limit");
    else {
      const [reminder] = await tx
        .insert(feeReminders)
        .values({
          tenantId: tenant.id,
          studentId: student.id,
          guardianId: contact.guardianId,
          channel: "sms",
          recipient: contact.phone,
          sentOn: today,
          balancePesewas: balance,
          sentByUserId: sender.userId,
        })
        .onConflictDoNothing()
        .returning({ id: feeReminders.id });
      if (!reminder) {
        skip("already_today");
        continue;
      }
      result.sentTo.push(student.id);
      result.sent++;
      // Demo schools record reminders (so the flow and its outcome can be shown) but never send an SMS:
      // their guardian numbers are made up and could belong to real people.
      if (tenant.isDemo) continue;
      const balanceLinkToken = sender.withLinks
        ? await createBalanceLink(tx, {
            tenantId: tenant.id,
            studentId: student.id,
            guardianId: contact.guardianId,
            recipient: contact.phone,
          })
        : undefined;
      const outboxId = await enqueue(tx, {
        channel: "sms",
        recipient: contact.phone,
        template: "fee_reminder",
        payload: {
          schoolName: tenant.name,
          studentFirstName: student.firstName,
          balancePesewas: balance,
          balanceLinkToken,
        },
      });
      await recordSmsUsage(tx, tenant.id, "fee_reminder", outboxId, student.id);
      if (allowance !== null) allowance--;
    }
  }
  return result;
}

export async function sendFeeReminders(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<ReminderResult> {
  assertAllowed(ctx, "fees.remind");
  if (ctx.billing.state === "limited") throw smsPaused();
  const { studentIds } = sendSchema.parse(input);
  const unique = [...new Set(studentIds)];

  return withTenant(database, scope(ctx), async (tx) => {
    const found: { id: string; firstName: string }[] = [];
    const missing: ReminderResult["skipped"] = [];
    for (const studentId of unique) {
      const student = await loadFinanceStudent(tx, ctx, studentId);
      if (student) found.push({ id: student.id, firstName: student.firstName });
      else missing.push({ studentId, reason: "not_found" });
    }
    const { sentTo, ...result } = await queueFeeReminders(
      tx,
      { tenant: ctx.tenant, userId: ctx.userId, withLinks: ctx.features.includes("parent_view") },
      found,
    );
    if (result.sent > 0)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "fees.reminders_sent",
        entityType: "fee_reminder",
        metadata: { count: result.sent, studentIds: sentTo },
      });
    // Keep the order the students were asked for.
    const order = new Map(unique.map((id, i) => [id, i]));
    return {
      sent: result.sent,
      skipped: [...missing, ...result.skipped].sort(
        (x, y) => order.get(x.studentId)! - order.get(y.studentId)!,
      ),
    };
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
  assertAllowed(ctx, "fees.view");
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

/** Automatic reminders start after this hour, school time, so families are not texted at night. */
const AUTO_REMINDER_HOUR = 9;
/** At most this many automatic reminders per school per day. */
const AUTO_REMINDERS_PER_DAY = MAX_REMINDERS_PER_SEND;

/**
 * The school's automatic fee reminders (COM-02), run by the worker: once a school day after 9:00 school
 * time, to families owing at least the school's minimum who were not reminded within its interval. Same
 * rules as reminders sent by staff (one a day per student, the monthly SMS limit, no SMS while an EduBridge
 * invoice is overdue or in demo schools), recorded with no sender.
 */
export async function runAutoReminders(
  database: Database,
  now = new Date(),
): Promise<{ schools: number; sent: number }> {
  const schools = await database
    .select({ id: tenants.id, name: tenants.name, timezone: tenants.timezone, isDemo: tenants.isDemo })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), eq(tenants.isDemo, false)));
  let ran = 0;
  let sent = 0;
  for (const school of schools) {
    const local = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: school.timezone,
    }).format(now);
    if (Number(local) < AUTO_REMINDER_HOUR) continue;
    const today = todayIn(school.timezone, now);
    const result = await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      // One run per school per day, even with several workers.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"auto-reminders:" + school.id}, 0))`,
      );
      const prefs = await readPreferences(tx, school.id);
      if (!prefs.autoRemindersEnabled || prefs.autoRemindersLastRunOn === today) return null;
      const [plan] = await tx
        .select({ features: tenantEntitlements.features })
        .from(tenantEntitlements)
        .where(eq(tenantEntitlements.tenantId, school.id));
      const features = plan?.features ?? ["fee_reminders", "parent_view"];
      await tx
        .update(schoolPreferences)
        .set({ autoRemindersLastRunOn: today })
        .where(eq(schoolPreferences.tenantId, school.id));
      if (!features.includes("fee_reminders")) return 0;
      if ((await readBillingState(tx, school)).state === "limited") return 0;
      const since = addDays(today, -prefs.autoReminderIntervalDays);
      const owing = await tx.execute<{ id: string; first_name: string }>(sql`
        select s.id, s.first_name from students s
        join (select student_id, sum(amount_pesewas) as balance from ledger_entries
              where tenant_id = ${school.id} group by student_id) b on b.student_id = s.id
        where s.tenant_id = ${school.id} and s.status = 'active'
          and b.balance >= ${Math.max(1, prefs.autoReminderMinPesewas)}
          and not exists (select 1 from fee_reminders r where r.student_id = s.id and r.sent_on > ${since})
        order by b.balance desc
        limit ${AUTO_REMINDERS_PER_DAY}`);
      const queued = await queueFeeReminders(
        tx,
        { tenant: school, userId: null, withLinks: features.includes("parent_view") },
        owing.rows.map((r) => ({ id: r.id, firstName: r.first_name })),
      );
      if (queued.sent)
        await recordAudit(tx, {
          tenantId: school.id,
          actorUserId: null,
          action: "fees.reminders_sent",
          entityType: "fee_reminder",
          metadata: { count: queued.sent, automatic: true, studentIds: queued.sentTo },
        });
      return queued.sent;
    });
    if (result !== null) {
      ran++;
      sent += result;
    }
  }
  return { schools: ran, sent };
}
