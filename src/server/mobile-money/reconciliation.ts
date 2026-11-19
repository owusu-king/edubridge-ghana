import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import {
  mobileMoneyRequests,
  payments,
  paymentVoids,
  reconciliationItems,
  reconciliationRuns,
  RECONCILIATION_DIFFERENCES,
  students,
  tenants,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { campusScopeFilter } from "../fees/access";
import type { TenantContext } from "../tenancy/service";
import { ProviderError, type CollectionStatus, type MobileMoneyProvider } from "./provider";
import { providersIn, type MobileMoneyDeps } from "./requests";

/**
 * Daily reconciliation (PAY-04). Each morning, every Mobile Money request a school made the day before is
 * checked again with the provider and compared with what EduBridge recorded: a payment the provider
 * confirms but EduBridge has not recorded, a recorded payment the provider does not confirm, a different
 * amount, or a confirmed payment that was voided. Differences are listed for the Accountant to review;
 * nothing is corrected automatically, because each case needs a person to check the school's statement.
 */

export type ReconciliationDifference = (typeof RECONCILIATION_DIFFERENCES)[number];

/** Runs after this local hour, so the previous day's late prompts have settled. */
const RUN_AFTER_HOUR = 2;

export interface ReconciliationResult {
  checked: number;
  matched: number;
  differences: number;
  errors: number;
}

interface Found {
  requestId: string;
  difference: ReconciliationDifference;
  detail: string;
}

type Row = {
  id: string;
  status: (typeof mobileMoneyRequests.$inferSelect)["status"];
  amountPesewas: number;
  currency: string;
  providerReference: string | null;
  paymentId: string | null;
  receiptNumber: string | null;
  voided: boolean;
};

/** What a provider's answer means for one request, or null when the two agree. */
export function compare(row: Row, status: CollectionStatus): Omit<Found, "requestId"> | null {
  const recorded = row.status === "successful" && row.paymentId !== null;
  if (status.state === "successful") {
    if (!recorded)
      return {
        difference: "not_recorded",
        detail: `The provider confirms ${formatMoney(status.amountPesewas, row.currency)} was paid (transaction ${status.transactionId}), but EduBridge has no payment for it.`,
      };
    if (status.amountPesewas !== row.amountPesewas)
      return {
        difference: "amount_differs",
        detail: `Receipt ${row.receiptNumber} is for ${formatMoney(row.amountPesewas, row.currency)}; the provider reports ${formatMoney(status.amountPesewas, row.currency)}.`,
      };
    if (row.voided)
      return {
        difference: "voided_but_paid",
        detail: `Receipt ${row.receiptNumber} was voided, but the provider confirms the money was paid. The family may be owed a refund.`,
      };
    return null;
  }
  if (recorded)
    return {
      difference: "not_confirmed",
      detail: `Receipt ${row.receiptNumber} records ${formatMoney(row.amountPesewas, row.currency)}, but the provider ${
        status.state === "failed"
          ? "reports the payment failed"
          : status.state === "pending"
            ? "still shows it waiting"
            : "has no record of it"
      }.`,
    };
  return null;
}

/**
 * Reconciles one school's requests of one day, with each provider that sent any (PAY-09). Returns the totals,
 * or null when there was nothing to do (no provider, or every run for the day is done).
 */
export async function reconcileSchool(
  database: Database,
  school: { id: string; timezone: string },
  day: string,
  deps: MobileMoneyDeps = {},
): Promise<ReconciliationResult | null> {
  let total: ReconciliationResult | null = null;
  const providers = providersIn(deps);
  for (const provider of providers) {
    // With several providers, one that sent nothing that day records no run.
    const result = await reconcileWith(database, school, day, provider, providers.length > 1);
    if (!result) continue;
    total ??= { checked: 0, matched: 0, differences: 0, errors: 0 };
    total.checked += result.checked;
    total.matched += result.matched;
    total.differences += result.differences;
    total.errors += result.errors;
  }
  return total;
}

async function reconcileWith(
  database: Database,
  school: { id: string; timezone: string },
  day: string,
  provider: MobileMoneyProvider,
  skipIfEmpty: boolean,
): Promise<ReconciliationResult | null> {
  const scope = { tenantId: school.id, userId: "" };
  const rows = await withTenant(database, scope, async (tx) => {
    const [done] = await tx
      .select({ id: reconciliationRuns.id })
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.tenantId, school.id),
          eq(reconciliationRuns.provider, provider.name),
          eq(reconciliationRuns.runDate, day),
        ),
      );
    if (done) return null;
    return tx
      .select({
        id: mobileMoneyRequests.id,
        status: mobileMoneyRequests.status,
        amountPesewas: mobileMoneyRequests.amountPesewas,
        currency: mobileMoneyRequests.currency,
        providerReference: mobileMoneyRequests.providerReference,
        paymentId: mobileMoneyRequests.paymentId,
        receiptNumber: payments.receiptNumber,
        voided: sql<boolean>`${paymentVoids.paymentId} is not null`,
      })
      .from(mobileMoneyRequests)
      .leftJoin(payments, eq(payments.id, mobileMoneyRequests.paymentId))
      .leftJoin(paymentVoids, eq(paymentVoids.paymentId, mobileMoneyRequests.paymentId))
      .where(
        and(
          eq(mobileMoneyRequests.tenantId, school.id),
          eq(mobileMoneyRequests.provider, provider.name),
          sql`(${mobileMoneyRequests.createdAt} at time zone ${school.timezone})::date = ${day}::date`,
        ),
      );
  });
  if (!rows || (skipIfEmpty && rows.length === 0)) return null;

  const result: ReconciliationResult = { checked: 0, matched: 0, differences: 0, errors: 0 };
  const found: Found[] = [];
  for (const row of rows) {
    // Held for review: already in front of staff. Still waiting: settled by the worker.
    if (row.status === "needs_review" || row.status === "pending") continue;
    let status: CollectionStatus;
    try {
      status = await provider.getStatus({
        tenantId: school.id,
        reference: row.id,
        providerReference: row.providerReference,
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      result.errors++;
      continue;
    }
    result.checked++;
    const difference = compare(row, status);
    if (difference) found.push({ requestId: row.id, ...difference });
    else result.matched++;
  }
  result.differences = found.length;

  await withTenant(database, scope, async (tx) => {
    const [run] = await tx
      .insert(reconciliationRuns)
      .values({ tenantId: school.id, provider: provider.name, runDate: day, ...result })
      .onConflictDoNothing()
      .returning({ id: reconciliationRuns.id });
    if (!run) return; // Another worker finished first.
    if (found.length)
      await tx
        .insert(reconciliationItems)
        .values(found.map((f) => ({ tenantId: school.id, runId: run.id, ...f })));
    await recordAudit(tx, {
      tenantId: school.id,
      actorUserId: null,
      action: "mobile_money.reconciled",
      entityType: "reconciliation_run",
      entityId: run.id,
      metadata: { day, provider: provider.name, ...result },
    });
  });
  return result;
}

/** One worker pass: every active school whose previous day has not been reconciled yet. */
export async function runReconciliation(
  database: Database,
  deps: MobileMoneyDeps = {},
): Promise<{ schools: number; differences: number }> {
  const total = { schools: 0, differences: 0 };
  if (providersIn(deps).length === 0) return total;
  const now = deps.now ?? new Date();
  const schools = await database
    .select({ id: tenants.id, timezone: tenants.timezone })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), eq(tenants.isDemo, false)));
  for (const school of schools) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: school.timezone,
      }).format(now),
    );
    if (hour < RUN_AFTER_HOUR) continue;
    const yesterday = addDays(todayIn(school.timezone, now), -1);
    const done = await reconcileSchool(database, school, yesterday, deps);
    if (done) {
      total.schools++;
      total.differences += done.differences;
    }
  }
  return total;
}

