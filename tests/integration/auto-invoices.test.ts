import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSmsTopUp,
  issueAutomaticInvoiceNow,
  quoteForSchool,
  runAutomaticInvoicing,
  runInvoiceReminders,
} from "@/server/billing/auto-invoices";
import { addSuggestedPlans, applyPreset, createPreset } from "@/server/billing/plans";
import { readInvoicingSettings } from "@/server/billing/auto-invoices";
import { updateInvoicingSettings } from "@/server/billing/settings";
import {
  getSchoolBilling,
  issueSubscriptionInvoice,
  markSubscriptionInvoicePaid,
  updateSubscription,
} from "@/server/billing/subscriptions";
import { smsAllowance } from "@/server/billing/usage";
import { withTenant } from "@/server/db/context";
import {
  notificationOutbox,
  planPresets,
  schoolModules,
  smsTopUps,
  subscriptionCensus,
  subscriptionInvoices,
  tenantEntitlements,
  tenants,
} from "@/server/db/schema";
import { todayIn } from "@/lib/format";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const today = todayIn("Africa/Accra");
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const unique = () => Math.random().toString(36).slice(2, 8);

// Automatic invoices are a platform setting: on for these tests, as it was afterwards.
let before: Awaited<ReturnType<typeof readInvoicingSettings>>;
const settings = async (autoInvoicing: boolean, extra: Record<string, unknown> = {}) =>
  updateInvoicingSettings(conn.app, (await platform).id, {
    autoInvoicing: autoInvoicing ? "on" : "",
    censusDays: "21",
    invoiceDueDays: "30",
    annualDiscount: "12",
    monthlySurcharge: "10",
    ...extra,
  });
beforeAll(async () => {
  before = await readInvoicingSettings(conn.owner);
  await settings(true);
});
afterAll(async () => {
  await updateInvoicingSettings(conn.app, (await platform).id, {
    autoInvoicing: before.autoInvoicing ? "on" : "",
    censusDays: String(before.censusDays),
    invoiceDueDays: String(before.invoiceDueDays),
    annualDiscount: String(before.annualDiscountBp / 100),
    monthlySurcharge: String(before.monthlySurchargeBp / 100),
  });
});

/** A plan priced per term by size: GH₵1,200 up to 150 students, then 2,100, 3,600 and 5,500. */
async function sizedPlan() {
  const admin = await platform;
  return (
    await createPreset(conn.app, admin.id, {
      name: `Sized ${unique()}`,
      features: ["attendance", "assessment", "parent_view"],
      maxCampuses: "2",
      maxSmsPerMonth: "300",
      billingPeriod: "termly",
      currencyCode: "GHS",
      band0: "1200",
      band1: "2100",
      band2: "3600",
      band3: "5500",
    })
  ).id;
}

/** A school on the sized plan, paying (not on trial), with `students` active students. */
async function payingSchool(students = 3, subscription: Record<string, unknown> = {}) {
  const admin = await platform;
  const s = await school();
  for (let i = 0; i < students; i++) await s.add(`Pupil${i}`, s.classA);
  await applyPreset(conn.app, admin.id, s.tenant.id, await sizedPlan());
  await updateSubscription(conn.app, admin.id, s.tenant.id, {
    status: "active",
    billingPeriod: "termly",
    ...subscription,
  });
  return s;
}

const invoicesOf = (s: School) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
    tx.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.tenantId, s.tenant.id)),
  );
const quote = (s: School) => quoteForSchool(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId });
const run = (s: School, extra: { today?: string } = {}) =>
  runAutomaticInvoicing(conn.app, { only: [s.tenant.id], ...extra });

describe("plans priced by school size", () => {
  it("are kept on presets, checked, and copied onto a school with no agreed price", async () => {
    const admin = await platform;
    await expect(
      createPreset(conn.app, admin.id, {
        name: `Falling ${unique()}`,
        features: [],
        maxCampuses: "1",
        billingPeriod: "termly",
        currencyCode: "GHS",
        band0: "2000",
        band1: "1000",
        band2: "3000",
        band3: "4000",
      }),
    ).rejects.toThrow("A larger school cannot pay less");
    await expect(
      createPreset(conn.app, admin.id, {
        name: `Partial ${unique()}`,
        features: [],
        maxCampuses: "1",
        billingPeriod: "termly",
        currencyCode: "GHS",
        band0: "2000",
      }),
    ).rejects.toThrow("Enter a price for every size");

    const s = await payingSchool(0, { price: "999" });
    const plan = (await getSchoolBilling(conn.app, s.owner)).plan;
    // Setting the plan again replaces the agreed price with the plan's prices by size.
    expect(plan.pricePesewas).toBe(99_900);
    const presetId = (
      await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx
          .select({ id: tenantEntitlements.planPresetId })
          .from(tenantEntitlements)
          .where(eq(tenantEntitlements.tenantId, s.tenant.id)),
      )
    )[0]!.id!;
    await applyPreset(conn.app, admin.id, s.tenant.id, presetId);
    const again = (await getSchoolBilling(conn.app, s.owner)).plan;
    expect(again.pricePesewas).toBeNull();
    expect(again.priceBands?.map((b) => b.termlyMinor)).toEqual([120_000, 210_000, 360_000, 550_000]);
  });

  it("adds the suggested plans and add-on prices once", async () => {
    const admin = await platform;
    const first = await addSuggestedPlans(conn.app, admin.id);
    const second = await addSuggestedPlans(conn.app, admin.id);
    expect(second).toEqual({ plans: 0, prices: 0 });
    expect(first.plans + first.prices).toBeGreaterThanOrEqual(0);
    const premium = await conn.owner.select().from(planPresets).where(eq(planPresets.name, "Premium"));
    expect(premium[0]?.priceBands?.[0]?.termlyMinor).toBe(270_000);
  });
});

