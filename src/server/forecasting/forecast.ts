import "server-only";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { addDays } from "../../lib/attendance";
import {
  backtestLastTerm,
  dayOfTerm,
  forecastTerm,
  type Backtest,
  type DayTotal,
  type Forecast,
  type TermHistory,
} from "../../lib/forecast";
import { todayIn } from "../../lib/format";
import { assertAllowed } from "../authz/permissions";
import { readBilled } from "../dashboard/finance";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  paymentPlanInstalments,
  paymentPlans,
  payments,
  paymentVoids,
  terms,
} from "../db/schema";
import { campusScopeFilter } from "../fees/access";
import type { TenantContext } from "../tenancy/service";

/**
 * The collection forecast for a term (R5-2, FCT-01): the method is in `src/lib/forecast.ts`; this reads the history
 * it needs. Billed fees use the overview's own query (charges less discounts, reversals left out) and collected
 * money the payments report's rule (payments by date, voided ones left out), with the same campus scope.
 */

/** Up to this many complete past terms are learned from. */
const HISTORY_TERMS = 6;

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

interface TermRow {
  id: string;
  name: string;
  yearName: string;
  startsOn: string;
  endsOn: string;
}

const termColumns = {
  id: terms.id,
  name: terms.name,
  yearName: academicYears.name,
  startsOn: terms.startsOn,
  endsOn: terms.endsOn,
};

async function paymentDays(
  tx: Transaction,
  ctx: TenantContext,
  from: string,
  to: string,
): Promise<DayTotal[]> {
  const rows = await tx
    .select({ date: payments.paidOn, total: sql<string>`sum(${payments.amountPesewas})` })
    .from(payments)
    .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
    .where(
      and(
        eq(payments.tenantId, ctx.tenant.id),
        sql`${payments.paidOn} between ${from} and ${to}`,
        isNull(paymentVoids.paymentId),
        campusScopeFilter(ctx, payments.studentId),
      ),
    )
    .groupBy(payments.paidOn)
    .orderBy(asc(payments.paidOn));
  return rows.map((r) => ({ date: r.date, totalPesewas: Number(r.total) }));
}

/** Instalments of active payment plans due in a period, by day. */
async function instalmentDays(
  tx: Transaction,
  ctx: TenantContext,
  from: string,
  to: string,
): Promise<DayTotal[]> {
  if (to < from) return [];
  const rows = await tx
    .select({
      date: paymentPlanInstalments.dueOn,
      total: sql<string>`sum(${paymentPlanInstalments.amountPesewas})`,
    })
    .from(paymentPlanInstalments)
    .innerJoin(paymentPlans, eq(paymentPlans.id, paymentPlanInstalments.planId))
    .where(
      and(
        eq(paymentPlanInstalments.tenantId, ctx.tenant.id),
        eq(paymentPlans.status, "active"),
        sql`${paymentPlanInstalments.dueOn} between ${from} and ${to}`,
        campusScopeFilter(ctx, paymentPlans.studentId),
      ),
    )
    .groupBy(paymentPlanInstalments.dueOn);
  return rows.map((r) => ({ date: r.date, totalPesewas: Number(r.total) }));
}

export interface CollectionForecast {
  term: { id: string; label: string; startsOn: string; endsOn: string };
  /** The day the forecast is made on (the school's today). */
  asOf: string;
  forecast: Forecast;
  /** Last complete term's forecast at the same day of term, against what it collected. */
  backtest: Backtest | null;
}

/** The forecast for a term, for the person's campuses (or the campus they chose). Null when no such term. */
export async function getCollectionForecast(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<CollectionForecast | null> {
  assertAllowed(ctx, "forecasting.view");
  if (!/^[0-9a-f-]{36}$/i.test(termId)) return null;
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const [term] = await tx
      .select(termColumns)
      .from(terms)
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.id, termId)));
    if (!term) return null;
    // Complete terms before this one, newest first.
    const past: TermRow[] = await tx
      .select(termColumns)
      .from(terms)
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .where(
        and(eq(terms.tenantId, ctx.tenant.id), lt(terms.startsOn, term.startsOn), lt(terms.endsOn, today)),
      )
      .orderBy(desc(terms.startsOn))
      .limit(HISTORY_TERMS);
    const all = [term, ...past];
    const earliest = past.at(-1)?.startsOn ?? term.startsOn;
    const [days, plans, ...billed] = await Promise.all([
      paymentDays(tx, ctx, earliest, term.endsOn < today ? term.endsOn : today),
      instalmentDays(tx, ctx, addDays(today, 1), term.endsOn),
      ...all.map((t) => readBilled(tx, ctx, t.id)),
    ]);
    const history = (t: TermRow, i: number): TermHistory => ({
      termId: t.id,
      label: `${t.name}, ${t.yearName}`,
      startsOn: t.startsOn,
      endsOn: t.endsOn,
      billedPesewas: billed[i] ?? 0,
      days: days.filter((d) => d.date >= t.startsOn && d.date <= t.endsOn),
    });
    const [current, ...earlier] = all.map(history);
    return {
      term: { id: term.id, label: current!.label, startsOn: term.startsOn, endsOn: term.endsOn },
      asOf: today,
      forecast: forecastTerm(current!, earlier, today, plans),
      backtest: backtestLastTerm(earlier, today, dayOfTerm(term.startsOn, today)),
    };
  });
}
