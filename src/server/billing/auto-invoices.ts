import "server-only";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { addDays } from "../../lib/attendance";
import { formatCalendarDate, todayIn } from "../../lib/format";
import { formatMoney, parseMoney } from "../../lib/money";
import { monthLabel, type BillingPeriod, type InvoiceLine } from "../../lib/plan";
import { MODULES, isPlanModule } from "../../lib/modules";
import {
  bandFor,
  bandLabel,
  discountOf,
  percentLabel,
  periodPrice,
  termlyEquivalent,
  type PriceBand,
} from "../../lib/pricing";
import { recordAudit } from "../audit/record";
import type { Database, Queryable, Transaction } from "../db/client";
import { withTenant, withUser } from "../db/context";
import {
  academicYears,
  platformSettings,
  schoolModules,
  smsTopUps,
  students,
  subscriptionCensus,
  subscriptionInvoices,
  tenantEntitlements,
  tenants,
  terms,
} from "../db/schema";
import { DomainError } from "../errors";
import { enqueue } from "../notifications/outbox";
import { assertPlatformAdmin } from "../platform/service";
import { proprietorEmails } from "./contacts";

/**
 * Automatic invoices (founder, 2026-11-18). A school's plan is priced per term by its size: active students are
 * counted on the census day (a set number of days into each term) and that count prices the term, whatever the
 * billing period. Termly and yearly invoices are issued on the census day, monthly ones on the first of the month;
 * each is due a set number of days later. A school is invoiced once for any day: if an invoice (issued by hand or
 * automatically) already covers part of the period, nothing is issued. Demo schools never are, nor a school whose
 * trial covers the whole period. The database function subscription_issue_automatic_invoice issues them.
 *
 * The same quote is shown to the school (Settings, Plan) and to EduBridge staff as the next invoice.
 */

export interface InvoicingSettings {
  autoInvoicing: boolean;
  censusDays: number;
  invoiceDueDays: number;
  annualDiscountBp: number;
  monthlySurchargeBp: number;
}

export async function readInvoicingSettings(db: Queryable): Promise<InvoicingSettings> {
  const [row] = await db
    .select({
      autoInvoicing: platformSettings.autoInvoicing,
      censusDays: platformSettings.censusDays,
      invoiceDueDays: platformSettings.invoiceDueDays,
      annualDiscountBp: platformSettings.annualDiscountBp,
      monthlySurchargeBp: platformSettings.monthlySurchargeBp,
    })
    .from(platformSettings)
    .limit(1);
  return (
    row ?? {
      autoInvoicing: false,
      censusDays: 21,
      invoiceDueDays: 30,
      annualDiscountBp: 1200,
      monthlySurchargeBp: 1000,
    }
  );
}

export interface InvoiceQuote {
  /**
   * ready: due to be issued now; waiting: issued on `issueOn`; invoiced: an invoice already covers the period;
   * none: not invoiced automatically (see `reason`).
   */
  status: "ready" | "waiting" | "invoiced" | "none";
  reason: string | null;
  billingPeriod: BillingPeriod | null;
  period: { startsOn: string; endsOn: string; label: string } | null;
  issueOn: string | null;
  dueOn: string | null;
  /** Active students the plan is priced on: the census count, or today's count before the census day. */
  students: number | null;
  /** True when `students` is the census count (false: today's count, as an estimate). */
  counted: boolean;
  /** "151 to 300 students", when priced by size. */
  band: string | null;
  lines: InvoiceLine[];
  totalMinor: number;
  currencyCode: string;
  /** Top-ups this invoice charges (marked invoiced when it is issued). */
  topUpIds: string[];
}

interface SchoolRow {
  id: string;
  timezone: string;
  currencyCode: string;
  isDemo: boolean;
}

const none = (reason: string, currencyCode: string): InvoiceQuote => ({
  status: "none",
  reason,
  billingPeriod: null,
  period: null,
  issueOn: null,
  dueOn: null,
  students: null,
  counted: false,
  band: null,
  lines: [],
  totalMinor: 0,
  currencyCode,
  topUpIds: [],
});

const line = (description: string, quantity: number, unitMinor: number): InvoiceLine => ({
  description: description.slice(0, 200),
  quantity,
  unitPesewas: unitMinor,
  amountPesewas: quantity * unitMinor,
});