describe("automatic invoices (founder, 2026-11-18)", () => {
  it("price the term on the census count and the plan's band, once, and email the Proprietor", async () => {
    const s = await payingSchool(3);
    const q = await quote(s);
    // The fixture's term began on 8 September 2026: its census day has passed.
    expect(q).toMatchObject({
      status: "ready",
      students: 3,
      band: "up to 150 students",
      totalMinor: 120_000,
    });

    expect(await run(s)).toEqual({ checked: 1, issued: 1 });
    const [invoice] = await invoicesOf(s);
    expect(invoice).toMatchObject({
      automatic: true,
      createdByUserId: null,
      studentCount: 3,
      totalPesewas: 120_000,
      periodStartsOn: "2026-09-08",
      periodEndsOn: "2026-12-18",
      dueOn: addDays(today, 30),
    });
    const census = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(subscriptionCensus).where(eq(subscriptionCensus.tenantId, s.tenant.id)),
    );
    expect(census).toEqual([expect.objectContaining({ activeStudents: 3, termId: s.termId })]);

    // A student joining later changes nothing for the term; a second run issues nothing.
    await s.add("Late", s.classA);
    expect(await run(s)).toEqual({ checked: 1, issued: 0 });
    expect(await invoicesOf(s)).toHaveLength(1);
    expect((await quote(s)).status).toBe("invoiced");
    const emails = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.idempotencyKey, `invoice:${invoice!.id}`));
    expect(emails).toHaveLength(1);
  });

  it("charge a year less the discount, a month with the premium, or an agreed price", async () => {
    const yearly = await payingSchool(3, { billingPeriod: "annual" });
    // One term in the fixture's year, less 12%.
    expect(await quote(yearly)).toMatchObject({ status: "ready", totalMinor: 105_600 });

    const monthly = await payingSchool(3, { billingPeriod: "monthly" });
    const m = await quote(monthly);
    // A twelfth of the year's one term, plus 10%.
    expect(m).toMatchObject({ status: "ready", totalMinor: 11_000 });
    expect(m.period?.startsOn).toBe(`${today.slice(0, 7)}-01`);

    const agreed = await payingSchool(3, { price: "800" });
    const a = await quote(agreed);
    expect(a.totalMinor).toBe(80_000);
    expect(a.lines[0]?.description).toMatch(/agreed price/);
  });

  it("add priced add-ons and take the school's discount off both", async () => {
    const admin = await platform;
    const s = await payingSchool(3, { discountPercent: "25", discountLabel: "Founding school" });
    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: admin.id }, (tx) =>
      tx.insert(schoolModules).values({
        tenantId: s.tenant.id,
        module: "library",
        source: "addon",
        startsOn: "2026-09-01",
        billingPeriod: "termly",
        pricePesewas: 40_000,
        priceUnit: "flat",
        currencyCode: "GHS",
        grantedByUserId: admin.id,
      }),
    );
    const q = await quote(s);
    expect(q.lines.map((l) => [l.description.split(",")[0], l.amountPesewas])).toEqual([
      [expect.stringMatching(/plan/), 120_000],
      ["Library (add-on)", 40_000],
      ["Founding school (25% off)", -40_000],
    ]);
    expect(q.totalMinor).toBe(120_000);
  });

  it("are never issued for demo schools, a trial that covers the period, no price, or a period already invoiced", async () => {
    const admin = await platform;
    const trial = await payingSchool(3, { status: "trial", trialEndsOn: "2027-01-31" });
    expect(await quote(trial)).toMatchObject({
      status: "none",
      reason: expect.stringMatching(/trial covers/),
    });

    const noPrice = await school();
    await updateSubscription(conn.app, admin.id, noPrice.tenant.id, {
      status: "active",
      billingPeriod: "termly",
    });
    expect((await quote(noPrice)).reason).toMatch(/No price yet/);

    const byHand = await payingSchool(3);
    await issueSubscriptionInvoice(conn.app, admin.id, byHand.tenant.id, {
      periodStartsOn: "2026-10-01",
      periodEndsOn: "2026-10-31",
      dueOn: addDays(today, 10),
      lines: [{ description: "October", quantity: "1", unitPrice: "500" }],
    });
    expect((await quote(byHand)).status).toBe("invoiced");
    expect(await run(byHand)).toEqual({ checked: 1, issued: 0 });

    const demo = await payingSchool(3);
    await conn.owner.update(tenants).set({ isDemo: true }).where(eq(tenants.id, demo.tenant.id));
    expect((await quote(demo)).reason).toMatch(/Demo schools/);
    expect(await run(demo)).toEqual({ checked: 0, issued: 0 });
  });

  it("can be issued now by EduBridge staff while automatic invoices are off, once", async () => {
    const admin = await platform;
    const s = await payingSchool(3);
    await settings(false);
    try {
      expect(await run(s)).toEqual({ checked: 0, issued: 0 });
      const { invoiceNumber } = await issueAutomaticInvoiceNow(conn.app, admin.id, s.tenant.id);
      expect(invoiceNumber).toMatch(/^EB-\d{4}-\d{6}$/);
      await expect(issueAutomaticInvoiceNow(conn.app, admin.id, s.tenant.id)).rejects.toMatchObject({
        code: "nothing_to_invoice",
      });
    } finally {
      await settings(true);
    }
  });

  it("move paid until to the end of the period when marked paid", async () => {
    const admin = await platform;
    const s = await payingSchool(3);
    await run(s);
    const [invoice] = await invoicesOf(s);
    await markSubscriptionInvoicePaid(conn.app, admin.id, s.tenant.id, invoice!.id, {
      paidOn: today,
      reference: "MP123456",
    });
    expect((await getSchoolBilling(conn.app, s.owner)).plan.paidUntil).toBe("2026-12-18");
  });

  it("are created only by the database function, for the school in context", async () => {
    const s = await payingSchool(3);
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.insert(subscriptionInvoices).values({
          tenantId: s.tenant.id,
          invoiceNumber: `EB-FAKE-${unique()}`,
          lines: [{ description: "x", quantity: 1, unitPesewas: 100, amountPesewas: 100 }],
          totalPesewas: 100,
          currencyCode: "GHS",
          periodStartsOn: "2026-09-08",
          periodEndsOn: "2026-12-18",
          issuedOn: today,
          dueOn: today,
          automatic: true,
        }),
      ),
    ).rejects.toThrow();
    // Lines that do not add up are refused by the function itself.
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx.execute(
          sql`select * from subscription_issue_automatic_invoice('2026-09-08', '2026-12-18', ${addDays(today, 30)}::date,
            ${JSON.stringify([{ description: "Plan", quantity: 2, unitPesewas: 100, amountPesewas: 500 }])}::jsonb, 3, '{}'::uuid[])`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("SMS top-ups", () => {
  it("raise this month's allowance at once and are charged on the next invoice, once", async () => {
    const admin = await platform;
    const s = await payingSchool(3);
    const allowance = () =>
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        smsAllowance(tx, s.tenant.id, "Africa/Accra"),
      );
    expect(await allowance()).toBe(300);
    await addSmsTopUp(conn.app, admin.id, s.tenant.id, { messages: "200", price: "50" });
    expect(await allowance()).toBe(500);
    const q = await quote(s);
    expect(q.lines.at(-1)).toMatchObject({ amountPesewas: 5_000 });
    expect(q.totalMinor).toBe(125_000);
    await run(s);
    const [topUp] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(smsTopUps).where(eq(smsTopUps.tenantId, s.tenant.id)),
    );
    const [invoice] = await invoicesOf(s);
    expect(topUp!.invoiceId).toBe(invoice!.id);
    await expect(
      addSmsTopUp(conn.app, s.owner.userId, s.tenant.id, { messages: "10", price: "1" }),
    ).rejects.toThrow();
  });
});

