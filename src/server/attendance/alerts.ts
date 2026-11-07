import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { addDays } from "../../lib/attendance";
import { todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  absenceAlerts,
  absenceAlertSettings,
  attendanceMarks,
  attendanceRegisters,
  students,
} from "../db/schema";
import { contactsFor } from "../fees/owing";
import { enqueue } from "../notifications/outbox";
import type { TenantContext } from "../tenancy/service";

/**
 * SMS to families about absences, only when a school turns them on and only past its thresholds: a number
 * of school days absent in a row, and/or a total in a term (founder decision, 2026-11-06). Each family gets
 * at most one SMS per run of absences and one for the term total. Only "absent" counts (not excused).
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface AbsenceAlertSettings {
  enabled: boolean;
  consecutiveDays: number | null;
  termDays: number | null;
}

/** Suggested when a school first turns alerts on. */
export const DEFAULT_ALERT_SETTINGS: AbsenceAlertSettings = {
  enabled: false,
  consecutiveDays: 3,
  termDays: 10,
};

async function readSettings(tx: Transaction, tenantId: string): Promise<AbsenceAlertSettings | null> {
  const [row] = await tx
    .select({
      enabled: absenceAlertSettings.enabled,
      consecutiveDays: absenceAlertSettings.consecutiveDays,
      termDays: absenceAlertSettings.termDays,
    })
    .from(absenceAlertSettings)
    .where(eq(absenceAlertSettings.tenantId, tenantId));
  return row ?? null;
}

export async function getAbsenceAlertSettings(
  database: Database,
  ctx: TenantContext,
): Promise<AbsenceAlertSettings> {
  assertAllowed(ctx, "attendance.manage");
  return withTenant(
    database,
    scope(ctx),
    async (tx) => (await readSettings(tx, ctx.tenant.id)) ?? DEFAULT_ALERT_SETTINGS,
  );
}

const days = (max: number) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .int("Use a whole number.")
      .min(1, "Use 1 or more.")
      .max(max, `Use ${max} or fewer.`)
      .nullable(),
  );

const settingsSchema = z
  .object({
    enabled: z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean()),
    consecutiveDays: days(30),
    termDays: days(100),
  })
  .refine((v) => !v.enabled || v.consecutiveDays !== null || v.termDays !== null, {
    message: "Choose at least one: days in a row, or days in a term.",
    path: ["consecutiveDays"],
  });

export async function saveAbsenceAlertSettings(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "attendance.manage");
  const data = settingsSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const values = { ...data, updatedAt: new Date(), updatedByUserId: ctx.userId };
    await tx
      .insert(absenceAlertSettings)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: absenceAlertSettings.tenantId, set: values });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "attendance.alert_settings_saved",
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: data,
    });
  });
}

/** How many of the student's latest registers in a row they were absent, and the run's first day. */
export function absenceRun(marks: readonly { date: string; status: string }[]): {
  days: number;
  startsOn: string | null;
} {
  // Newest first.
  let days = 0;
  let startsOn: string | null = null;
  for (const m of marks) {
    if (m.status !== "absent") break;
    days++;
    startsOn = m.date;
  }
  return { days, startsOn };
}

/** Back-filled registers older than this never send alerts: families hear about absences while current. */
const RECENT_DAYS = 2;

/**
 * After a register is saved: SMS families of students whose absences have just reached a threshold. Runs in
 * the register's transaction, so an alert is queued if and only if the marks are saved. Returns how many
 * SMS were queued.
 */
export async function sendAbsenceAlerts(
  tx: Transaction,
  ctx: TenantContext,
  input: { termId: string; date: string; absentStudentIds: string[] },
): Promise<number> {
  if (input.absentStudentIds.length === 0) return 0;
  const settings = await readSettings(tx, ctx.tenant.id);
  if (!settings?.enabled) return 0;
  if (input.date < addDays(todayIn(ctx.tenant.timezone), -RECENT_DAYS)) return 0;
  // Paused while an EduBridge invoice is overdue; nothing is recorded, so the alert goes once SMS resume.
  if (ctx.billing.state === "limited") return 0;

  const contacts = await contactsFor(tx, ctx, input.absentStudentIds);
  const names = new Map(
    (
      await tx
        .select({ id: students.id, firstName: students.firstName })
        .from(students)
        .where(and(eq(students.tenantId, ctx.tenant.id), inArray(students.id, input.absentStudentIds)))
    ).map((s) => [s.id, s.firstName]),
  );
  let allowance = ctx.tenant.isDemo ? null : await smsAllowance(tx, ctx.tenant.id, ctx.tenant.timezone);
  let sent = 0;

  for (const studentId of input.absentStudentIds) {
    const marks = await tx
      .select({ date: attendanceRegisters.date, status: attendanceMarks.status })
      .from(attendanceMarks)
      .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
      .where(
        and(
          eq(attendanceMarks.tenantId, ctx.tenant.id),
          eq(attendanceMarks.studentId, studentId),
          eq(attendanceRegisters.termId, input.termId),
        ),
      )
      .orderBy(desc(attendanceRegisters.date));
    // Only when this register is the student's latest: an older register corrected later is not news.
    if (marks[0]?.date !== input.date) continue;
    const run = absenceRun(marks);
    const total = marks.filter((m) => m.status === "absent").length;

    const due: { kind: "consecutive" | "term_total"; key: string; days: number }[] = [];
    if (settings.consecutiveDays && run.days >= settings.consecutiveDays && run.startsOn)
      due.push({ kind: "consecutive", key: run.startsOn, days: run.days });
    if (settings.termDays && total >= settings.termDays)
      due.push({ kind: "term_total", key: String(settings.termDays), days: total });
    if (due.length === 0) continue;
    const already = await tx
      .select({ kind: absenceAlerts.kind, key: absenceAlerts.key })
      .from(absenceAlerts)
      .where(
        and(
          eq(absenceAlerts.tenantId, ctx.tenant.id),
          eq(absenceAlerts.studentId, studentId),
          eq(absenceAlerts.termId, input.termId),
        ),
      );
    const fresh = due.filter((d) => !already.some((a) => a.kind === d.kind && a.key === d.key));
    if (fresh.length === 0) continue;
    const contact = contacts.get(studentId);
    if (!contact?.phone) continue;
    if (allowance !== null && allowance <= 0) continue;

    // One SMS, about the run of absences if that is new, else the term total; both are recorded as sent.
    const lead = fresh[0]!;
    let outboxId: string | null = null;
    if (!ctx.tenant.isDemo) {
      outboxId = await enqueue(tx, {
        channel: "sms",
        recipient: contact.phone,
        template: "absence_alert",
        payload: {
          schoolName: ctx.tenant.name,
          studentFirstName: names.get(studentId) ?? "Your child",
          days: lead.days,
          kind: lead.kind,
        },
      });
      await recordSmsUsage(tx, ctx.tenant.id, "absence_alert", outboxId, studentId);
      if (allowance !== null) allowance--;
    }
    await tx
      .insert(absenceAlerts)
      .values(
        fresh.map((d) => ({
          tenantId: ctx.tenant.id,
          studentId,
          termId: input.termId,
          kind: d.kind,
          key: d.key,
          days: d.days,
          guardianId: contact.guardianId,
          recipient: contact.phone!,
          outboxId,
        })),
      )
      .onConflictDoNothing();
    sent++;
  }
  if (sent)
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "attendance.absence_alerts_sent",
      entityType: "attendance",
      metadata: { date: input.date, count: sent },
    });
  return sent;
}
