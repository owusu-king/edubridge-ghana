import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { generateDemoSchool } from "../../scripts/demo/generate";
import { getCurrentTerm } from "@/server/academics/calendar";
import { getAttendanceOverview, getEnrolment } from "@/server/dashboard/school";
import { billedForTerm, getOwedToday, getTermFinance } from "@/server/dashboard/finance";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { balanceLinks, notificationOutbox, tenants, users } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { setOpeningBalance } from "@/server/fees/opening-balances";
import { listOwing } from "@/server/fees/owing";
import { listPaymentTotals, recordPayment, voidPayment } from "@/server/fees/payments";
import { sendFeeReminders } from "@/server/fees/reminders";
import { schoolsForPhone } from "@/server/parents/schools";
import { getSetupProgress } from "@/server/setup/progress";
import { addGuardian } from "@/server/students/guardians";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { attendanceRate } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { conn, school, type School } from "../support/mobile-money";
import { uniqueSlug } from "../support/fixtures";

afterAll(() => conn.close());

const pay = (s: School, studentId: string, amount: string, paidOn: string, method = "cash") =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method,
    reference: method === "cash" ? "" : `REF-${randomUUID().slice(0, 8)}`,
    paidOn,
    idempotencyKey: randomUUID(),
  });

/** Ama and Kofi in Basic 4A (Main), Esi in Basic 4B (East); GH₵1,000 each, billed. */
async function billed() {
  const s = await school();
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classA)).id;
  const esi = (await s.add("Esi", s.classB)).id;
  await setOpeningBalance(conn.app, s.bursar, kofi, { amount: "300", asOf: "2026-07-24" });
  await billTerm(conn.app, s.bursar, s.termId);
  return { s, ama, kofi, esi, today: todayIn(s.tenant.timezone) };
}

