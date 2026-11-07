import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { addDays } from "../../lib/attendance";
import {
  ageOwed,
  AGE_BUCKETS,
  percent,
  reminderOutcome,
  weeklyTotals,
  type ReminderOutcome,
  type WeekTotal,
} from "../../lib/dashboard";
import { todayIn } from "../../lib/format";
import { sumPesewas } from "../../lib/money";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  feeReminders,
  ledgerEntries,
  payments,
  paymentVoids,
  students,
  terms,
} from "../db/schema";
import { campusScopeFilter } from "../fees/access";
import { listPaymentTotals, type PaymentTotals } from "../fees/payments";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";

/**
 * Money figures for the school overview. Each one is computed the same way as the report it links to
 * (fee structure, payments, owing), with the same campus scope, so the two always agree.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface FinanceTerm {
  id: string;
  name: string;
  yearName: string;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

async function loadFinanceTerm(
  tx: Transaction,
  ctx: TenantContext,
  termId: string,
): Promise<FinanceTerm | null> {
  const [row] = await tx
    .select({
      id: terms.id,
      name: terms.name,
      yearName: academicYears.name,
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
      isCurrent: terms.isCurrent,
    })
    .from(terms)
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.id, termId)));
  return row ?? null;
}

/**
 * This entry has been reversed (a reversal row points at it). The outer column is written out in full, and
 * every query using it (or campusScopeFilter) joins students, so Drizzle qualifies columns: unqualified,
 * they would bind to the subquery's own table.
 */
const reversed = sql`exists (select 1 from ledger_entries r where r.reverses_entry_id = ledger_entries.id)`;