const monthEnd = (month: string) => addDays(`${addDays(`${month}-01`, 40).slice(0, 7)}-01`, -1);

/** Students who are active today (the plan's limit counts the same). */
async function activeStudents(tx: Transaction, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), eq(students.status, "active")));
  return row?.n ?? 0;
}

/** The current term, with its year and the year's terms in order. Null when no term is current. */
async function currentTerm(tx: Transaction, tenantId: string) {
  const [term] = await tx
    .select({
      id: terms.id,
      name: terms.name,
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
      yearId: academicYears.id,
      yearName: academicYears.name,
      yearEndsOn: academicYears.endsOn,
    })
    .from(terms)
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(and(eq(terms.tenantId, tenantId), eq(terms.isCurrent, true)));
  if (!term) return null;
  const yearTerms = await tx
    .select({ id: terms.id, startsOn: terms.startsOn, endsOn: terms.endsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.academicYearId, term.yearId)))
    .orderBy(asc(terms.startsOn));
  return { ...term, yearTerms };
}

/**
 * The quote for a school's next invoice, inside its tenant transaction. With `takeCensus`, the census is
 * recorded once its day has come (or now, when `force` issues before it).
 */
export async function quoteInTx(
  tx: Transaction,
  school: SchoolRow,
  settings: InvoicingSettings,
  options: { today?: string; takeCensus?: boolean; force?: boolean } = {},
): Promise<InvoiceQuote> {
  const currency = school.currencyCode;
  if (school.isDemo) return none("Demo schools are never invoiced.", currency);
  const today = options.today ?? todayIn(school.timezone);
  const [plan] = await tx.select().from(tenantEntitlements).where(eq(tenantEntitlements.tenantId, school.id));
  if (!plan) return none("The school has no plan yet.", currency);
  const term = await currentTerm(tx, school.id);
  if (!term) return none("The school has not set its current term yet.", currency);

  // The period this invoice covers, and the day it is issued.
  const period = plan.billingPeriod;
  const censusOn = [addDays(term.startsOn, settings.censusDays), term.endsOn].sort()[0]!;
  let startsOn: string;
  let endsOn: string;
  let issueOn: string;
  let label: string;
  let covered = 1;
  if (period === "termly") {
    [startsOn, endsOn, issueOn] = [term.startsOn, term.endsOn, censusOn];
    label = `${term.name}, ${term.yearName}`;
  } else if (period === "annual") {
    const rest = term.yearTerms.filter((t) => t.startsOn >= term.startsOn);
    covered = Math.max(1, rest.length);
    [startsOn, endsOn, issueOn] = [term.startsOn, term.yearEndsOn, censusOn];
    label =
      covered === term.yearTerms.length
        ? `school year ${term.yearName}`
        : `${term.name} to the end of ${term.yearName}`;
  } else {
    const month = today.slice(0, 7);
    [startsOn, endsOn, issueOn] = [`${month}-01`, monthEnd(month), `${month}-01`];
    label = monthLabel(month);
  }
  const base = {
    billingPeriod: period,
    period: { startsOn, endsOn, label },
    issueOn,
    currencyCode: currency,
  };

  if (plan.subscriptionStatus === "trial" && (plan.trialEndsOn === null || plan.trialEndsOn >= endsOn))
    return {
      ...none(
        plan.trialEndsOn
          ? `The trial covers this period (until ${formatCalendarDate(plan.trialEndsOn)}).`
          : "The school is on a trial with no end date.",
        currency,
      ),
      ...base,
    };

  const [covering] = await tx
    .select({ number: subscriptionInvoices.invoiceNumber })
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.tenantId, school.id),
        isNull(subscriptionInvoices.voidedAt),
        sql`${subscriptionInvoices.periodStartsOn} <= ${endsOn}`,
        sql`${subscriptionInvoices.periodEndsOn} >= ${startsOn}`,
      ),
    )
    .limit(1);
  if (covering)
    return {
      ...none(`Invoice ${covering.number} already covers this period.`, currency),
      ...base,
      status: "invoiced",
    };

  // Students: the term's census once taken (recorded on its day), otherwise today's count as an estimate.
  const [census] = await tx
    .select({ active: subscriptionCensus.activeStudents })
    .from(subscriptionCensus)
    .where(and(eq(subscriptionCensus.tenantId, school.id), eq(subscriptionCensus.termId, term.id)));
  let studentsCounted = census?.active ?? null;
  if (studentsCounted === null && options.takeCensus && (today >= censusOn || options.force)) {
    studentsCounted = await activeStudents(tx, school.id);
    await tx
      .insert(subscriptionCensus)
      .values({ tenantId: school.id, termId: term.id, countedOn: today, activeStudents: studentsCounted })
      .onConflictDoNothing();
  }
  const studentCount = studentsCounted ?? (await activeStudents(tx, school.id));
  const rules = {
    annualDiscountBp: settings.annualDiscountBp,
    monthlySurchargeBp: settings.monthlySurchargeBp,
  };
  const termsInYear = Math.max(1, term.yearTerms.length);
  const forPeriod = (termlyMinor: number) =>
    periodPrice(termlyMinor, period, rules, { inYear: termsInYear, covered });
  const periodWords =
    period === "annual"
      ? ` (${covered} ${covered === 1 ? "term" : "terms"}, ${percentLabel(rules.annualDiscountBp)} off for paying yearly)`
      : "";

  // The plan: an agreed price for the period, else the plan's price for the school's size.
  const lines: InvoiceLine[] = [];
  let band: PriceBand | null = null;
  const bands = plan.priceBands;
  if (plan.pricePesewas !== null) {
    lines.push(line(`${plan.planName} plan, ${label} (agreed price)`, 1, plan.pricePesewas));
  } else if (bands && bands.length > 0) {
    band = bandFor(studentCount, bands);
    if (!band)
      return {
        ...none(
          `More than ${bands[bands.length - 1]!.upTo.toLocaleString("en-GH")} students: agree a price with the school.`,
          currency,
        ),
        ...base,
        students: studentCount,
        counted: studentsCounted !== null,
      };
    lines.push(
      line(
        `${plan.planName} plan, ${label}: ${studentCount.toLocaleString("en-GH")} active students (${bandLabel(band, bands)})${periodWords}`,
        1,
        forPeriod(band.termlyMinor),
      ),
    );
  } else {
    return { ...none("No price yet: set the school's plan or an agreed price.", currency), ...base };
  }

  // Priced add-ons covering the first day, converted to this period (and its yearly or monthly terms).
  const grants = await tx
    .select()
    .from(schoolModules)
    .where(
      and(
        eq(schoolModules.tenantId, school.id),
        isNull(schoolModules.endedAt),
        sql`${schoolModules.startsOn} <= ${startsOn > today ? startsOn : today}`,
        sql`(${schoolModules.endsOn} is null or ${schoolModules.endsOn} >= ${startsOn > today ? startsOn : today})`,
        sql`${schoolModules.pricePesewas} > 0`,
      ),
    );
  for (const g of grants) {
    if (!isPlanModule(g.module) || g.pricePesewas === null) continue;
    if (g.currencyCode && g.currencyCode !== currency) continue;
    const termly = termlyEquivalent(g.pricePesewas, g.billingPeriod ?? "termly", termsInYear);
    const unit = forPeriod(termly);
    const name = `${MODULES[g.module].name} (${g.source === "enterprise" ? "agreement" : "add-on"}), ${label}`;
    if (g.priceUnit === "per_student") {
      if (studentCount > 0) lines.push(line(`${name}, per active student`, studentCount, unit));
    } else lines.push(line(name, 1, unit));
  }

  // The school's discount, on the plan and add-ons, while it lasts.
  const subtotal = lines.reduce((a, l) => a + l.amountPesewas, 0);
  if (plan.discountBp && (plan.discountUntil === null || plan.discountUntil >= today)) {
    const off = discountOf(subtotal, plan.discountBp);
    if (off > 0)
      lines.push(line(`${plan.discountLabel ?? "Discount"} (${percentLabel(plan.discountBp)} off)`, 1, -off));
  }

  // SMS top-ups not yet invoiced.
  const topUps = await tx
    .select()
    .from(smsTopUps)
    .where(and(eq(smsTopUps.tenantId, school.id), isNull(smsTopUps.invoiceId)))
    .orderBy(asc(smsTopUps.createdAt));
  for (const t of topUps)
    if (t.currencyCode === currency && t.pricePesewas > 0)
      lines.push(
        line(
          `SMS top-up, ${monthLabel(t.month)}: ${t.messages.toLocaleString("en-GH")} messages`,
          1,
          t.pricePesewas,
        ),
      );

  const totalMinor = lines.reduce((a, l) => a + l.amountPesewas, 0);
  const ready = today >= issueOn || options.force === true;
  return {
    status: totalMinor <= 0 ? "none" : ready ? "ready" : "waiting",
    reason: totalMinor <= 0 ? "Nothing to charge for this period." : null,
    ...base,
    dueOn: addDays(ready ? today : issueOn, settings.invoiceDueDays),
    students: studentCount,
    counted: studentsCounted !== null,
    band: band && bands ? bandLabel(band, bands) : null,
    lines,
    totalMinor,
    topUpIds: topUps.filter((t) => t.currencyCode === currency && t.pricePesewas > 0).map((t) => t.id),
  };
}

