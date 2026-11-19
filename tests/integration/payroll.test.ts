import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { allowed, ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { memberships, payrollLines, payrollRuns, staffSalaries } from "@/server/db/schema";
import {
  addAdjustment,
  addPayComponent,
  addSuggestedComponents,
  approvePayroll,
  cancelAdjustment,
  cancelPayroll,
  getPayrollRun,
  getPayslip,
  getStaffPay,
  listMyPayslips,
  listPayComponents,
  listPayrollRuns,
  listStaffPay,
  parsePercent,
  preparePayroll,
  setSalary,
} from "@/server/payroll/service";
import { createStaff, linkStaffMember } from "@/server/staff/records";
import { todayIn } from "@/lib/format";
import { conn, school as baseSchool, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const membershipOf = async (s: School, userId: string) => {
  const [m] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId }, (tx) =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, s.tenant.id), eq(memberships.userId, userId))),
  );
  return m!.id;
};

/** A school with components, two staff (the teacher linked to her account) and the previous month to pay. */
async function setup() {
  const s = await baseSchool();
  expect(await addSuggestedComponents(conn.app, s.bursar)).toBe(6);
  const components = await listPayComponents(conn.app, s.bursar);
  const id = (name: string) => components.find((c) => c.name === name)!.id;
  const ama = await createStaff(conn.app, s.owner, {
    firstName: "Ama",
    lastName: "Mensah",
    employmentType: "permanent",
    startedOn: "2025-09-01",
  });
  await linkStaffMember(conn.app, s.owner, ama, { membershipId: await membershipOf(s, s.teacher.userId) });
  const kofi = await createStaff(conn.app, s.owner, {
    firstName: "Kofi",
    lastName: "Boateng",
    employmentType: "casual",
    startedOn: "2025-09-01",
  });
  const today = todayIn(s.tenant.timezone);
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const lastMonth = d.toISOString().slice(0, 7);
  return { s, id, ama, kofi, lastMonth, thisMonth: today.slice(0, 7) };
}

