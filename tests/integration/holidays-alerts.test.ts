import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import { addHolidays, listHolidays, removeHoliday } from "@/server/academics/holidays";
import { saveAbsenceAlertSettings } from "@/server/attendance/alerts";
import { listRegisters, syncRegister } from "@/server/attendance/registers";
import { updatePlatformSettings } from "@/server/billing/settings";
import {
  getBillingOverview,
  getSchoolBilling,
  markSubscriptionInvoicePaid,
  updateSubscription,
} from "@/server/billing/subscriptions";
import { withTenant } from "@/server/db/context";
import {
  absenceAlerts,
  academicYears,
  notificationOutbox,
  smsUsage,
  subscriptionInvoices,
  terms,
} from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { sendFeeReminders } from "@/server/fees/reminders";
import { addGuardian } from "@/server/students/guardians";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { monthOf } from "@/lib/plan";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const fresh = (s: School, c: TenantContext) =>
  resolveTenantContext(conn.app, s.tenant.slug, c.userId) as Promise<TenantContext>;

/** A school whose current term runs around today, with Ama (guardian phone) and Kofi in Basic 4A. */
async function setUp() {
  const s = await school();
  const today = todayIn(s.tenant.timezone);
  await asSchool(s, async (tx) => {
    await tx
      .update(terms)
      .set({ startsOn: addDays(today, -60), endsOn: addDays(today, 60) })
      .where(eq(terms.id, s.termId));
    await tx
      .update(academicYears)
      .set({ startsOn: addDays(today, -60), endsOn: addDays(today, 60) })
      .where(eq(academicYears.tenantId, s.tenant.id));
  });
  const teacher = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: teacher.membershipId,
  });
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classA)).id;
  const phone = `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
  await addGuardian(conn.app, s.owner, ama, { fullName: "Ama's mother", phone, relationship: "mother" });
  return { s, today, ama, kofi };
}

const take = (
  s: School,
  ctx: TenantContext,
  date: string,
  marks: Record<string, "present" | "absent" | "excused">,
) =>
  syncRegister(conn.app, ctx, {
    classId: s.classA,
    date,
    source: "online",
    // First marks on each day: version 0. Changes later in a test pass their own version.
    marks: Object.entries(marks).map(([studentId, status]) => ({
      studentId,
      status,
      reason: null,
      baseVersion: 0,
    })),
  });

describe("school holidays", () => {
  it("stop registers on those days, and can be removed", async () => {
    const { s, today, ama } = await setUp();
    await addHolidays(conn.app, s.owner, [
      { name: "Mid-term break", startsOn: addDays(today, -1), endsOn: today },
    ]);
    expect((await listHolidays(conn.app, s.teacher)).map((h) => h.name)).toEqual(["Mid-term break"]);
    expect((await listRegisters(conn.app, s.teacher, today)).lock).toBe(
      "This day is a school holiday (Mid-term break). No register is taken.",
    );
    await expect(take(s, s.teacher, today, { [ama]: "present" })).rejects.toMatchObject({
      code: "register_locked",
    });
    await expect(
      addHolidays(conn.app, s.owner, [{ name: "Again", startsOn: today, endsOn: today }]),
    ).rejects.toMatchObject({ code: "holiday_overlap" });
    await expect(
      addHolidays(conn.app, s.teacher, [{ name: "Teacher's day off", startsOn: today }]),
    ).rejects.toThrow();

    const [holiday] = await listHolidays(conn.app, s.owner);
    await removeHoliday(conn.app, s.owner, holiday!.id);
    expect((await take(s, s.teacher, today, { [ama]: "present" })).applied).toBe(1);
  });
});

describe("absence SMS", () => {
  const sent = (s: School, studentId: string) =>
    asSchool(s, (tx) =>
      tx
        .select()
        .from(absenceAlerts)
        .where(and(eq(absenceAlerts.tenantId, s.tenant.id), eq(absenceAlerts.studentId, studentId))),
    );

  it("go only when a school turns them on, once per run of absences, and are charged", async () => {
    const { s, today, ama, kofi } = await setUp();
    const d1 = addDays(today, -2);
    const d2 = addDays(today, -1);
    // Off by default: nothing is sent however long the run.
    expect((await take(s, s.teacher, d1, { [ama]: "absent", [kofi]: "absent" })).alerts).toBe(0);

    await saveAbsenceAlertSettings(conn.app, s.owner, { enabled: true, consecutiveDays: 2, termDays: null });
    const second = await take(s, s.teacher, d2, { [ama]: "absent", [kofi]: "absent" });
    // Kofi has no guardian phone: nothing to send to.
    expect(second.alerts).toBe(1);
    const [alert] = await sent(s, ama);
    expect(alert).toMatchObject({ kind: "consecutive", key: d1, days: 2 });
    const [message] = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, alert!.outboxId!));
    expect(message!.template).toBe("absence_alert");
    expect(message!.payload).toMatchObject({ studentFirstName: "Ama", days: 2, kind: "consecutive" });
    const usage = await asSchool(s, (tx) =>
      tx
        .select()
        .from(smsUsage)
        .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, "absence_alert"))),
    );
    expect(usage).toHaveLength(1);
    expect((await getSchoolBilling(conn.app, s.owner)).usage[0]).toMatchObject({
      absenceAlerts: 1,
      billable: 1,
    });

    // The run goes on: no second SMS for the same run.
    expect((await take(s, s.teacher, today, { [ama]: "absent" })).alerts).toBe(0);
    expect(await sent(s, ama)).toHaveLength(1);

    // An old register corrected later never sends anything.
    await saveAbsenceAlertSettings(conn.app, s.owner, { enabled: true, consecutiveDays: 1, termDays: null });
    expect((await take(s, s.owner, addDays(today, -10), { [kofi]: "absent" })).alerts).toBe(0);
    await expect(
      saveAbsenceAlertSettings(conn.app, s.owner, { enabled: true, consecutiveDays: null, termDays: null }),
    ).rejects.toThrow("Choose at least one");
    await expect(
      saveAbsenceAlertSettings(conn.app, s.teacher, { enabled: false, consecutiveDays: 3, termDays: null }),
    ).rejects.toThrow();
  });

  it("go once a term total is reached", async () => {
    const { s, today, ama } = await setUp();
    await saveAbsenceAlertSettings(conn.app, s.owner, { enabled: true, consecutiveDays: null, termDays: 2 });
    expect((await take(s, s.teacher, addDays(today, -3), { [ama]: "absent" })).alerts).toBe(0);
    expect((await take(s, s.teacher, addDays(today, -2), { [ama]: "present" })).alerts).toBe(0);
    expect((await take(s, s.teacher, addDays(today, -1), { [ama]: "absent" })).alerts).toBe(1);
    expect((await take(s, s.teacher, today, { [ama]: "absent" })).alerts).toBe(0);
    expect((await sent(s, ama)).map((a) => [a.kind, a.days])).toEqual([["term_total", 2]]);
  });
});

describe("overdue EduBridge invoices", () => {
  /** An invoice due some days ago (written directly: the app refuses due dates in the past). */
  async function overdueInvoice(s: School, daysAgo: number) {
    const admin = await platform;
    const today = todayIn(s.tenant.timezone);
    return withTenant(conn.owner, { tenantId: s.tenant.id, userId: admin.id }, async (tx) => {
      const [row] = await tx
        .insert(subscriptionInvoices)
        .values({
          tenantId: s.tenant.id,
          invoiceNumber: `EB-TEST-${randomInt(0, 1e9)}`,
          lines: [{ description: "Plan", quantity: 1, unitPesewas: 100_000, amountPesewas: 100_000 }],
          totalPesewas: 100_000,
          currencyCode: "GHS",
          periodStartsOn: addDays(today, -30),
          periodEndsOn: today,
          issuedOn: addDays(today, -daysAgo - 14),
          dueOn: addDays(today, -daysAgo),
          createdByUserId: admin.id,
        })
        .returning({ id: subscriptionInvoices.id });
      return row!.id;
    });
  }

  it("give three days' grace, then pause SMS to families until paid", async () => {
    const { s, today, ama } = await setUp();
    await billTerm(conn.app, s.bursar, s.termId);
    const graceInvoice = await overdueInvoice(s, 2);
    let bursar = await fresh(s, s.bursar);
    expect(bursar.billing).toEqual({
      state: "grace",
      overdueSince: addDays(today, -2),
      graceEndsOn: addDays(today, 1),
    });
    expect((await sendFeeReminders(conn.app, bursar, { studentIds: [ama] })).sent).toBe(1);

    const lateInvoice = await overdueInvoice(s, 5);
    bursar = await fresh(s, s.bursar);
    expect(bursar.billing.state).toBe("limited");
    await expect(sendFeeReminders(conn.app, bursar, { studentIds: [ama] })).rejects.toMatchObject({
      code: "sms_paused",
    });
    // Absence SMS pause too, and are sent once SMS resume (nothing recorded meanwhile).
    await saveAbsenceAlertSettings(conn.app, s.owner, { enabled: true, consecutiveDays: 1, termDays: null });
    const teacher = await fresh(s, s.teacher);
    expect((await take(s, teacher, today, { [ama]: "absent" })).alerts).toBe(0);

    const admin = await platform;
    for (const id of [graceInvoice, lateInvoice])
      await markSubscriptionInvoicePaid(conn.app, admin.id, s.tenant.id, id, {
        paidOn: today,
        reference: "MOMO-1",
      });
    expect((await fresh(s, s.bursar)).billing.state).toBe("ok");

    // Staff can also pause at once by setting the status.
    await updateSubscription(conn.app, admin.id, s.tenant.id, {
      status: "past_due",
      billingPeriod: "termly",
      smsPrice: "0.04",
    });
    expect((await fresh(s, s.bursar)).billing.state).toBe("limited");
  });

  it("price SMS per school, falling back to the platform price", async () => {
    const { s } = await setUp();
    const admin = await platform;
    await updatePlatformSettings(conn.app, admin.id, { smsPrice: "0.05", graceDays: 3 });
    try {
      expect((await getSchoolBilling(conn.app, s.owner)).plan).toMatchObject({
        smsPricePesewas: 5,
        ownSmsPricePesewas: null,
      });
      await updateSubscription(conn.app, admin.id, s.tenant.id, {
        status: "active",
        billingPeriod: "termly",
        smsPrice: "0.04",
      });
      expect((await getSchoolBilling(conn.app, s.owner)).plan).toMatchObject({
        smsPricePesewas: 4,
        ownSmsPricePesewas: 4,
      });
      const row = (await getBillingOverview(conn.app, admin.id, monthOf(todayIn(s.tenant.timezone)))).find(
        (r) => r.tenantId === s.tenant.id,
      );
      expect(row).toMatchObject({ smsPricePesewas: 4, smsChargePesewas: 0 });
      await expect(
        updatePlatformSettings(conn.app, s.owner.userId, { smsPrice: "1", graceDays: 3 }),
      ).rejects.toThrow();
    } finally {
      await updatePlatformSettings(conn.app, admin.id, { smsPrice: "", graceDays: 3 });
    }
  });
});
