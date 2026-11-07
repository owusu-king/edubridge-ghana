import { randomInt } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listRegisters } from "@/server/attendance/registers";
import { allowed, ForbiddenError } from "@/server/authz/permissions";
import {
  getBillingOverview,
  getSchoolBilling,
  issueSubscriptionInvoice,
  markSubscriptionInvoicePaid,
  updateSubscription,
  voidSubscriptionInvoice,
} from "@/server/billing/subscriptions";
import { withTenant } from "@/server/db/context";
import { auditEvents, balanceLinks, smsUsage, subscriptionInvoices } from "@/server/db/schema";
import { DomainError } from "@/server/errors";
import { exportDataset } from "@/server/export/datasets";
import { billTerm } from "@/server/fees/ledger";
import { sendFeeReminders } from "@/server/fees/reminders";
import { mobileMoneySetup } from "@/server/mobile-money/requests";
import { schoolsForPhone } from "@/server/parents/schools";
import { requestParentCode } from "@/server/parents/sign-in";
import { NotPlatformAdminError, updateEntitlements } from "@/server/platform/service";
import { addGuardian } from "@/server/students/guardians";
import { createStudent, setStudentStatus } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { FEATURES, monthOf } from "@/lib/plan";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { ask, conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const randomPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;

/** Sets a school's plan as EduBridge staff would; returns fresh contexts. */
async function setPlan(s: School, plan: Record<string, unknown>) {
  const admin = await platform;
  await updateEntitlements(conn.app, admin.id, s.tenant.id, {
    planName: "Starter",
    maxCampuses: 2,
    maxStudents: null,
    maxSmsPerMonth: null,
    features: [...FEATURES],
    ...plan,
  });
  const ctx = async (c: TenantContext) =>
    (await resolveTenantContext(conn.app, s.tenant.slug, c.userId)) as TenantContext;
  return {
    owner: await ctx(s.owner),
    bursar: await ctx(s.bursar),
    head: await ctx(s.head),
    teacher: await ctx(s.teacher),
  };
}

async function withPhone(s: School, name: string, phone = randomPhone()) {
  const id = (await s.add(name, s.classA)).id;
  await addGuardian(conn.app, s.owner, id, { fullName: `${name}'s mother`, phone, relationship: "mother" });
  return { id, phone: normalizePhone(phone)! };
}

describe("what a plan includes", () => {
  it("is checked on the server: a module left out is refused with a clear message", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    const ama = await withPhone(s, "Ama");
    await billTerm(conn.app, s.bursar, s.termId);
    const off = await setPlan(s, { features: ["assessment"] });
    expect(off.head.features).toEqual(["assessment"]);

    expect(allowed(off.head, "attendance.take")).toBe(false);
    expect(allowed(off.head, "assessment.enter")).toBe(true);
    await expect(listRegisters(conn.app, off.head, today)).rejects.toMatchObject({
      code: "feature_not_included",
      message: "Attendance is not included in this school's plan. Ask EduBridge to add it.",
    });
    await expect(sendFeeReminders(conn.app, off.bursar, { studentIds: [ama.id] })).rejects.toMatchObject({
      code: "feature_not_included",
    });
    expect(mobileMoneySetup(off.bursar).enabled).toBe(false);
    await expect(ask({ ...s, bursar: off.bursar }, ama.id, "024 123 4567")).rejects.toMatchObject({
      code: "feature_not_included",
    });
    // Without the parent view, families cannot sign in to this school.
    expect((await schoolsForPhone(conn.app, ama.phone)).map((x) => x.id)).not.toContain(s.tenant.id);
    // Roles still decide first: a teacher is refused for lack of permission, not of plan.
    await expect(sendFeeReminders(conn.app, off.teacher, { studentIds: [ama.id] })).rejects.toThrow(
      ForbiddenError,
    );

    const on = await setPlan(s, {});
    expect((await schoolsForPhone(conn.app, ama.phone)).map((x) => x.id)).toContain(s.tenant.id);
    expect(mobileMoneySetup(on.bursar).enabled).toBe(true);
  });

  it("sends reminders without a balance link when the parent view is left out", async () => {
    const s = await school();
    const ama = await withPhone(s, "Ama");
    await billTerm(conn.app, s.bursar, s.termId);
    const plan = await setPlan(s, { features: ["fee_reminders"] });
    expect((await sendFeeReminders(conn.app, plan.bursar, { studentIds: [ama.id] })).sent).toBe(1);
    const links = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(balanceLinks).where(eq(balanceLinks.tenantId, s.tenant.id)),
    );
    expect(links).toHaveLength(0);
  });
});

