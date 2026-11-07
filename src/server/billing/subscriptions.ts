import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { parseCedis, sumPesewas } from "../../lib/money";
import {
  BILLING_PERIODS,
  FEATURES,
  isFeature,
  monthOf,
  previousMonth,
  SUBSCRIPTION_STATUSES,
  type BillingPeriod,
  type Feature,
  type InvoiceLine,
  type SubscriptionStatus,
} from "../../lib/plan";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  campuses,
  notificationOutbox,
  smsUsage,
  students,
  subscriptionInvoices,
  tenantEntitlements,
  tenants,
} from "../db/schema";
import { DomainError } from "../errors";
import { assertPlatformAdmin } from "../platform/service";
import type { TenantContext } from "../tenancy/service";
import { smsPriceFor } from "./state";
import { smsUsedThisMonth } from "./usage";

/**
 * Billing records (PLT-03): each school's subscription, the SMS it is charged for, and EduBridge's invoices
 * to it. Billing is manual in R1: platform staff record invoices and payments here; schools see their own.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");
const optionalDate = z.preprocess((v) => (v === "" || v === null ? undefined : v), isoDate.optional());
const cedis = (message: string, allowZero = false) =>
  z.string().transform((text, ctx) => {
    const pesewas = parseCedis(text);
    if (pesewas === null || (!allowZero && pesewas === 0)) {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return pesewas;
  });

// ——— Subscription ———

const subscriptionSchema = z.object({
  status: z.enum(SUBSCRIPTION_STATUSES, { message: "Choose a status." }),
  billingPeriod: z.enum(BILLING_PERIODS, { message: "Choose how often the school pays." }),
  trialEndsOn: optionalDate,
  paidUntil: optionalDate,
  price: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    cedis("Enter the price, like 1500 or 1500.00.", true).optional(),
  ),
  /** The school's Paystack subaccount code, where its Mobile Money payments settle. */
  settlementAccount: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{4,40}$/, "Enter the subaccount code from Paystack, like ACCT_abc123.")
      .nullable()
      .optional(),
  ),
  /** This school's price per SMS; empty uses the platform's price. */
  smsPrice: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    cedis("Enter a price per SMS, like 0.05.", true)
      .refine((p) => p <= 100_000, "Enter a price per SMS, like 0.05.")
      .optional(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(500, "Use 500 characters or fewer.").optional(),
  ),
});

export async function updateSubscription(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = subscriptionSchema.parse(input);
  const values = {
    subscriptionStatus: data.status,
    billingPeriod: data.billingPeriod,
    trialEndsOn: data.trialEndsOn ?? null,
    paidUntil: data.paidUntil ?? null,
    pricePesewas: data.price ?? null,
    smsPricePesewas: data.smsPrice ?? null,
    ...(data.settlementAccount !== undefined ? { settlementAccount: data.settlementAccount } : {}),
    billingNotes: data.notes ?? null,
  };
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [before] = await tx
      .select()
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenantId));
    await tx
      .insert(tenantEntitlements)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: tenantEntitlements.tenantId, set: { ...values, updatedAt: new Date() } });
    const shown = (row: typeof values) => ({
      status: row.subscriptionStatus,
      billingPeriod: row.billingPeriod,
      trialEndsOn: row.trialEndsOn,
      paidUntil: row.paidUntil,
      pricePesewas: row.pricePesewas,
      smsPricePesewas: row.smsPricePesewas,
      settlementAccount: "settlementAccount" in row ? row.settlementAccount : undefined,
    });
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: "subscription.updated",
      entityType: "tenant",
      entityId: tenantId,
      metadata: { from: before ? shown(before) : null, to: shown(values) },
    });
  });
}

// ——— SMS usage ———

export interface MonthUsage {
  month: string;
  /** Fee reminders queued (not failed). */
  reminders: number;
  /** Absence SMS to families (not failed). */
  absenceAlerts: number;
  /** Parent sign-in codes for numbers only this school has. */
  codes: number;
  /** Codes for numbers several schools have (each school pays an equal share). */
  sharedCodes: number;
  /** Messages the provider could not deliver after every retry (not billed). */
  undelivered: number;
  /** reminders + absence alerts + codes + this school's share of shared codes (may be fractional). */
  billable: number;
}

