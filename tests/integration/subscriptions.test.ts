import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { runSubscriptionStatusRules } from "@/server/billing/automatic";
import {
  applyPreset,
  createPreset,
  decidePlanRequest,
  getPlanOptions,
  listPendingPlanRequests,
  requestPlanChange,
  setPresetArchived,
  updatePreset,
  withdrawPlanRequest,
} from "@/server/billing/plans";
import { readBillingState } from "@/server/billing/state";
import {
  getInvoiceDocument,
  getSchoolBilling,
  issueSubscriptionInvoice,
  updateSubscription,
} from "@/server/billing/subscriptions";
import { updateInvoiceDetails } from "@/server/billing/settings";
import { withTenant } from "@/server/db/context";
import {
  auditEvents,
  notificationOutbox,
  planChangeRequests,
  tenantEntitlements,
  tenants,
  users,
} from "@/server/db/schema";
import { createSchool, NotPlatformAdminError } from "@/server/platform/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { renderSubscriptionInvoicePdf } from "@/web/pdf/subscription-invoice";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const unique = () => Math.random().toString(36).slice(2, 8);
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const preset = (extra: Record<string, unknown> = {}) => ({
  name: `Standard ${unique()}`,
  description: "For one campus",
  features: ["attendance", "assessment", "parent_view"],
  maxCampuses: "2",
  maxStudents: "400",
  maxSmsPerMonth: "1000",
  billingPeriod: "termly",
  currencyCode: "GHS",
  price: "1500",
  ...extra,
});

const plan = (s: School) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, async (tx) => {
    const [row] = await tx
      .select()
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, s.tenant.id));
    return row!;
  });

const emailOf = async (userId: string) =>
  (await conn.owner.select({ email: users.email }).from(users).where(eq(users.id, userId)))[0]!.email;

const outbox = (recipients: string[], template: string) =>
  conn.owner
    .select()
    .from(notificationOutbox)
    .where(and(inArray(notificationOutbox.recipient, recipients), eq(notificationOutbox.template, template)));

describe("plan presets", () => {
  it("are kept by platform staff, start new schools, and are copied, never linked", async () => {
    const admin = await platform;
    const outsider = await createUser(conn.owner, "Not staff");
    await expect(createPreset(conn.app, outsider.id, preset())).rejects.toBeInstanceOf(NotPlatformAdminError);
    const input = preset();
    const { id } = await createPreset(conn.app, admin.id, input);
    await expect(createPreset(conn.app, admin.id, { ...preset(), name: input.name })).rejects.toMatchObject({
      code: "preset_name_taken",
    });
    await expect(createPreset(conn.app, admin.id, preset({ price: "abc" }))).rejects.toMatchObject({
      code: "price_invalid",
    });

    const created = await createSchool(conn.app, admin.id, {
      name: "Preset Academy",
      slug: `preset-${unique()}`,
      countryCode: "GH",
      currencyCode: "GHS",
      timezone: "Africa/Accra",
      ownerEmail: `owner-${unique()}@example.test`,
      planName: "",
      maxCampuses: "",
      presetId: id,
    });
    const [row] = await withTenant(conn.owner, { tenantId: created.tenantId, userId: "" }, (tx) =>
      tx.select().from(tenantEntitlements).where(eq(tenantEntitlements.tenantId, created.tenantId)),
    );
    expect(row).toMatchObject({
      planName: input.name,
      planPresetId: id,
      maxCampuses: 2,
      maxStudents: 400,
      maxSmsPerMonth: 1000,
      features: ["attendance", "assessment", "parent_view"],
      pricePesewas: 150_000,
      billingPeriod: "termly",
    });
    // Editing the preset leaves the school as it was.
    await updatePreset(conn.app, admin.id, id, { ...input, maxStudents: "900" });
    const [after] = await withTenant(conn.owner, { tenantId: created.tenantId, userId: "" }, (tx) =>
      tx.select().from(tenantEntitlements).where(eq(tenantEntitlements.tenantId, created.tenantId)),
    );
    expect(after!.maxStudents).toBe(400);
    // Archived: no longer offered for new schools.
    await setPresetArchived(conn.app, admin.id, id, true);
    await expect(
      createSchool(conn.app, admin.id, {
        name: "Late Academy",
        slug: `late-${unique()}`,
        countryCode: "GH",
        currencyCode: "GHS",
        timezone: "Africa/Accra",
        ownerEmail: `owner-${unique()}@example.test`,
        presetId: id,
      }),
    ).rejects.toMatchObject({ code: "preset_not_found" });
  });

  it("keep a school's own price when the preset is priced in another currency", async () => {
    const admin = await platform;
    const s = await school();
    const { id } = await createPreset(conn.app, admin.id, preset({ currencyCode: "KES", price: "20000" }));
    await updateSubscription(conn.app, admin.id, s.tenant.id, {
      status: "active",
      billingPeriod: "annual",
      price: "900",
    });
    await applyPreset(conn.app, admin.id, s.tenant.id, id);
    expect(await plan(s)).toMatchObject({
      planPresetId: id,
      maxCampuses: 2,
      pricePesewas: 90_000,
      billingPeriod: "annual",
    });
  });
});

