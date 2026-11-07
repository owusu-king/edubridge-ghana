import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  familiesOf,
  FIRST_CHILD_RULES,
  ordinalPlace,
  planSiblingDiscounts,
  type Sibling,
  type SiblingRule,
} from "../../lib/siblings";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  feeConcessions,
  feeItems,
  levels,
  siblingDiscountRules,
  studentGuardians,
  students,
  terms,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { assertCanManageSchoolFees } from "./access";
import { formatPercent, parsePercent } from "./concessions";

/**
 * Sibling discounts by the school's own rule: which child counts as first, the second child's discount and
 * later children's, on one fee item or all. Applying the rule adds a discount to each child who qualifies
 * and ends its own earlier discounts that no longer apply; discounts people added by hand are never
 * touched. Discounts take effect when the term is billed, like every scholarship and discount.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface SiblingRuleSettings extends SiblingRule {
  feeItemId: string | null;
  /** False until the school saves a rule with at least one discount. */
  configured: boolean;
}

async function readRule(tx: Transaction, tenantId: string): Promise<SiblingRuleSettings> {
  const [row] = await tx
    .select()
    .from(siblingDiscountRules)
    .where(eq(siblingDiscountRules.tenantId, tenantId));
  return row
    ? {
        firstChild: row.firstChild,
        secondPercentBasisPoints: row.secondPercentBasisPoints,
        laterPercentBasisPoints: row.laterPercentBasisPoints,
        feeItemId: row.feeItemId,
        configured: row.secondPercentBasisPoints !== null || row.laterPercentBasisPoints !== null,
      }
    : {
        firstChild: "eldest",
        secondPercentBasisPoints: null,
        laterPercentBasisPoints: null,
        feeItemId: null,
        configured: false,
      };
}

export async function getSiblingRule(database: Database, ctx: TenantContext): Promise<SiblingRuleSettings> {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), (tx) => readRule(tx, ctx.tenant.id));
}

const percent = (label: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .nullable()
      .transform((text, issue) => {
        if (text === null) return null;
        const bp = parsePercent(text);
        if (bp === null) {
          issue.addIssue({ code: "custom", message: `Enter the ${label} as a percentage from 0.01 to 100.` });
          return z.NEVER;
        }
        return bp;
      }),
  );

const ruleSchema = z.object({
  firstChild: z.enum(FIRST_CHILD_RULES, { message: "Choose which child counts as the first." }),
  secondPercent: percent("second child's discount"),
  laterPercent: percent("discount for later children"),
  feeItemId: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable()),
});

export async function saveSiblingRule(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertCanManageSchoolFees(ctx);
  const data = ruleSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    if (data.feeItemId) {
      const [item] = await tx
        .select({ id: feeItems.id })
        .from(feeItems)
        .where(
          and(
            eq(feeItems.tenantId, ctx.tenant.id),
            eq(feeItems.id, data.feeItemId),
            eq(feeItems.status, "active"),
          ),
        );
      if (!item) throw new DomainError("unknown_item", "Choose a fee item.", "feeItemId");
    }
    const values = {
      firstChild: data.firstChild,
      secondPercentBasisPoints: data.secondPercent,
      laterPercentBasisPoints: data.laterPercent,
      feeItemId: data.feeItemId,
      updatedAt: new Date(),
      updatedByUserId: ctx.userId,
    };
    await tx
      .insert(siblingDiscountRules)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: siblingDiscountRules.tenantId, set: values });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.sibling_rule_saved",
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: {
        firstChild: data.firstChild,
        second: data.secondPercent ? formatPercent(data.secondPercent) : null,
        later: data.laterPercent ? formatPercent(data.laterPercent) : null,
        feeItemId: data.feeItemId,
      },
    });
  });
}

export interface SiblingChange {
  studentId: string;
  name: string;
  admissionNumber: string;
  className: string | null;
  /** The rule's discount for this child now, or null (first child, or no discount for that place). */
  proposed: { place: number; percentBasisPoints: number } | null;
  /** The rule's discount the child has today. */
  current: { id: string; label: string; percentBasisPoints: number; feeItemId: string | null } | null;
  change: "add" | "replace" | "end" | "keep";
}