export interface ReconciliationRunRow {
  id: string;
  runDate: string;
  provider: string;
  checked: number;
  matched: number;
  differences: number;
  errors: number;
  finishedAt: Date;
}

export interface ReconciliationItemRow {
  id: string;
  runDate: string;
  requestId: string;
  studentId: string;
  studentName: string;
  admissionNumber: string;
  difference: ReconciliationDifference;
  detail: string;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

const reviewer = alias(users, "reconciliation_reviewer");

/** The Accountant's view: recent runs and the differences (open first), within their campuses. */
export async function getReconciliation(
  database: Database,
  ctx: TenantContext,
): Promise<{ runs: ReconciliationRunRow[]; items: ReconciliationItemRow[] }> {
  assertAllowed(ctx, "fees.view");
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      const runs = await tx
        .select({
          id: reconciliationRuns.id,
          runDate: reconciliationRuns.runDate,
          provider: reconciliationRuns.provider,
          checked: reconciliationRuns.checked,
          matched: reconciliationRuns.matched,
          differences: reconciliationRuns.differences,
          errors: reconciliationRuns.errors,
          finishedAt: reconciliationRuns.finishedAt,
        })
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.tenantId, ctx.tenant.id))
        .orderBy(desc(reconciliationRuns.runDate))
        .limit(14);
      const rows = await tx
        .select({
          id: reconciliationItems.id,
          runDate: reconciliationRuns.runDate,
          requestId: reconciliationItems.requestId,
          studentId: students.id,
          firstName: students.firstName,
          lastName: students.lastName,
          admissionNumber: students.admissionNumber,
          difference: reconciliationItems.difference,
          detail: reconciliationItems.detail,
          reviewedAt: reconciliationItems.reviewedAt,
          reviewedBy: reviewer.name,
          reviewNote: reconciliationItems.reviewNote,
        })
        .from(reconciliationItems)
        .innerJoin(reconciliationRuns, eq(reconciliationRuns.id, reconciliationItems.runId))
        .innerJoin(mobileMoneyRequests, eq(mobileMoneyRequests.id, reconciliationItems.requestId))
        .innerJoin(students, eq(students.id, mobileMoneyRequests.studentId))
        .leftJoin(reviewer, eq(reviewer.id, reconciliationItems.reviewedByUserId))
        .where(
          and(
            eq(reconciliationItems.tenantId, ctx.tenant.id),
            campusScopeFilter(ctx, mobileMoneyRequests.studentId),
          ),
        )
        .orderBy(sql`${reconciliationItems.reviewedAt} is not null`, desc(reconciliationRuns.runDate))
        .limit(100);
      return {
        runs,
        items: rows.map(({ firstName, lastName, ...r }) => ({
          ...r,
          studentName: `${firstName} ${lastName}`,
        })),
      };
    },
  );
}