describe("plan change requests", () => {
  it("are asked by the Proprietor, decided once by platform staff, and change the plan when approved", async () => {
    const admin = await platform;
    const s = await school();
    const { id: presetId } = await createPreset(conn.app, admin.id, preset());
    const options = await getPlanOptions(conn.app, s.owner);
    const offered = options.plans.find((p) => p.id === presetId)!;
    expect(offered).toBeTruthy();
    // Schools are not shown preset prices: EduBridge confirms the price.
    expect(offered).not.toHaveProperty("pricePesewas");
    expect(options.canRequest).toBe(true);

    const admins = (
      await conn.owner.select({ email: users.email }).from(users).where(eq(users.id, admin.id))
    ).map((u) => u.email);
    await expect(requestPlanChange(conn.app, s.head, { presetId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestPlanChange(conn.app, s.owner, {})).rejects.toThrow();
    const { id } = await requestPlanChange(conn.app, s.owner, {
      presetId,
      message: "We are opening a second campus.",
    });
    await expect(requestPlanChange(conn.app, s.owner, { message: "Another" })).rejects.toMatchObject({
      code: "plan_request_pending",
    });
    expect(await outbox(admins, "plan_change_requested")).toHaveLength(1);
    expect((await listPendingPlanRequests(conn.app, admin.id)).find((r) => r.id === id)).toMatchObject({
      schoolName: s.tenant.name,
      presetName: offered.name,
    });

    await expect(decidePlanRequest(conn.app, admin.id, id, { approve: false })).rejects.toThrow();
    expect(await decidePlanRequest(conn.app, admin.id, id, { approve: true })).toEqual({ applied: true });
    expect(await plan(s)).toMatchObject({ planName: offered.name, planPresetId: presetId, maxStudents: 400 });
    await expect(
      decidePlanRequest(conn.app, admin.id, id, { approve: false, note: "No" }),
    ).rejects.toMatchObject({
      code: "plan_request_decided",
    });
    expect(await outbox([await emailOf(s.owner.userId)], "plan_change_decided")).toHaveLength(1);
    const ctx = (await resolveTenantContext(conn.app, s.tenant.slug, s.owner.userId)) as TenantContext;
    expect((await getPlanOptions(conn.app, ctx)).plans.find((p) => p.id === presetId)!.current).toBe(true);

    // A decided request never changes, even directly in the database.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx.update(planChangeRequests).set({ status: "declined" }).where(eq(planChangeRequests.id, id)),
      ),
    ).rejects.toThrow();

    // Declined (with a reason), and withdrawn by the school.
    const second = await requestPlanChange(conn.app, s.owner, { message: "Unlimited SMS please" });
    await decidePlanRequest(conn.app, admin.id, second.id, { approve: false, note: "Not offered yet" });
    const third = await requestPlanChange(conn.app, s.owner, { message: "Never mind" });
    await withdrawPlanRequest(conn.app, s.owner, third.id);
    const history = (await getPlanOptions(conn.app, s.owner)).history;
    expect(history.map((h) => h.status)).toEqual(["withdrawn", "declined", "approved"]);
    expect(history[1]!.decisionNote).toBe("Not offered yet");
  });
});