const schoolRow = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  timezone: tenants.timezone,
  currencyCode: tenants.currencyCode,
  isDemo: tenants.isDemo,
};

/** Issues a quote that is ready: the database function issues it once; the Proprietors are emailed. */
async function issueInTx(
  tx: Transaction,
  school: SchoolRow & { name: string; slug: string },
  quote: InvoiceQuote,
  actorUserId: string | null,
): Promise<{ id: string; invoiceNumber: string } | null> {
  if (quote.status !== "ready" || !quote.period || !quote.dueOn) return null;
  const result = await tx.execute<{ invoice_id: string; invoice_number: string }>(
    sql`select * from subscription_issue_automatic_invoice(
      ${quote.period.startsOn}::date, ${quote.period.endsOn}::date, ${quote.dueOn}::date,
      ${JSON.stringify(quote.lines)}::jsonb, ${quote.students}, ${`{${quote.topUpIds.join(",")}}`}::uuid[])`,
  );
  const row = result.rows[0];
  if (!row) return null;
  for (const email of await proprietorEmails(tx, school.id))
    await enqueue(tx, {
      channel: "email",
      recipient: email,
      template: "subscription_invoice",
      payload: {
        schoolName: school.name,
        schoolSlug: school.slug,
        invoiceNumber: row.invoice_number,
        total: formatMoney(quote.totalMinor, quote.currencyCode),
        dueOn: formatCalendarDate(quote.dueOn),
      },
      idempotencyKey: `invoice:${row.invoice_id}`,
    });
  await recordAudit(tx, {
    tenantId: school.id,
    actorUserId,
    action: "subscription_invoice.issued_automatically",
    entityType: "subscription_invoice",
    entityId: row.invoice_id,
    metadata: {
      invoiceNumber: row.invoice_number,
      totalPesewas: quote.totalMinor,
      period: [quote.period.startsOn, quote.period.endsOn],
      students: quote.students,
      byHand: actorUserId !== null,
    },
  });
  return { id: row.invoice_id, invoiceNumber: row.invoice_number };
}