/** A term's fees as billed: charges less discounts, leaving out any that were reversed. */
async function readBilled(tx: Transaction, ctx: TenantContext, termId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
    .from(ledgerEntries)
    .innerJoin(students, eq(students.id, ledgerEntries.studentId))
    .where(
      and(
        eq(ledgerEntries.tenantId, ctx.tenant.id),
        eq(ledgerEntries.termId, termId),
        inArray(ledgerEntries.kind, ["charge", "discount"]),
        sql`not ${reversed}`,
        campusScopeFilter(ctx, ledgerEntries.studentId),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Billed for a term (charges less discounts), as shown on the fee structure page. */
export async function billedForTerm(database: Database, ctx: TenantContext, termId: string): Promise<number> {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), (tx) => readBilled(tx, ctx, termId));
}

export interface TermFinance {
  term: FinanceTerm;
  /** The days collections are counted over: the term's start to its end, or to today. Null before it starts. */
  period: { from: string; to: string } | null;
  billedPesewas: number;
  /** What families owed when the term began (each family's balance the day before, when owed). */
  owedAtStartPesewas: number;
  collected: PaymentTotals | null;
  /**
   * As a whole percentage, on the school's chosen basis: collected ÷ (owed at the start + billed), or
   * collected ÷ billed for the term.
   */
  collectionRate: number | null;
  collectionRateBasis: "due" | "billed";
  weeks: WeekTotal[];
  reminders: ReminderOutcome;
}

export async function getTermFinance(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<TermFinance | null> {
  assertAllowed(ctx, "fees.view");
  const today = todayIn(ctx.tenant.timezone);
  const base = await withTenant(database, scope(ctx), async (tx) => {
    const term = await loadFinanceTerm(tx, ctx, termId);
    if (!term) return null;
    const period =
      term.startsOn > today ? null : { from: term.startsOn, to: term.endsOn < today ? term.endsOn : today };
    const billedPesewas = await readBilled(tx, ctx, termId);
    const balances = tx
      .select({ balance: sql<string>`sum(${ledgerEntries.amountPesewas})`.as("balance") })
      .from(ledgerEntries)
      .innerJoin(students, eq(students.id, ledgerEntries.studentId))
      .where(
        and(
          eq(ledgerEntries.tenantId, ctx.tenant.id),
          sql`${ledgerEntries.effectiveOn} < ${term.startsOn}`,
          campusScopeFilter(ctx, ledgerEntries.studentId),
        ),
      )
      .groupBy(ledgerEntries.studentId)
      .as("balances");
    const [opening] = await tx
      .select({ owed: sql<string>`coalesce(sum(greatest(${balances.balance}, 0)), 0)` })
      .from(balances);

    let reminders: ReminderOutcome = { reminded: 0, paid: 0, paidPesewas: 0 };
    if (period) {
      const sent = await tx
        .select({ studentId: feeReminders.studentId, sentOn: feeReminders.sentOn })
        .from(feeReminders)
        .innerJoin(students, eq(students.id, feeReminders.studentId))
        .where(
          and(
            eq(feeReminders.tenantId, ctx.tenant.id),
            sql`${feeReminders.sentOn} between ${period.from} and ${period.to}`,
            campusScopeFilter(ctx, feeReminders.studentId),
          ),
        );
      const studentIds = [...new Set(sent.map((r) => r.studentId))];
      const paid = studentIds.length
        ? await tx
            .select({
              id: payments.id,
              studentId: payments.studentId,
              paidOn: payments.paidOn,
              amountPesewas: payments.amountPesewas,
            })
            .from(payments)
            .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
            .where(
              and(
                eq(payments.tenantId, ctx.tenant.id),
                inArray(payments.studentId, studentIds),
                sql`${payments.paidOn} between ${period.from} and ${addDays(period.to, 7)}`,
                sql`${paymentVoids.paymentId} is null`,
              ),
            )
        : [];
      reminders = reminderOutcome(sent, paid);
    }
    const { collectionRateBasis } = await readPreferences(tx, ctx.tenant.id);
    return {
      term,
      period,
      billedPesewas,
      owedAtStartPesewas: Number(opening?.owed ?? 0),
      reminders,
      collectionRateBasis,
    };
  });
  if (!base) return null;
  const collected = base.period
    ? await listPaymentTotals(database, ctx, base.period.from, base.period.to)
    : null;
  const due =
    base.collectionRateBasis === "billed" ? base.billedPesewas : base.owedAtStartPesewas + base.billedPesewas;
  return {
    ...base,
    collected,
    collectionRate: collected ? percent(collected.totalPesewas, due) : null,
    weeks: collected && base.period ? weeklyTotals(collected.days, base.period.from, base.period.to) : [],
  };
}

export interface OwedToday {
  /** Equal to the total on Fees, Owing (no filters). */
  totalPesewas: number;
  students: number;
  /** Pesewas per AGE_BUCKETS; they add up to the total. */
  buckets: number[];
}

/** What families owe now, and how long it has been owed (oldest charges are settled first). */
export async function getOwedToday(database: Database, ctx: TenantContext): Promise<OwedToday> {
  assertAllowed(ctx, "fees.view");
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        studentId: ledgerEntries.studentId,
        amountPesewas: ledgerEntries.amountPesewas,
        effectiveOn: ledgerEntries.effectiveOn,
        // A reversal, or an entry that was reversed: each pair nets to zero and is left out of the ageing.
        paired: sql<boolean>`(${ledgerEntries.reversesEntryId} is not null or ${reversed})`,
      })
      .from(ledgerEntries)
      .innerJoin(students, eq(students.id, ledgerEntries.studentId))
      .where(and(eq(ledgerEntries.tenantId, ctx.tenant.id), campusScopeFilter(ctx, ledgerEntries.studentId)))
      .orderBy(asc(ledgerEntries.studentId), asc(ledgerEntries.effectiveOn), asc(ledgerEntries.entryNumber));
    const byStudent = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId);
      if (list) list.push(row);
      else byStudent.set(row.studentId, [row]);
    }
    const buckets = AGE_BUCKETS.map(() => 0);
    let totalPesewas = 0;
    let owing = 0;
    for (const lines of byStudent.values()) {
      const balance = sumPesewas(lines.map((l) => l.amountPesewas));
      if (balance <= 0) continue;
      owing++;
      totalPesewas += balance;
      ageOwed(
        lines.filter((l) => !l.paired),
        today,
      ).forEach((amount, i) => (buckets[i]! += amount));
    }
    return { totalPesewas, students: owing, buckets };
  });
}