/** SMS per month for the last `months` months (newest first), in the school's time zone. */
async function readUsage(
  tx: Transaction,
  tenantId: string,
  timeZone: string,
  months: number,
): Promise<MonthUsage[]> {
  const current = monthOf(todayIn(timeZone));
  const list = [current];
  while (list.length < months) list.push(previousMonth(list[list.length - 1]!));
  const rows = await tx
    .select({
      month: sql<string>`to_char(${smsUsage.createdAt} at time zone ${timeZone}, 'YYYY-MM')`,
      kind: smsUsage.kind,
      shared: sql<boolean>`${smsUsage.sharedWith} > 1`,
      failed: sql<boolean>`${notificationOutbox.status} = 'failed'`,
      n: sql<number>`count(*)::int`,
      /** This school's share: a code sent to a number n schools have counts 1/n here. */
      share: sql<number>`sum(1.0 / ${smsUsage.sharedWith})::float`,
    })
    .from(smsUsage)
    .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
    .where(
      and(
        eq(smsUsage.tenantId, tenantId),
        sql`to_char(${smsUsage.createdAt} at time zone ${timeZone}, 'YYYY-MM') >= ${list[list.length - 1]}`,
      ),
    )
    .groupBy(sql`1`, smsUsage.kind, sql`3`, sql`4`);
  return list.map((month) => {
    const of = rows.filter((r) => r.month === month);
    const count = (test: (r: (typeof rows)[number]) => boolean) =>
      of.filter(test).reduce((sum, r) => sum + r.n, 0);
    const reminders = count((r) => !r.failed && r.kind === "fee_reminder");
    const codes = count((r) => !r.failed && r.kind === "parent_code" && !r.shared);
    const absenceAlerts = count((r) => !r.failed && r.kind === "absence_alert");
    return {
      month,
      reminders,
      absenceAlerts,
      codes,
      sharedCodes: count((r) => !r.failed && r.kind === "parent_code" && r.shared),
      undelivered: count((r) => r.failed),
      // Shared codes are split equally between the schools with the number (founder decision, 2026-11-06).
      billable: roundShare(reminders + absenceAlerts + codes + shareOf(of)),
    };
  });
}

/** Shared sign-in codes' share for one month, e.g. 3 codes shared by 2 schools = 1.5. */
function shareOf(rows: readonly { failed: boolean; kind: string; shared: boolean; share: number }[]): number {
  return rows
    .filter((r) => !r.failed && r.kind === "parent_code" && r.shared)
    .reduce((sum, r) => sum + Number(r.share), 0);
}

/** Two decimal places: a third of an SMS is 0.33. */
const roundShare = (n: number) => Math.round(n * 100) / 100;

/** What a month's SMS cost the school: price × billable SMS (shares included), to the nearest pesewa. */
export function smsCharge(pricePesewas: number | null, billable: number): number | null {
  return pricePesewas === null ? null : Math.round(pricePesewas * billable);
}

async function activeStudents(tx: Transaction, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), eq(students.status, "active")));
  return row?.n ?? 0;
}

// ——— Invoices ———

export interface SubscriptionInvoice {
  id: string;
  invoiceNumber: string;
  lines: InvoiceLine[];
  totalPesewas: number;
  currencyCode: string;
  periodStartsOn: string;
  periodEndsOn: string;
  issuedOn: string;
  dueOn: string;
  state: "open" | "overdue" | "paid" | "void";
  paidOn: string | null;
  paymentReference: string | null;
  voidReason: string | null;
}

async function readInvoices(
  tx: Transaction,
  tenantId: string,
  today: string,
): Promise<SubscriptionInvoice[]> {
  const rows = await tx
    .select()
    .from(subscriptionInvoices)
    .where(eq(subscriptionInvoices.tenantId, tenantId))
    .orderBy(desc(subscriptionInvoices.issuedOn), desc(subscriptionInvoices.invoiceNumber));
  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    lines: r.lines,
    totalPesewas: r.totalPesewas,
    currencyCode: r.currencyCode,
    periodStartsOn: r.periodStartsOn,
    periodEndsOn: r.periodEndsOn,
    issuedOn: r.issuedOn,
    dueOn: r.dueOn,
    state: r.voidedAt ? "void" : r.paidOn ? "paid" : r.dueOn < today ? "overdue" : "open",
    paidOn: r.paidOn,
    paymentReference: r.paymentReference,
    voidReason: r.voidReason,
  }));
}