describe("invoice reminders", () => {
  it("are sent a week before the due date and once after it, never twice", async () => {
    const s = await payingSchool(3);
    await run(s);
    const [invoice] = await invoicesOf(s);
    const sent = async () =>
      (
        await conn.owner
          .select({ template: notificationOutbox.template })
          .from(notificationOutbox)
          .where(
            and(
              inArray(notificationOutbox.template, [
                "subscription_invoice_due_soon",
                "subscription_invoice_overdue",
              ]),
              sql`${notificationOutbox.idempotencyKey} like ${`%${invoice!.id}%`}`,
            ),
          )
      ).map((r) => r.template);
    await runInvoiceReminders(conn.app, { only: [s.tenant.id], today });
    expect(await sent()).toEqual([]);
    await runInvoiceReminders(conn.app, { only: [s.tenant.id], today: addDays(invoice!.dueOn, -5) });
    await runInvoiceReminders(conn.app, { only: [s.tenant.id], today: addDays(invoice!.dueOn, -4) });
    expect(await sent()).toEqual(["subscription_invoice_due_soon"]);
    await runInvoiceReminders(conn.app, { only: [s.tenant.id], today: addDays(invoice!.dueOn, 1) });
    await runInvoiceReminders(conn.app, { only: [s.tenant.id], today: addDays(invoice!.dueOn, 2) });
    expect((await sent()).sort()).toEqual(["subscription_invoice_due_soon", "subscription_invoice_overdue"]);
  });
});