/** Students in classes this term, grouped into families, with what the rule would change. */
async function planChanges(
  tx: Transaction,
  ctx: TenantContext,
  rule: SiblingRuleSettings,
): Promise<SiblingChange[]> {
  const placed = await tx
    .select({
      id: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
      dateOfBirth: students.dateOfBirth,
      className: classes.name,
      levelSequence: levels.sequence,
    })
    .from(enrolments)
    .innerJoin(terms, and(eq(terms.id, enrolments.termId), eq(terms.isCurrent, true)))
    .innerJoin(students, and(eq(students.id, enrolments.studentId), eq(students.status, "active")))
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .where(eq(enrolments.tenantId, ctx.tenant.id));
  const byId = new Map(placed.map((p) => [p.id, p]));
  const links = placed.length
    ? await tx
        .select({ studentId: studentGuardians.studentId, guardianId: studentGuardians.guardianId })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.tenantId, ctx.tenant.id),
            inArray(studentGuardians.studentId, [...byId.keys()]),
          ),
        )
    : [];
  const families = familiesOf(links).map((ids) =>
    ids.map((id): Sibling => {
      const p = byId.get(id)!;
      return {
        id,
        admissionNumber: p.admissionNumber,
        dateOfBirth: p.dateOfBirth,
        levelSequence: p.levelSequence,
      };
    }),
  );
  const plan = rule.configured ? planSiblingDiscounts(families, rule) : [];
  const existing = await tx
    .select({
      id: feeConcessions.id,
      studentId: feeConcessions.studentId,
      label: feeConcessions.label,
      percentBasisPoints: feeConcessions.percentBasisPoints,
      feeItemId: feeConcessions.feeItemId,
    })
    .from(feeConcessions)
    .where(
      and(
        eq(feeConcessions.tenantId, ctx.tenant.id),
        eq(feeConcessions.source, "sibling_rule"),
        eq(feeConcessions.status, "active"),
      ),
    );
  const ids = new Set([...families.flat().map((c) => c.id), ...existing.map((e) => e.studentId)]);
  const changes: SiblingChange[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    const proposed = plan.find((d) => d.studentId === id) ?? null;
    const current = existing.find((e) => e.studentId === id) ?? null;
    const same =
      proposed &&
      current &&
      current.percentBasisPoints === proposed.percentBasisPoints &&
      current.feeItemId === rule.feeItemId &&
      current.label === labelFor(proposed.place);
    changes.push({
      studentId: id,
      name: p ? `${p.firstName} ${p.lastName}` : "",
      admissionNumber: p?.admissionNumber ?? "",
      className: p?.className ?? null,
      proposed: proposed ? { place: proposed.place, percentBasisPoints: proposed.percentBasisPoints } : null,
      current: current ? { ...current, percentBasisPoints: current.percentBasisPoints ?? 0 } : null,
      change: proposed ? (current ? (same ? "keep" : "replace") : "add") : current ? "end" : "keep",
    });
  }
  return changes;
}

const labelFor = (place: number) => `Sibling discount (${ordinalPlace(place)} child)`;

export async function previewSiblingDiscounts(
  database: Database,
  ctx: TenantContext,
): Promise<SiblingChange[]> {
  assertAllowed(ctx, "fees.view");
  // Families span campuses: only staff with every campus see the whole list.
  if (ctx.campusIds !== null) return [];
  return withTenant(database, scope(ctx), async (tx) =>
    planChanges(tx, ctx, await readRule(tx, ctx.tenant.id)),
  );
}

/** Applies the rule: adds, replaces and ends the rule's own discounts. Returns what changed. */
export async function applySiblingDiscounts(
  database: Database,
  ctx: TenantContext,
): Promise<{ added: number; replaced: number; ended: number }> {
  assertCanManageSchoolFees(ctx);
  return withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"sibling-rule:" + ctx.tenant.id}, 0))`,
    );
    const rule = await readRule(tx, ctx.tenant.id);
    const changes = await planChanges(tx, ctx, rule);
    const now = new Date();
    const end = changes.filter((c) => (c.change === "end" || c.change === "replace") && c.current);
    if (end.length)
      await tx
        .update(feeConcessions)
        .set({ status: "ended", endedAt: now, endedByUserId: ctx.userId, updatedAt: now })
        .where(
          inArray(
            feeConcessions.id,
            end.map((c) => c.current!.id),
          ),
        );
    const add = changes.filter((c) => (c.change === "add" || c.change === "replace") && c.proposed);
    if (add.length)
      await tx.insert(feeConcessions).values(
        add.map((c) => ({
          tenantId: ctx.tenant.id,
          studentId: c.studentId,
          label: labelFor(c.proposed!.place),
          feeItemId: rule.feeItemId,
          percentBasisPoints: c.proposed!.percentBasisPoints,
          amountPesewas: null,
          source: "sibling_rule" as const,
          createdByUserId: ctx.userId,
        })),
      );
    const result = {
      added: changes.filter((c) => c.change === "add").length,
      replaced: changes.filter((c) => c.change === "replace").length,
      ended: changes.filter((c) => c.change === "end").length,
    };
    if (result.added || result.replaced || result.ended)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "fees.sibling_discounts_applied",
        entityType: "fee_concession",
        metadata: result,
      });
    return result;
  });
}
