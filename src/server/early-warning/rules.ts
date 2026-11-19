import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_SETTINGS, SETTING_RANGES, type EarlyWarningSettings } from "../../lib/early-warning";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { earlyWarningRules } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/** The school's early-warning rules (R5-3, EWS-01a): the suggested defaults until changed. */

export const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export async function readRules(tx: Transaction, tenantId: string): Promise<EarlyWarningSettings> {
  const [row] = await tx.select().from(earlyWarningRules).where(eq(earlyWarningRules.tenantId, tenantId));
  if (!row) return { ...DEFAULT_SETTINGS };
  const { tenantId: _t, updatedAt: _a, updatedByUserId: _b, ...settings } = row;
  return settings;
}

export async function getRules(database: Database, ctx: TenantContext): Promise<EarlyWarningSettings> {
  assertAllowed(ctx, "early_warning.view");
  return withTenant(database, scopeOf(ctx), (tx) => readRules(tx, ctx.tenant.id));
}

const whole = (key: keyof typeof SETTING_RANGES, label: string) =>
  z.coerce
    .number({ message: `Enter ${label}.` })
    .int(`Enter ${label} as a whole number.`)
    .min(
      SETTING_RANGES[key].min,
      `${label[0]!.toUpperCase()}${label.slice(1)} must be at least ${SETTING_RANGES[key].min}.`,
    )
    .max(
      SETTING_RANGES[key].max,
      `${label[0]!.toUpperCase()}${label.slice(1)} must be at most ${SETTING_RANGES[key].max}.`,
    );
const on = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

const rulesInput = z.object({
  attendanceOn: on,
  attendancePercent: whole("attendancePercent", "the attendance level"),
  attendanceDays: whole("attendanceDays", "the number of days"),
  absencesOn: on,
  absencesInARow: whole("absencesInARow", "the number of absences"),
  averageOn: on,
  averageDrop: whole("averageDrop", "the fall in points"),
  subjectsOn: on,
  subjectsCount: whole("subjectsCount", "the number of subjects"),
  passMark: whole("passMark", "the pass mark"),
});

/** Saves the school's rules (Proprietor or Head teacher); audited with what changed. */
export async function saveRules(database: Database, ctx: TenantContext, input: Record<string, unknown>) {
  assertAllowed(ctx, "early_warning.manage");
  const parsed = rulesInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError("rules_invalid", issue.message, String(issue.path[0] ?? ""));
  }
  const next = parsed.data;
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const before = await readRules(tx, ctx.tenant.id);
    await tx
      .insert(earlyWarningRules)
      .values({ tenantId: ctx.tenant.id, ...next, updatedByUserId: ctx.userId })
      .onConflictDoUpdate({
        target: earlyWarningRules.tenantId,
        set: { ...next, updatedByUserId: ctx.userId, updatedAt: new Date() },
      });
    const changed = (Object.keys(next) as (keyof EarlyWarningSettings)[]).filter(
      (k) => before[k] !== next[k],
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "early_warning.rules_changed",
      entityType: "early_warning_rules",
      metadata: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: next[k] }])),
    });
  });
}