describe("plan limits", () => {
  it("stops adding or reactivating students beyond the student limit", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await s.add("Kofi", s.classA);
    await setPlan(s, { maxStudents: 2 });
    await expect(s.add("Esi", s.classA)).rejects.toMatchObject({
      code: "student_limit",
      message:
        "Your plan allows 2 active students and you have 2. Ask EduBridge to raise the limit, or withdraw students who have left.",
    });
    await setStudentStatus(conn.app, s.owner, ama.id, "withdrawn");
    await s.add("Esi", s.classA);
    await expect(setStudentStatus(conn.app, s.owner, ama.id, "active")).rejects.toMatchObject({
      code: "student_limit",
    });
  });

  it("skips reminders over the monthly SMS limit, and counts what was sent", async () => {
    const s = await school();
    const ama = await withPhone(s, "Ama");
    const kofi = await withPhone(s, "Kofi");
    await billTerm(conn.app, s.bursar, s.termId);
    const plan = await setPlan(s, { maxSmsPerMonth: 1 });
    const result = await sendFeeReminders(conn.app, plan.bursar, { studentIds: [ama.id, kofi.id] });
    expect(result.sent).toBe(1);
    expect(result.skipped.map((x) => x.reason)).toEqual(["sms_limit"]);
    const billing = await getSchoolBilling(conn.app, plan.owner);
    expect(billing.plan.smsThisMonth).toBe(1);
    expect(billing.plan.maxSmsPerMonth).toBe(1);
    expect(billing.usage[0]).toMatchObject({
      month: monthOf(todayIn(s.tenant.timezone)),
      reminders: 1,
      billable: 1,
    });
  });
});

describe("SMS billing records", () => {
  it("charges a parent sign-in code to each school with the number, marking codes the schools share", async () => {
    const a = await school();
    const b = await school();
    const shared = randomPhone();
    await withPhone(a, "Ama", shared);
    await withPhone(b, "Kwame", shared);
    const only = await withPhone(a, "Kofi");

    await requestParentCode(conn.app, shared);
    await requestParentCode(conn.app, only.phone);
    const sharedWith = (s: School) =>
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, async (tx) =>
        (
          await tx
            .select({ n: smsUsage.sharedWith })
            .from(smsUsage)
            .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, "parent_code")))
        )
          .map((r) => r.n)
          .sort(),
      );
    expect(await sharedWith(a)).toEqual([1, 2]);
    expect(await sharedWith(b)).toEqual([2]);

    const usage = (await getSchoolBilling(conn.app, a.owner)).usage[0]!;
    // The shared code is split with the other school: half an SMS each.
    expect(usage).toMatchObject({ codes: 1, sharedCodes: 1, billable: 1.5 });

    // The database records a code once, and only a code just queued.
    const [code] = await withTenant(conn.owner, { tenantId: a.tenant.id, userId: "" }, (tx) =>
      tx
        .select()
        .from(smsUsage)
        .where(and(eq(smsUsage.tenantId, a.tenant.id), eq(smsUsage.kind, "parent_code"))),
    );
    await expect(
      conn.app.execute(
        sql`select record_parent_code_usage(${code!.outboxId}::uuid, ${`{${a.tenant.id}}`}::uuid[])`,
      ),
    ).rejects.toThrow();
    // Usage rows are never changed: no policy allows an update (and a trigger refuses one for every role).
    await withTenant(conn.owner, { tenantId: a.tenant.id, userId: "" }, (tx) =>
      tx.update(smsUsage).set({ sharedWith: 9 }).where(eq(smsUsage.id, code!.id)),
    );
    expect(await sharedWith(a)).toEqual([1, 2]);
  });
});