const lineSchema = z.object({
  description: z.string().trim().min(2, "Describe the line.").max(120, "Use 120 characters or fewer."),
  quantity: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 or more.")
    .max(1_000_000, "Too large."),
  unitPrice: cedis("Enter the price, like 15 or 0.05."),
});

const invoiceSchema = z
  .object({
    periodStartsOn: isoDate,
    periodEndsOn: isoDate,
    dueOn: isoDate,
    lines: z.array(lineSchema).min(1, "Add at least one line.").max(10, "Use 10 lines or fewer."),
  })
  .refine((v) => v.periodEndsOn >= v.periodStartsOn, {
    message: "The period must end on or after its first day.",
    path: ["periodEndsOn"],
  });

/** Lines from a form: rows left completely blank are ignored. */
export function invoiceLinesFrom(
  formData: FormData,
): { description: string; quantity: string; unitPrice: string }[] {
  const description = formData.getAll("lineDescription").map(String);
  const quantity = formData.getAll("lineQuantity").map(String);
  const unitPrice = formData.getAll("lineUnitPrice").map(String);
  return description
    .map((d, i) => ({ description: d, quantity: quantity[i] ?? "", unitPrice: unitPrice[i] ?? "" }))
    .filter((l) => l.description.trim() || l.quantity.trim() || l.unitPrice.trim());
}

/**
 * Issues an invoice to a school. Amounts are worked out here (quantity × unit price, in pesewas) and the
 * invoice is frozen: it can later only be marked paid or voided (database trigger).
 */
export async function issueSubscriptionInvoice(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: unknown,
): Promise<{ id: string; invoiceNumber: string }> {
  await assertPlatformAdmin(database, actorUserId);
  const data = invoiceSchema.parse(input);
  const lines: InvoiceLine[] = data.lines.map((l) => {
    const amount = l.quantity * l.unitPrice;
    if (!Number.isSafeInteger(amount) || amount > 1_000_000_000)
      throw new DomainError("amount_too_large", "A line comes to more than an invoice can hold.");
    return {
      description: l.description,
      quantity: l.quantity,
      unitPesewas: l.unitPrice,
      amountPesewas: amount,
    };
  });
  const totalPesewas = sumPesewas(lines.map((l) => l.amountPesewas));
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [tenant] = await tx
      .select({ currencyCode: tenants.currencyCode, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) throw new DomainError("school_not_found", "School not found.");
    const issuedOn = todayIn(tenant.timezone);
    if (data.dueOn < issuedOn)
      throw new DomainError("due_in_past", "The due date cannot be before today.", "dueOn");
    const seq = await tx.execute<{ n: string }>(sql`select nextval('subscription_invoice_seq') as n`);
    const invoiceNumber = `EB-${issuedOn.slice(0, 4)}-${String(seq.rows[0]!.n).padStart(6, "0")}`;
    const [row] = await tx
      .insert(subscriptionInvoices)
      .values({
        tenantId,
        invoiceNumber,
        lines,
        totalPesewas,
        currencyCode: tenant.currencyCode,
        periodStartsOn: data.periodStartsOn,
        periodEndsOn: data.periodEndsOn,
        issuedOn,
        dueOn: data.dueOn,
        createdByUserId: actorUserId,
      })
      .returning({ id: subscriptionInvoices.id });
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: "subscription_invoice.issued",
      entityType: "subscription_invoice",
      entityId: row!.id,
      metadata: { invoiceNumber, totalPesewas, period: [data.periodStartsOn, data.periodEndsOn] },
    });
    return { id: row!.id, invoiceNumber };
  });
}

const paidSchema = z.object({
  paidOn: isoDate,
  reference: z.string().trim().min(1, "Enter the bank, Mobile Money or cheque reference.").max(60),
});

/** Records that the school paid an invoice. Once only; an invoice that is paid or void stays so. */
export async function markSubscriptionInvoicePaid(
  database: Database,
  actorUserId: string,
  tenantId: string,
  invoiceId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = paidSchema.parse(input);
  await settle(database, actorUserId, tenantId, invoiceId, "paid", async (tx, invoice, today) => {
    if (data.paidOn > today)
      throw new DomainError("future_date", "The payment date cannot be in the future.", "paidOn");
    if (data.paidOn < invoice.issuedOn)
      throw new DomainError("before_issue", "The payment date cannot be before the invoice date.", "paidOn");
    await tx
      .update(subscriptionInvoices)
      .set({ paidOn: data.paidOn, paymentReference: data.reference, paymentRecordedByUserId: actorUserId })
      .where(eq(subscriptionInvoices.id, invoice.id));
    return { paidOn: data.paidOn, reference: data.reference };
  });
}