/**
 * The worker's run: for every active school (never demo schools), takes the term's census on its day and issues
 * the invoice that is due. Does nothing while automatic invoices are off (Billing, platform staff).
 */
export async function runAutomaticInvoicing(
  database: Database,
  options: { only?: string[]; today?: string } = {},
): Promise<{ checked: number; issued: number }> {
  const settings = await readInvoicingSettings(database);
  if (!settings.autoInvoicing) return { checked: 0, issued: 0 };
  const schools = await database
    .select(schoolRow)
    .from(tenants)
    .where(
      and(
        eq(tenants.status, "active"),
        eq(tenants.isDemo, false),
        options.only ? inArray(tenants.id, options.only) : undefined,
      ),
    );
  let issued = 0;
  for (const school of schools) {
    const invoice = await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      const quote = await quoteInTx(tx, school, settings, { today: options.today, takeCensus: true });
      return issueInTx(tx, school, quote, null);
    });
    if (invoice) issued++;
  }
  return { checked: schools.length, issued };
}

/**
 * Issues one school's invoice for its current period now (platform staff), even before the census day or while
 * automatic invoices are off. The census is taken now if it has not been. Refused when nothing can be issued.
 */
export async function issueAutomaticInvoiceNow(
  database: Database,
  actorUserId: string,
  tenantId: string,
): Promise<{ invoiceNumber: string }> {
  await assertPlatformAdmin(database, actorUserId);
  const settings = await readInvoicingSettings(database);
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [school] = await tx.select(schoolRow).from(tenants).where(eq(tenants.id, tenantId));
    if (!school) throw new DomainError("school_not_found", "School not found.");
    const quote = await quoteInTx(tx, school, settings, { takeCensus: true, force: true });
    const invoice = await issueInTx(tx, school, quote, actorUserId);
    if (!invoice)
      throw new DomainError("nothing_to_invoice", quote.reason ?? "Nothing can be invoiced for this period.");
    return { invoiceNumber: invoice.invoiceNumber };
  });
}