describe("fees on the school overview", () => {
  it("agrees with the fee structure, payments and owing reports, within campus scope", async () => {
    const { s, ama, kofi, esi, today } = await billed();
    await pay(s, ama, "400", "2026-09-10");
    await pay(s, kofi, "200", "2026-10-01", "bank_deposit");
    await pay(s, esi, "600", "2026-10-02", "mobile_money");
    const mistake = await pay(s, ama, "50", "2026-10-05");
    await voidPayment(conn.app, s.owner, mistake.paymentId, { reason: "Entered twice" });

    const finance = (await getTermFinance(conn.app, s.bursar, s.termId))!;
    const period = finance.period!;
    expect(period.from).toBe("2026-09-08");
    expect(finance.billedPesewas).toBe(300_000);
    expect(finance.billedPesewas).toBe(await billedForTerm(conn.app, s.bursar, s.termId));
    // The voided receipt is left out, here and in the payments report.
    expect(finance.collected!.totalPesewas).toBe(120_000);
    expect(finance.collected!.totalPesewas).toBe(
      (await listPaymentTotals(conn.app, s.bursar, period.from, period.to)).totalPesewas,
    );
    expect(finance.weeks.reduce((sum, w) => sum + w.totalPesewas, 0)).toBe(120_000);
    // Kofi's GH₵300 was owed when the term began: 1,200 of 3,300 collected.
    expect(finance.owedAtStartPesewas).toBe(30_000);
    expect(finance.collectionRate).toBe(36);
    expect(Object.fromEntries(finance.collected!.byMethod.map((m) => [m.method, m.totalPesewas]))).toEqual({
      cash: 40_000,
      bank_deposit: 20_000,
      mobile_money: 60_000,
    });

    const owed = await getOwedToday(conn.app, s.bursar);
    expect(owed.totalPesewas).toBe(210_000);
    expect(owed.totalPesewas).toBe((await listOwing(conn.app, s.bursar, {})).owedPesewas);
    expect(owed.students).toBe(3);
    expect(owed.buckets.reduce((a, b) => a + b, 0)).toBe(owed.totalPesewas);
    // Kofi's payment settled most of his brought-forward GH₵300; GH₵100 of it is still the oldest debt.
    expect(owed.buckets[3]).toBeGreaterThanOrEqual(10_000);

    // An accountant limited to East sees East's figures only, matching their owing list.
    const east = await getOwedToday(conn.app, s.eastBursar);
    expect(east.totalPesewas).toBe(40_000);
    expect(east.totalPesewas).toBe((await listOwing(conn.app, s.eastBursar, {})).owedPesewas);
    const eastFinance = (await getTermFinance(conn.app, s.eastBursar, s.termId))!;
    expect(eastFinance.collected!.totalPesewas).toBe(60_000);
    expect(eastFinance.billedPesewas).toBe(100_000);

    await expect(getTermFinance(conn.app, s.teacher, s.termId)).rejects.toThrow(ForbiddenError);
    await expect(getOwedToday(conn.app, s.teacher)).rejects.toThrow(ForbiddenError);
    expect(period.to <= today).toBe(true);
  });

  it("shows what was paid within a week of a reminder", async () => {
    const { s, ama, kofi, today } = await billed();
    for (const id of [ama, kofi])
      await addGuardian(conn.app, s.owner, id, {
        fullName: "Mother",
        phone: `024${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
        relationship: "mother",
      });
    await sendFeeReminders(conn.app, s.bursar, { studentIds: [ama, kofi] });
    await pay(s, ama, "250", today);
    const finance = (await getTermFinance(conn.app, s.bursar, s.termId))!;
    expect(finance.reminders).toEqual({ reminded: 2, paid: 1, paidPesewas: 25_000 });
  });
});

describe("setup guide", () => {
  it("follows the school's records, step by step", async () => {
    const s = await school();
    const before = (await getSetupProgress(conn.app, s.owner))!;
    expect(Object.fromEntries(Object.entries(before.steps).map(([k, v]) => [k, v.status]))).toEqual({
      calendar: "done",
      classes: "done",
      teachers: "started",
      students: "todo",
      guardians: "todo",
      fees: "started",
      assessment: "todo",
    });
    expect(before.steps.teachers.detail).toBe("0 of 2 classes have a class teacher.");

    const ama = (await s.add("Ama", s.classA)).id;
    await addGuardian(conn.app, s.owner, ama, {
      fullName: "Mother",
      phone: `024${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      relationship: "mother",
    });
    await s.add("Kofi", s.classB);
    const middle = (await getSetupProgress(conn.app, s.owner))!;
    expect(middle.steps.students.status).toBe("done");
    expect(middle.steps.guardians).toEqual({
      status: "started",
      detail: "1 of 2 students have a guardian's phone number.",
    });
    expect(middle.steps.fees.detail).toBe("Fees are set. 0 of 2 students billed this term.");
    await billTerm(conn.app, s.bursar, s.termId);
    expect((await getSetupProgress(conn.app, s.owner))!.steps.fees.status).toBe("done");

    // Shown to those who set a school up; not to teachers or the accountant.
    expect(await getSetupProgress(conn.app, s.head)).not.toBeNull();
    expect(await getSetupProgress(conn.app, s.teacher)).toBeNull();
    expect(await getSetupProgress(conn.app, s.bursar)).toBeNull();
  });
});

describe("demo schools", () => {
  it("record reminders without sending them, and stay out of the parent view", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const phone = `024${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    await addGuardian(conn.app, s.owner, ama, { fullName: "Mother", phone, relationship: "mother" });
    await billTerm(conn.app, s.bursar, s.termId);
    const e164 = normalizePhone(phone)!;
    expect((await schoolsForPhone(conn.app, e164)).map((x) => x.id)).toContain(s.tenant.id);

    await conn.owner.update(tenants).set({ isDemo: true }).where(eq(tenants.id, s.tenant.id));
    const bursar = (await resolveTenantContext(conn.app, s.tenant.slug, s.bursar.userId)) as TenantContext;
    expect(bursar.tenant.isDemo).toBe(true);
    expect((await sendFeeReminders(conn.app, bursar, { studentIds: [ama] })).sent).toBe(1);
    const queued = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(
        and(eq(notificationOutbox.recipient, e164), inArray(notificationOutbox.template, ["fee_reminder"])),
      );
    expect(queued).toHaveLength(0);
    const links = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(balanceLinks).where(eq(balanceLinks.tenantId, s.tenant.id)),
    );
    expect(links).toHaveLength(0);
    expect((await schoolsForPhone(conn.app, e164)).map((x) => x.id)).not.toContain(s.tenant.id);
  });

  it("are generated through the app's own rules, and the overview agrees with the reports", async () => {
    const slug = uniqueSlug("demo");
    const summary = await generateDemoSchool(
      { owner: conn.owner, app: conn.app },
      {
        slug,
        name: "Test Demo Academy",
        password: "a-long-demo-password",
        levels: ["Basic 4", "Basic 5"],
        studentsPerClass: 6,
        seed: 3,
      },
    );
    expect(summary.students).toBe(12);
    expect(summary.publishedClass).toBe("Basic 4");
    expect(summary.accounts.map((a) => a.email)).toContain(`teacher@${slug}.demo.test`);

    const [tenant] = await conn.owner.select().from(tenants).where(eq(tenants.slug, slug));
    expect(tenant!.isDemo).toBe(true);
    expect(tenant!.mfaRequiredRoles).toEqual([]);
    const ctx = async (email: string) => {
      const [user] = await conn.owner.select().from(users).where(eq(users.email, email));
      return (await resolveTenantContext(conn.app, slug, user!.id)) as TenantContext;
    };
    const owner = await ctx(`proprietor@${slug}.demo.test`);
    const bursar = await ctx(`accountant@${slug}.demo.test`);
    const teacher = await ctx(`teacher@${slug}.demo.test`);

    expect((await getSetupProgress(conn.app, owner))!.complete).toBe(true);
    const owed = await getOwedToday(conn.app, bursar);
    expect(owed.totalPesewas).toBe((await listOwing(conn.app, bursar, {})).owedPesewas);
    expect(owed.buckets.reduce((a, b) => a + b, 0)).toBe(owed.totalPesewas);

    const term = (await getCurrentTerm(conn.app, owner))!;
    const finance = (await getTermFinance(conn.app, bursar, term.id))!;
    expect(finance.billedPesewas).toBeGreaterThan(0);
    expect(finance.collected!.count).toBe(summary.payments);

    const enrolment = (await getEnrolment(conn.app, owner, term.id))!;
    expect(enrolment.total).toBe(12);
    expect(enrolment.female + enrolment.male).toBe(12);

    const today = todayIn("Africa/Accra");
    const attendance = (await getAttendanceOverview(conn.app, owner, term.id, today))!;
    expect(attendance.classes.map((c) => c.name)).toEqual(["Basic 4", "Basic 5"]);
    expect(attendance.classes.every((c) => c.registers === summary.registers / 2)).toBe(true);
    expect(attendance.rate).toBe(attendanceRate(attendance.totals));
    // Today's registers are left for trying out.
    expect(attendance.today).toEqual({ date: today, taken: 0, classes: 2 });
    expect(attendance.concerns.every((c) => c.rate < 80 && c.totals.open >= 5)).toBe(true);
    expect(await getAttendanceOverview(conn.app, teacher, term.id, today)).toBeNull();
  }, 180_000);
});