const voidSchema = z.object({
  reason: z.string().trim().min(5, "Say why the invoice is void.").max(200, "Use 200 characters or fewer."),
});

/** Voids an invoice issued in error. Once only, with a reason; the record stays. */
export async function voidSubscriptionInvoice(
  database: Database,
  actorUserId: string,
  tenantId: string,
  invoiceId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = voidSchema.parse(input);
  await settle(database, actorUserId, tenantId, invoiceId, "voided", async (tx, invoice) => {
    await tx
      .update(subscriptionInvoices)
      .set({ voidedAt: new Date(), voidReason: data.reason, voidedByUserId: actorUserId })
      .where(eq(subscriptionInvoices.id, invoice.id));
    return { reason: data.reason };
  });
}

async function settle(
  database: Database,
  actorUserId: string,
  tenantId: string,
  invoiceId: string,
  outcome: "paid" | "voided",
  apply: (
    tx: Transaction,
    invoice: typeof subscriptionInvoices.$inferSelect,
    today: string,
  ) => Promise<Record<string, unknown>>,
): Promise<void> {
  if (!z.string().uuid().safeParse(invoiceId).success)
    throw new DomainError("not_found", "Invoice not found.");
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(subscriptionInvoices)
      .where(and(eq(subscriptionInvoices.tenantId, tenantId), eq(subscriptionInvoices.id, invoiceId)))
      .for("update");
    if (!invoice) throw new DomainError("not_found", "Invoice not found.");
    if (invoice.paidOn || invoice.voidedAt)
      throw new DomainError(
        "already_settled",
        `This invoice is already ${invoice.paidOn ? "paid" : "void"}.`,
      );
    const [tenant] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const details = await apply(tx, invoice, todayIn(tenant!.timezone));
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: `subscription_invoice.${outcome}`,
      entityType: "subscription_invoice",
      entityId: invoice.id,
      metadata: { invoiceNumber: invoice.invoiceNumber, ...details },
    });
  });
}

// ——— Views ———

export interface PlanView {
  planName: string;
  features: Feature[];
  maxCampuses: number;
  maxStudents: number | null;
  maxSmsPerMonth: number | null;
  status: SubscriptionStatus;
  billingPeriod: BillingPeriod;
  trialEndsOn: string | null;
  paidUntil: string | null;
  pricePesewas: number | null;
  /** Where the school's Mobile Money payments settle (a Paystack subaccount code). */
  settlementAccount: string | null;
  /** This school's own SMS price (null: it uses the platform's). */
  ownSmsPricePesewas: number | null;
  /** The SMS price that applies: its own, else the platform's; null when neither is set. */
  smsPricePesewas: number | null;
  notes: string | null;
  activeCampuses: number;
  activeStudents: number;
  smsThisMonth: number;
  currencyCode: string;
}