/** The next invoice for a school, as the school sees it (inside its tenant context; read only). */
export async function quoteForSchool(
  database: Database,
  scope: { tenantId: string; userId: string; supportGrantId?: string },
): Promise<InvoiceQuote> {
  const settings = await readInvoicingSettings(database);
  return withTenant(database, scope, async (tx) => {
    const [school] = await tx.select(schoolRow).from(tenants).where(eq(tenants.id, scope.tenantId));
    if (!school) throw new DomainError("school_not_found", "School not found.");
    return quoteInTx(tx, school, settings);
  });
}

/**
 * Reminders to the Proprietors about open invoices: a week before the due date, and once after it has passed.
 * Each is sent once (the outbox keeps one message per key). Demo schools are never reminded.
 */
export async function runInvoiceReminders(
  database: Database,
  options: { only?: string[]; today?: string } = {},
): Promise<{ dueSoon: number; overdue: number }> {
  const schools = await database
    .select(schoolRow)
    .from(tenants)
    .where(
      and(
        eq(tenants.status, "active"),
        eq(tenants.isDemo, false),
        options.only ? inArray(tenants.id, options.only) : undefined,
      ),
    );
  let dueSoon = 0;
  let overdue = 0;
  for (const school of schools) {
    await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      const today = options.today ?? todayIn(school.timezone);
      const open = await tx
        .select()
        .from(subscriptionInvoices)
        .where(
          and(
            eq(subscriptionInvoices.tenantId, school.id),
            isNull(subscriptionInvoices.paidOn),
            isNull(subscriptionInvoices.voidedAt),
          ),
        );
      const emails = open.length ? await proprietorEmails(tx, school.id) : [];
      for (const invoice of open) {
        const kind =
          today > invoice.dueOn
            ? "overdue"
            : today >= addDays(invoice.dueOn, -7) && invoice.issuedOn < addDays(invoice.dueOn, -7)
              ? "due_soon"
              : null;
        if (!kind) continue;
        for (const email of emails)
          await enqueue(tx, {
            channel: "email",
            recipient: email,
            template: kind === "overdue" ? "subscription_invoice_overdue" : "subscription_invoice_due_soon",
            payload: {
              schoolName: school.name,
              schoolSlug: school.slug,
              invoiceNumber: invoice.invoiceNumber,
              total: formatMoney(invoice.totalPesewas, invoice.currencyCode),
              dueOn: formatCalendarDate(invoice.dueOn),
            },
            idempotencyKey: `invoice-${kind}:${invoice.id}:${email}`,
          });
        if (kind === "overdue") overdue++;
        else dueSoon++;
      }
    });
  }
  return { dueSoon, overdue };
}

// ——— SMS top-ups (platform staff) ———