describe("invoices to schools", () => {
  it("are issued by EduBridge staff, seen by the school, and settled once", async () => {
    const s = await school();
    const admin = await platform;
    const today = todayIn(s.tenant.timezone);
    await updateSubscription(conn.app, admin.id, s.tenant.id, {
      status: "active",
      billingPeriod: "termly",
      paidUntil: "",
      price: "1500",
      trialEndsOn: "",
      notes: "Pilot price agreed with the proprietor.",
    });
    const issued = await issueSubscriptionInvoice(conn.app, admin.id, s.tenant.id, {
      periodStartsOn: "2026-09-08",
      periodEndsOn: "2026-12-18",
      dueOn: today,
      lines: [
        { description: "Pilot plan, Term 1", quantity: "1", unitPrice: "1500" },
        { description: "SMS, October 2026", quantity: "412", unitPrice: "0.05" },
      ],
    });
    expect(issued.invoiceNumber).toMatch(new RegExp(`^EB-${today.slice(0, 4)}-\\d{6}$`));

    const view = await getSchoolBilling(conn.app, s.owner);
    expect(view.plan).toMatchObject({ status: "active", pricePesewas: 150_000, billingPeriod: "termly" });
    expect(view.invoices).toHaveLength(1);
    expect(view.invoices[0]).toMatchObject({
      totalPesewas: 152_060,
      state: "open",
      lines: [
        { description: "Pilot plan, Term 1", quantity: 1, unitPesewas: 150_000, amountPesewas: 150_000 },
        { description: "SMS, October 2026", quantity: 412, unitPesewas: 5, amountPesewas: 2_060 },
      ],
    });
    await expect(getSchoolBilling(conn.app, s.teacher)).rejects.toThrow(ForbiddenError);
    await expect(
      issueSubscriptionInvoice(conn.app, s.owner.userId, s.tenant.id, {
        periodStartsOn: "2026-09-08",
        periodEndsOn: "2026-12-18",
        dueOn: today,
        lines: [{ description: "Free", quantity: "1", unitPrice: "1" }],
      }),
    ).rejects.toThrow(NotPlatformAdminError);

    const id = view.invoices[0]!.id;
    await markSubscriptionInvoicePaid(conn.app, admin.id, s.tenant.id, id, {
      paidOn: today,
      reference: "GCB-88231",
    });
    await expect(
      markSubscriptionInvoicePaid(conn.app, admin.id, s.tenant.id, id, { paidOn: today, reference: "again" }),
    ).rejects.toMatchObject({ code: "already_settled" });
    await expect(
      voidSubscriptionInvoice(conn.app, admin.id, s.tenant.id, id, { reason: "Issued twice by mistake" }),
    ).rejects.toMatchObject({ code: "already_settled" });
    expect((await getSchoolBilling(conn.app, s.owner)).invoices[0]).toMatchObject({
      state: "paid",
      paidOn: today,
      paymentReference: "GCB-88231",
    });
    // Even the owner role cannot rewrite an issued invoice.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: admin.id }, (tx) =>
        tx.update(subscriptionInvoices).set({ totalPesewas: 1 }).where(eq(subscriptionInvoices.id, id)),
      ),
    ).rejects.toThrow();

    const actions = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, async (tx) =>
      (
        await tx
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, s.tenant.id))
      ).map((r) => r.action),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "subscription.updated",
        "subscription_invoice.issued",
        "subscription_invoice.paid",
      ]),
    );

    const overview = await getBillingOverview(conn.app, admin.id, monthOf(today));
    expect(overview.find((r) => r.tenantId === s.tenant.id)).toMatchObject({
      status: "active",
      unpaidCount: 0,
    });
    await expect(getBillingOverview(conn.app, s.owner.userId, monthOf(today))).rejects.toThrow(
      NotPlatformAdminError,
    );
  });

  it("can be voided with a reason, and never with amounts that do not add up", async () => {
    const s = await school();
    const admin = await platform;
    const today = todayIn(s.tenant.timezone);
    const { id } = await issueSubscriptionInvoice(conn.app, admin.id, s.tenant.id, {
      periodStartsOn: "2026-09-01",
      periodEndsOn: "2026-09-30",
      dueOn: today,
      lines: [{ description: "Setup and data import", quantity: "1", unitPrice: "500" }],
    });
    await voidSubscriptionInvoice(conn.app, admin.id, s.tenant.id, id, { reason: "Agreed to waive setup" });
    expect((await getSchoolBilling(conn.app, s.owner)).invoices[0]).toMatchObject({
      state: "void",
      voidReason: "Agreed to waive setup",
    });
    await expect(
      issueSubscriptionInvoice(conn.app, admin.id, s.tenant.id, {
        periodStartsOn: "2026-09-30",
        periodEndsOn: "2026-09-01",
        dueOn: today,
        lines: [{ description: "Backwards", quantity: "1", unitPrice: "5" }],
      }),
    ).rejects.toThrow();
  });
});

describe("data export", () => {
  it("gives the school its records as CSV, safely, and records each download", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    // A name that a spreadsheet would treat as a formula.
    await createStudent(conn.app, s.owner, {
      firstName: "=HYPERLINK(1)",
      lastName: "Mensah",
      sex: "male",
      classId: s.classA,
    });
    await billTerm(conn.app, s.bursar, s.termId);

    const students = await exportDataset(conn.app, s.owner, "students");
    expect(students.rows).toBe(2);
    expect(students.csv.startsWith(String.fromCharCode(0xfeff) + "Admission number,First name")).toBe(true);
    expect(students.csv).toContain("'=HYPERLINK(1)");
    expect(students.csv).toContain(",Ama,");
    expect(students.filename).toMatch(new RegExp(`^${s.tenant.slug}-students-\\d{4}-\\d{2}-\\d{2}\\.csv$`));

    const balances = await exportDataset(conn.app, s.bursar, "balances");
    expect(balances.csv).toContain(`${ama.admissionNumber},Ama Mensah,active,Basic 4A,1000.00`);
    const ledger = await exportDataset(conn.app, s.bursar, "fee_ledger");
    expect(ledger.rows).toBe(2);

    // The accountant exports fee records only; staff limited to a campus cannot export the whole school.
    await expect(exportDataset(conn.app, s.bursar, "students")).rejects.toThrow(ForbiddenError);
    await expect(exportDataset(conn.app, s.eastBursar, "balances")).rejects.toBeInstanceOf(DomainError);
    await expect(exportDataset(conn.app, s.teacher, "fee_ledger")).rejects.toThrow(ForbiddenError);

    const exported = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, "data.exported"))),
    );
    expect(exported.map((e) => e.metadata.dataset).sort()).toEqual(["balances", "fee_ledger", "students"]);
  });
});
