import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { addDays } from "../../lib/attendance";
import { todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Queryable } from "../db/client";
import { withTenant } from "../db/context";
import { financePeriodLocks, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Closing the books (FIN-16). Once a period is closed, nothing can be posted or paid with a date on or before
 * it (a database trigger refuses it, whichever screen or API is used); corrections go into an open period
 * (reversals and voids are dated today). The Proprietor or Accountant closes periods; only the Proprietor
 * can reopen one, with a reason. Every change is kept and audited.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export async function readLockedThrough(tx: Queryable, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ lockedThrough: financePeriodLocks.lockedThrough })
    .from(financePeriodLocks)
    .where(eq(financePeriodLocks.tenantId, tenantId))
    .orderBy(desc(financePeriodLocks.setAt), desc(financePeriodLocks.id))
    .limit(1);
  return row?.lockedThrough ?? null;
}

/** The first date that can be posted to: `wanted`, or the day after the closed period if later. */
export async function firstOpenDate(tx: Queryable, tenantId: string, wanted: string): Promise<string> {
  const locked = await readLockedThrough(tx, tenantId);
  return locked && wanted <= locked ? addDays(locked, 1) : wanted;
}

export interface PeriodLockView {
  lockedThrough: string | null;
  history: { lockedThrough: string | null; reason: string | null; by: string; at: Date }[];
}

export async function getPeriodLock(database: Database, ctx: TenantContext): Promise<PeriodLockView> {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const history = await tx
      .select({
        lockedThrough: financePeriodLocks.lockedThrough,
        reason: financePeriodLocks.reason,
        by: users.name,
        at: financePeriodLocks.setAt,
      })
      .from(financePeriodLocks)
      .innerJoin(users, eq(users.id, financePeriodLocks.setByUserId))
      .where(eq(financePeriodLocks.tenantId, ctx.tenant.id))
      .orderBy(desc(financePeriodLocks.setAt), desc(financePeriodLocks.id))
      .limit(30);
    return { lockedThrough: history[0]?.lockedThrough ?? null, history };
  });
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

/** Closes the books up to a date (today or earlier, after the current closing date). */
export async function closePeriod(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "fees.close_periods");
  const { through } = z.object({ through: date }).parse(input);
  if (through > todayIn(ctx.tenant.timezone))
    throw new DomainError("future_date", "A period can only be closed up to today.", "through");
  await withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"period-lock:" + ctx.tenant.id}, 0))`,
    );
    const current = await readLockedThrough(tx, ctx.tenant.id);
    if (current && through <= current)
      throw new DomainError("already_closed", `The books are already closed up to ${current}.`, "through");
    await tx
      .insert(financePeriodLocks)
      .values({ tenantId: ctx.tenant.id, lockedThrough: through, setByUserId: ctx.userId });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.period_closed",
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: { from: current, to: through },
    });
  });
}

/** Reopens part or all of a closed period. The Proprietor's alone, with a reason. */
export async function reopenPeriod(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "fees.reopen_periods");
  const data = z
    .object({
      through: z.preprocess((v) => (v === "" ? null : v), date.nullable()),
      reason: z
        .string()
        .trim()
        .min(3, "Say why the period is reopened.")
        .max(300, "Use 300 characters or fewer."),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"period-lock:" + ctx.tenant.id}, 0))`,
    );
    const current = await readLockedThrough(tx, ctx.tenant.id);
    if (!current) throw new DomainError("not_closed", "No period is closed.");
    if (data.through && data.through >= current)
      throw new DomainError(
        "not_earlier",
        `Choose a date before ${current}, or leave it empty to reopen everything.`,
        "through",
      );
    await tx.insert(financePeriodLocks).values({
      tenantId: ctx.tenant.id,
      lockedThrough: data.through,
      reason: data.reason,
      setByUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.period_reopened",
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: { from: current, to: data.through, reason: data.reason },
    });
  });
}