/** Adds extra SMS for this month for a school, charged on its next invoice. */
export async function addSmsTopUp(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: { messages: unknown; price: unknown },
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const messages = Number(input.messages);
  if (!Number.isInteger(messages) || messages < 1 || messages > 1_000_000)
    throw new DomainError("messages_invalid", "Enter how many SMS, like 500.", "messages");
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [school] = await tx
      .select({ timezone: tenants.timezone, currencyCode: tenants.currencyCode })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!school) throw new DomainError("school_not_found", "School not found.");
    const price = parseMoney(String(input.price ?? "").trim(), school.currencyCode);
    if (price === null || price > 1_000_000_000)
      throw new DomainError("price_invalid", "Enter the price of the top-up, like 50.", "price");
    const month = todayIn(school.timezone).slice(0, 7);
    const [row] = await tx
      .insert(smsTopUps)
      .values({
        tenantId,
        month,
        messages,
        pricePesewas: price,
        currencyCode: school.currencyCode,
        addedByUserId: actorUserId,
      })
      .returning({ id: smsTopUps.id });
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: "sms_top_up.added",
      entityType: "sms_top_up",
      entityId: row!.id,
      metadata: { month, messages, pricePesewas: price },
    });
  });
}

/** Extra SMS added for a month (raises that month's allowance). */
export async function topUpMessages(tx: Transaction, tenantId: string, month: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${smsTopUps.messages}), 0)::int` })
    .from(smsTopUps)
    .where(and(eq(smsTopUps.tenantId, tenantId), eq(smsTopUps.month, month)));
  return row?.n ?? 0;
}

// ——— Revenue (platform staff) ———

export interface RevenueOverview {
  year: string;
  byCurrency: {
    currencyCode: string;
    invoiced: number;
    collected: number;
    outstanding: number;
    overdue: number;
  }[];
  byPlan: { planName: string; schools: number; invoiced: number; currencyCode: string }[];
  /** Active schools with a plan that cannot be invoiced automatically for lack of a price. */
  needPrice: { id: string; name: string; planName: string }[];
}

/** Invoiced, collected and owed this calendar year, by currency and plan, and schools needing a price. */
export async function getRevenueOverview(
  database: Database,
  actorUserId: string,
  year: string,
): Promise<RevenueOverview> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const today = todayIn("Africa/Accra");
    const totals = await tx.execute<{
      currency_code: string;
      invoiced: string;
      collected: string;
      outstanding: string;
      overdue: string;
    }>(sql`
      select currency_code,
        sum(total_pesewas) as invoiced,
        sum(total_pesewas) filter (where paid_on is not null) as collected,
        sum(total_pesewas) filter (where paid_on is null) as outstanding,
        sum(total_pesewas) filter (where paid_on is null and due_on < ${today}) as overdue
      from subscription_invoices
      where voided_at is null and to_char(issued_on, 'YYYY') = ${year}
      group by currency_code order by currency_code`);
    const plans = await tx.execute<{
      plan_name: string;
      schools: number;
      invoiced: string | null;
      currency_code: string;
    }>(sql`
      select e.plan_name, count(distinct e.tenant_id)::int as schools, t.currency_code,
        sum(i.total_pesewas) filter (where i.voided_at is null and to_char(i.issued_on, 'YYYY') = ${year}) as invoiced
      from tenant_entitlements e
      join tenants t on t.id = e.tenant_id and t.status = 'active' and not t.is_demo
      left join subscription_invoices i on i.tenant_id = e.tenant_id
      group by e.plan_name, t.currency_code order by e.plan_name`);
    const needPrice = await tx
      .select({ id: tenants.id, name: tenants.name, planName: tenantEntitlements.planName })
      .from(tenantEntitlements)
      .innerJoin(tenants, eq(tenants.id, tenantEntitlements.tenantId))
      .where(
        and(
          eq(tenants.status, "active"),
          eq(tenants.isDemo, false),
          isNull(tenantEntitlements.pricePesewas),
          isNull(tenantEntitlements.priceBands),
        ),
      )
      .orderBy(asc(tenants.name));
    const n = (v: string | null | undefined) => Number(v ?? 0);
    return {
      year,
      byCurrency: totals.rows.map((r) => ({
        currencyCode: r.currency_code,
        invoiced: n(r.invoiced),
        collected: n(r.collected),
        outstanding: n(r.outstanding),
        overdue: n(r.overdue),
      })),
      byPlan: plans.rows.map((r) => ({
        planName: r.plan_name,
        schools: r.schools,
        invoiced: n(r.invoiced),
        currencyCode: r.currency_code,
      })),
      needPrice,
    };
  });
}