async function readPlan(tx: Transaction, tenantId: string, timeZone: string): Promise<PlanView> {
  const [plan] = await tx.select().from(tenantEntitlements).where(eq(tenantEntitlements.tenantId, tenantId));
  const [tenant] = await tx
    .select({ currencyCode: tenants.currencyCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const [campusCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campuses)
    .where(and(eq(campuses.tenantId, tenantId), eq(campuses.status, "active")));
  return {
    planName: plan?.planName ?? "Pilot",
    features: plan ? plan.features.filter(isFeature) : [...FEATURES],
    maxCampuses: plan?.maxCampuses ?? 1,
    maxStudents: plan?.maxStudents ?? null,
    maxSmsPerMonth: plan?.maxSmsPerMonth ?? null,
    status: plan?.subscriptionStatus ?? "trial",
    billingPeriod: plan?.billingPeriod ?? "termly",
    trialEndsOn: plan?.trialEndsOn ?? null,
    paidUntil: plan?.paidUntil ?? null,
    pricePesewas: plan?.pricePesewas ?? null,
    ownSmsPricePesewas: plan?.smsPricePesewas ?? null,
    settlementAccount: plan?.settlementAccount ?? null,
    smsPricePesewas: await smsPriceFor(tx, tenantId),
    notes: plan?.billingNotes ?? null,
    activeCampuses: campusCount?.n ?? 0,
    activeStudents: await activeStudents(tx, tenantId),
    smsThisMonth: await smsUsedThisMonth(tx, tenantId, timeZone),
    currencyCode: tenant?.currencyCode ?? "GHS",
  };
}

export interface SchoolBilling {
  plan: PlanView;
  usage: MonthUsage[];
  invoices: SubscriptionInvoice[];
}

/** A school's plan, usage and invoices, for its Proprietor and Administrator (Settings, Plan). */
export async function getSchoolBilling(database: Database, ctx: TenantContext): Promise<SchoolBilling> {
  assertAllowed(ctx, "plan.view");
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => ({
      plan: await readPlan(tx, ctx.tenant.id, ctx.tenant.timezone),
      usage: await readUsage(tx, ctx.tenant.id, ctx.tenant.timezone, 3),
      invoices: await readInvoices(tx, ctx.tenant.id, todayIn(ctx.tenant.timezone)),
    }),
  );
}

/** The same, for platform staff on the school's page, with six months of usage. */
export async function getSchoolBillingForPlatform(
  database: Database,
  actorUserId: string,
  tenantId: string,
): Promise<SchoolBilling | null> {
  await assertPlatformAdmin(database, actorUserId);
  if (!z.string().uuid().safeParse(tenantId).success) return null;
  const [tenant] = await database.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) return null;
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => ({
    plan: await readPlan(tx, tenantId, tenant.timezone),
    usage: await readUsage(tx, tenantId, tenant.timezone, 6),
    invoices: await readInvoices(tx, tenantId, todayIn(tenant.timezone)),
  }));
}

export interface BillingRow {
  tenantId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  schoolStatus: "active" | "suspended";
  status: SubscriptionStatus;
  paidUntil: string | null;
  activeStudents: number;
  usage: MonthUsage;
  /** Issued, neither paid nor void. */
  unpaidPesewas: number;
  unpaidCount: number;
  /** Price per SMS for this school (null when not set), and what the month's SMS come to. */
  smsPricePesewas: number | null;
  smsChargePesewas: number | null;
  currencyCode: string;
}

/** Every school's billing position for one month: what to invoice and what is unpaid. */
export async function getBillingOverview(
  database: Database,
  actorUserId: string,
  month: string,
): Promise<BillingRow[]> {
  await assertPlatformAdmin(database, actorUserId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DomainError("month_invalid", "Choose a month.");
  const schools = await database.select().from(tenants).orderBy(tenants.name);
  const rows: BillingRow[] = [];
  for (const school of schools) {
    rows.push(
      await withTenant(database, { tenantId: school.id, userId: actorUserId }, async (tx) => {
        const [plan] = await tx
          .select()
          .from(tenantEntitlements)
          .where(eq(tenantEntitlements.tenantId, school.id));
        const usage = (await readUsage(tx, school.id, school.timezone, 24)).find(
          (u) => u.month === month,
        ) ?? {
          month,
          reminders: 0,
          absenceAlerts: 0,
          codes: 0,
          sharedCodes: 0,
          undelivered: 0,
          billable: 0,
        };
        const [unpaid] = await tx
          .select({
            total: sql<string>`coalesce(sum(${subscriptionInvoices.totalPesewas}), 0)`,
            n: sql<number>`count(*)::int`,
          })
          .from(subscriptionInvoices)
          .where(
            and(
              eq(subscriptionInvoices.tenantId, school.id),
              isNull(subscriptionInvoices.paidOn),
              isNull(subscriptionInvoices.voidedAt),
            ),
          );
        return {
          tenantId: school.id,
          name: school.name,
          slug: school.slug,
          isDemo: school.isDemo,
          schoolStatus: school.status,
          status: plan?.subscriptionStatus ?? "trial",
          paidUntil: plan?.paidUntil ?? null,
          activeStudents: await activeStudents(tx, school.id),
          usage,
          unpaidPesewas: Number(unpaid?.total ?? 0),
          unpaidCount: unpaid?.n ?? 0,
          ...(await (async () => {
            const price = await smsPriceFor(tx, school.id);
            return {
              smsPricePesewas: price,
              smsChargePesewas: smsCharge(price, usage.billable),
            };
          })()),
          currencyCode: school.currencyCode,
        };
      }),
    );
  }
  return rows;
}