/** Differences nobody has reviewed yet (for a count on the fees pages). */
export async function countOpenDifferences(database: Database, ctx: TenantContext): Promise<number> {
  assertAllowed(ctx, "fees.view");
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reconciliationItems)
        .innerJoin(mobileMoneyRequests, eq(mobileMoneyRequests.id, reconciliationItems.requestId))
        .where(
          and(
            eq(reconciliationItems.tenantId, ctx.tenant.id),
            isNull(reconciliationItems.reviewedAt),
            campusScopeFilter(ctx, mobileMoneyRequests.studentId),
          ),
        );
      return row?.n ?? 0;
    },
  );
}

const reviewSchema = z.object({
  note: z.string().trim().min(1, "Say what you found.").max(300, "Use 300 characters or fewer."),
});

/** Closes a difference once someone has checked the school's statement and dealt with it. */
export async function reviewDifference(
  database: Database,
  ctx: TenantContext,
  itemId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "payments.record");
  const { note } = reviewSchema.parse(input);
  if (!z.string().uuid().safeParse(itemId).success)
    throw new DomainError("not_found", "Difference not found.");
  await withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      // Only differences about students within the reviewer's campuses.
      const [visible] = await tx
        .select({ id: reconciliationItems.id })
        .from(reconciliationItems)
        .innerJoin(mobileMoneyRequests, eq(mobileMoneyRequests.id, reconciliationItems.requestId))
        .where(
          and(
            eq(reconciliationItems.tenantId, ctx.tenant.id),
            eq(reconciliationItems.id, itemId),
            campusScopeFilter(ctx, mobileMoneyRequests.studentId),
          ),
        );
      const [row] = visible
        ? await tx
            .update(reconciliationItems)
            .set({ reviewedAt: new Date(), reviewedByUserId: ctx.userId, reviewNote: note })
            .where(and(eq(reconciliationItems.id, visible.id), isNull(reconciliationItems.reviewedAt)))
            .returning({ id: reconciliationItems.id, difference: reconciliationItems.difference })
        : [];
      if (!row) throw new DomainError("not_found", "Difference not found, or already reviewed.");
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "mobile_money.difference_reviewed",
        entityType: "reconciliation_item",
        entityId: itemId,
        metadata: { difference: row.difference, note },
      });
    },
  );
}