describe("salaries and components (PRL-01)", () => {
  it("keeps the school's own components, and each person's salary as insert-only history", async () => {
    const { s, id, ama, lastMonth } = await setup();
    await expect(
      addPayComponent(conn.app, s.bursar, { name: "Bonus", kind: "earning", basis: "percent_gross" }),
    ).rejects.toThrow("An earning cannot be a share of gross pay.");
    expect(parsePercent("5.5")).toBe(550);
    expect(parsePercent("13%")).toBe(1300);
    expect(parsePercent("5.555")).toBeNull();
    expect(parsePercent("101")).toBeNull();

    await setSalary(conn.app, s.bursar, ama, {
      effectiveMonth: lastMonth,
      basic: "2500",
      components: [
        { componentId: id("Transport allowance"), value: "200" },
        { componentId: id("SSNIT (employee)"), value: "5.5" },
        { componentId: id("SSNIT (employer)"), value: "13" },
      ],
    });
    await expect(
      setSalary(conn.app, s.bursar, ama, {
        effectiveMonth: lastMonth,
        basic: "2500",
        components: [{ componentId: id("SSNIT (employee)"), value: "five" }],
      }),
    ).rejects.toThrow("SSNIT (employee): enter a percentage");
    const pay = await getStaffPay(conn.app, s.bursar, ama);
    expect(pay.salaries).toHaveLength(1);
    expect(pay.salaries[0]!.components.map((c) => [c.name, c.value])).toEqual([
      ["SSNIT (employee)", 550],
      ["Transport allowance", 200_00],
      ["SSNIT (employer)", 1300],
    ]);
    // Insert-only for every role.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.update(staffSalaries).set({ basicMinor: 1 }).where(eq(staffSalaries.staffId, ama)),
      ),
    ).rejects.toThrow();
    // Salaries are confidential: not for the Head teacher or Administrator.
    expect(allowed(s.head, "payroll.view")).toBe(false);
    await expect(listStaffPay(conn.app, s.head)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("a month's payroll (PRL-02)", () => {
  it("is prepared, recalculated, approved by the Proprietor, locked, and paid out as payslips", async () => {
    const { s, id, ama, kofi, lastMonth, thisMonth } = await setup();
    await setSalary(conn.app, s.bursar, ama, {
      effectiveMonth: lastMonth,
      basic: "2500",
      components: [
        { componentId: id("Transport allowance"), value: "200" },
        { componentId: id("SSNIT (employee)"), value: "5.5" },
        { componentId: id("SSNIT (employer)"), value: "13" },
      ],
    });
    // Kofi has no salary yet: listed for the Accountant, not paid.
    const draft = await preparePayroll(conn.app, s.bursar, { month: lastMonth });
    expect(draft).toMatchObject({ lines: 1, withoutSalary: ["Kofi Boateng"] });
    await setSalary(conn.app, s.bursar, kofi, { effectiveMonth: lastMonth, basic: "900" });
    await addAdjustment(conn.app, s.bursar, {
      staffId: kofi,
      month: lastMonth,
      kind: "earning",
      description: "Extra Saturday duty",
      amount: "100",
    });
    expect((await getPayrollRun(conn.app, s.bursar, draft.runId)).stale).toBe(true);
    // The Accountant prepares; only the Proprietor approves, and only an up-to-date draft.
    await expect(approvePayroll(conn.app, s.bursar, draft.runId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approvePayroll(conn.app, s.owner, draft.runId)).rejects.toMatchObject({ code: "run_stale" });
    await preparePayroll(conn.app, s.bursar, { month: lastMonth });
    const run = await getPayrollRun(conn.app, s.owner, draft.runId);
    expect(run.lines.map((l) => [l.staffName, l.gross, l.deductions, l.net, l.employer])).toEqual([
      ["Ama Mensah", 2_700_00, 137_50, 2_562_50, 325_00],
      ["Kofi Boateng", 1_000_00, 0, 1_000_00, 0],
    ]);
    expect(run.totals).toMatchObject({ people: 2, gross: 3_700_00, net: 3_562_50, employer: 325_00 });
    await approvePayroll(conn.app, s.owner, draft.runId);
    await expect(preparePayroll(conn.app, s.bursar, { month: lastMonth })).rejects.toMatchObject({
      code: "run_approved",
    });
    await expect(cancelPayroll(conn.app, s.bursar, draft.runId)).rejects.toMatchObject({
      code: "run_closed",
    });

    // Locked by the database, for every role.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.delete(payrollLines).where(eq(payrollLines.runId, draft.runId)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.update(payrollRuns).set({ status: "draft" }).where(eq(payrollRuns.id, draft.runId)),
      ),
    ).rejects.toThrow();

    // The adjustment was paid, once: it cannot be cancelled or paid again.
    const kofiPay = await getStaffPay(conn.app, s.bursar, kofi);
    expect(kofiPay.adjustments[0]).toMatchObject({ state: "paid", paidIn: lastMonth });
    await expect(cancelAdjustment(conn.app, s.bursar, kofiPay.adjustments[0]!.id)).rejects.toMatchObject({
      code: "adjustment_closed",
    });
    // Earlier months are approved: salary changes start later; corrections are adjustments.
    await expect(
      setSalary(conn.app, s.bursar, kofi, { effectiveMonth: lastMonth, basic: "950" }),
    ).rejects.toMatchObject({ code: "month_approved" });
    const next = await preparePayroll(conn.app, s.bursar, { month: thisMonth });
    expect(
      (await getPayrollRun(conn.app, s.bursar, next.runId)).lines.find((l) => l.staffName === "Kofi Boateng")
        ?.gross,
    ).toBe(900_00);

    // Payslips: the teacher sees her own approved one, not Kofi's, and not drafts.
    const mine = await listMyPayslips(conn.app, s.teacher);
    expect(mine).toMatchObject({ hasStaffRecord: true, payslips: [{ month: lastMonth, net: 2_562_50 }] });
    const amaLine = run.lines.find((l) => l.staffName === "Ama Mensah")!;
    const kofiLine = run.lines.find((l) => l.staffName === "Kofi Boateng")!;
    expect((await getPayslip(conn.app, s.teacher, amaLine.id))?.items.map((i) => i.name)).toContain(
      "SSNIT (employee)",
    );
    expect(await getPayslip(conn.app, s.teacher, kofiLine.id)).toBeNull();
    const draftAma = (await getPayrollRun(conn.app, s.bursar, next.runId)).lines.find(
      (l) => l.staffName === "Ama Mensah",
    )!;
    expect(await getPayslip(conn.app, s.teacher, draftAma.id)).toBeNull();
    expect((await getPayslip(conn.app, s.bursar, draftAma.id))?.status).toBe("draft");
    expect((await listPayrollRuns(conn.app, s.owner)).map((r) => [r.month, r.status])).toEqual([
      [thisMonth, "draft"],
      [lastMonth, "approved"],
    ]);
  });

  it("refuses a negative net pay, and lets a draft be cancelled and started again", async () => {
    const { s, kofi, lastMonth } = await setup();
    await setSalary(conn.app, s.bursar, kofi, { effectiveMonth: lastMonth, basic: "500" });
    await addAdjustment(conn.app, s.bursar, {
      staffId: kofi,
      month: lastMonth,
      kind: "deduction",
      description: "Salary advance",
      amount: "800",
    });
    const run = await preparePayroll(conn.app, s.bursar, { month: lastMonth });
    await expect(approvePayroll(conn.app, s.owner, run.runId)).rejects.toMatchObject({
      code: "negative_net",
    });
    await cancelPayroll(conn.app, s.bursar, run.runId);
    const again = await preparePayroll(conn.app, s.bursar, { month: lastMonth });
    expect(again.runId).not.toBe(run.runId);
    await expect(preparePayroll(conn.app, s.bursar, { month: "2999-01" })).rejects.toMatchObject({
      code: "month_future",
    });
  });
});