describe("EduBridge invoices", () => {
  it("are emailed to the Proprietors and printed as PDF for the school only", async () => {
    const admin = await platform;
    const s = await school();
    const other = await school();
    await updateInvoiceDetails(conn.app, admin.id, {
      issuer: "EduBridge Ltd\nAccra",
      paymentInstructions: "Mobile Money: 024 000 0000",
    });
    const today = todayIn(s.tenant.timezone);
    const { id, invoiceNumber } = await issueSubscriptionInvoice(conn.app, admin.id, s.tenant.id, {
      periodStartsOn: today,
      periodEndsOn: addDays(today, 90),
      dueOn: addDays(today, 14),
      lines: [{ description: "Standard plan, Term 1", quantity: "1", unitPrice: "1500" }],
    });
    const [mail] = await outbox([await emailOf(s.owner.userId)], "subscription_invoice");
    expect(mail!.payload).toMatchObject({ invoiceNumber, schoolSlug: s.tenant.slug });
    // Only the Proprietor: not the head teacher or accountant.
    expect(
      await outbox([await emailOf(s.head.userId), await emailOf(s.bursar.userId)], "subscription_invoice"),
    ).toEqual([]);
    const doc = (await getInvoiceDocument(conn.app, s.owner, id))!;
    expect(doc).toMatchObject({ issuer: "EduBridge Ltd\nAccra", schoolName: s.tenant.name });
    expect(doc.invoice.totalPesewas).toBe(150_000);
    expect(await getInvoiceDocument(conn.app, other.owner, id)).toBeNull();
    await expect(getInvoiceDocument(conn.app, s.bursar, id)).rejects.toBeInstanceOf(ForbiddenError);
    const pdf = await renderSubscriptionInvoicePdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("automatic subscription status", () => {
  const run = (s: School) => runSubscriptionStatusRules(conn.app, { only: [s.tenant.id] });
  const set = async (s: School, values: Record<string, unknown>) => {
    const admin = await platform;
    await updateSubscription(conn.app, admin.id, s.tenant.id, { billingPeriod: "termly", ...values });
  };

  it("moves an ended trial to grace, then overdue (pausing SMS), and back to active once paid", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    await set(s, { status: "trial", trialEndsOn: addDays(today, 5) });
    expect((await run(s)).changed).toBe(0);
    await set(s, { status: "trial", trialEndsOn: addDays(today, -1) });
    await run(s);
    expect(await plan(s)).toMatchObject({ subscriptionStatus: "grace", statusAuto: true });
    // Past the grace period (3 days): overdue, which pauses SMS.
    await set(s, { status: "trial", trialEndsOn: addDays(today, -10) });
    await run(s);
    expect((await plan(s)).subscriptionStatus).toBe("past_due");
    const state = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      readBillingState(tx, { id: s.tenant.id, timezone: s.tenant.timezone, isDemo: false }),
    );
    expect(state.state).toBe("limited");
    // Paid: platform staff extend "paid until" (status unchanged), and the rules make it active.
    await set(s, { status: "past_due", trialEndsOn: addDays(today, -10), paidUntil: addDays(today, 60) });
    expect((await plan(s)).statusAuto).toBe(true);
    await run(s);
    expect((await getSchoolBilling(conn.app, s.owner)).plan.status).toBe("active");
    const audit = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, s.tenant.id),
            eq(auditEvents.action, "subscription.status_changed_automatically"),
          ),
        ),
    );
    expect(audit.map((a) => (a.metadata as { to: string }).to)).toEqual(["grace", "past_due", "active"]);
    expect(await outbox([await emailOf(s.owner.userId)], "subscription_status")).toHaveLength(3);
  });

  it("moves a paid period that ended to grace, and leaves statuses set by hand and demo schools alone", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    await set(s, { status: "active", paidUntil: addDays(today, -2) });
    await run(s);
    expect((await plan(s)).subscriptionStatus).toBe("grace");
    // Set by hand to overdue while paid ahead: the rules do not undo a decision staff made.
    await set(s, { status: "past_due", paidUntil: addDays(today, 30) });
    await run(s);
    expect(await plan(s)).toMatchObject({ subscriptionStatus: "past_due", statusAuto: false });

    const demo = await school();
    await set(demo, { status: "active", paidUntil: addDays(today, -30) });
    await conn.owner.update(tenants).set({ isDemo: true }).where(eq(tenants.id, demo.tenant.id));
    const direct = await withTenant(
      conn.app,
      { tenantId: demo.tenant.id, userId: "" },
      async (tx) =>
        (await tx.execute(sql`select * from subscription_apply_automatic_status(${demo.tenant.id})`)).rows,
    );
    expect(direct).toEqual([]);
    expect((await plan(demo)).subscriptionStatus).toBe("active");
  });
});
