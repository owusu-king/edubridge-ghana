import "server-only";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseCedis, sumPesewas } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { academicYears, classes, feeItems, feeStructureLines, levels, terms } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { canAccessCampus, type TenantContext } from "../tenancy/service";
import { assertCanManageSchoolFees } from "./access";
import { resolveFees, totalFees } from "./resolve";

/**
 * Fee structures: what each level (and optionally each class) is charged per term, by fee item.
 * Amounts are integer pesewas. Billing (the ledger) copies amounts at the time of billing, so editing a
 * structure never changes what has already been billed.
 */

export interface FeeItem {
  id: string;
  name: string;
  status: "active" | "archived";
}

export interface FeeTerm {
  id: string;
  name: string;
  yearName: string;
  isCurrent: boolean;
  lineCount: number;
}

export interface LevelFees {
  id: string;
  name: string;
  classes: { id: string; name: string; total: number | null }[];
  /** Level amount per fee item id. Items without an amount are not charged. */
  amounts: Record<string, number>;
  /** Overrides per class id, then fee item id. */
  classAmounts: Record<string, Record<string, number>>;
  total: number;
}

export interface FeeStructure {
  items: FeeItem[];
  levels: LevelFees[];
}

/**
 * Common Ghanaian basic-school fee items, offered when a school starts. Assumption to verify with
 * schools: these names, and that feeding is usually paid daily rather than billed per term.
 */
export const SUGGESTED_FEE_ITEMS = [
  "Tuition",
  "PTA dues",
  "Books and stationery",
  "Examination fees",
  "ICT",
] as const;

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });
const itemName = z.string().trim().min(1, "Enter a name.").max(60, "Use 60 characters or fewer.");

function duplicateName(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
    throw new DomainError("duplicate", "A fee item with this name already exists.", "name");
  throw error;
}

export async function listFeeItems(database: Database, ctx: TenantContext): Promise<FeeItem[]> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), (tx) => selectItems(tx, ctx));
}

function selectItems(tx: Transaction, ctx: TenantContext): Promise<FeeItem[]> {
  return tx
    .select({ id: feeItems.id, name: feeItems.name, status: feeItems.status })
    .from(feeItems)
    .where(eq(feeItems.tenantId, ctx.tenant.id))
    .orderBy(asc(feeItems.sequence), asc(feeItems.name));
}

async function nextSequence(tx: Transaction, ctx: TenantContext): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${feeItems.sequence})` })
    .from(feeItems)
    .where(eq(feeItems.tenantId, ctx.tenant.id));
  return (row?.max ?? 0) + 10;
}

export async function createFeeItem(database: Database, ctx: TenantContext, input: unknown): Promise<string> {
  assertCanManageSchoolFees(ctx);
  const { name } = z.object({ name: itemName }).parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const [item] = await tx
      .insert(feeItems)
      .values({ tenantId: ctx.tenant.id, name, sequence: await nextSequence(tx, ctx) })
      .returning({ id: feeItems.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fee_item.created",
      entityType: "fee_item",
      entityId: item!.id,
      metadata: { name },
    });
    return item!.id;
  }).catch(duplicateName);
}

/** Adds the chosen suggested items. Only while the school has no fee items. */
export async function setupFeeItems(database: Database, ctx: TenantContext, input: unknown): Promise<number> {
  assertCanManageSchoolFees(ctx);
  const { names } = z
    .object({ names: z.array(z.enum(SUGGESTED_FEE_ITEMS)).min(1, "Choose at least one item.") })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const [existing] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeItems)
      .where(eq(feeItems.tenantId, ctx.tenant.id));
    if ((existing?.n ?? 0) > 0)
      throw new DomainError("items_exist", "Fee items are already set up. Add items one at a time instead.");
    const chosen = SUGGESTED_FEE_ITEMS.filter((n) => names.includes(n));
    await tx
      .insert(feeItems)
      .values(chosen.map((name, i) => ({ tenantId: ctx.tenant.id, name, sequence: (i + 1) * 10 })));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fee_items.set_up",
      entityType: "fee_item",
      metadata: { names: chosen },
    });
    return chosen.length;
  });
}

export async function renameFeeItem(
  database: Database,
  ctx: TenantContext,
  itemId: string,
  input: unknown,
): Promise<void> {
  assertCanManageSchoolFees(ctx);
  const { name } = z.object({ name: itemName }).parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const [item] = await tx
      .update(feeItems)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(feeItems.tenantId, ctx.tenant.id), eq(feeItems.id, itemId)))
      .returning({ id: feeItems.id });
    if (!item) throw new DomainError("not_found", "This fee item no longer exists.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fee_item.renamed",
      entityType: "fee_item",
      entityId: itemId,
      metadata: { name },
    });
  }).catch(duplicateName);
}

/** Archived items keep their history but are no longer offered in new fee structures. */
export async function setFeeItemStatus(
  database: Database,
  ctx: TenantContext,
  itemId: string,
  status: "active" | "archived",
): Promise<void> {
  assertCanManageSchoolFees(ctx);
  await withTenant(database, scope(ctx), async (tx) => {
    const [item] = await tx
      .update(feeItems)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(feeItems.tenantId, ctx.tenant.id), eq(feeItems.id, itemId)))
      .returning({ name: feeItems.name });
    if (!item) throw new DomainError("not_found", "This fee item no longer exists.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: status === "archived" ? "fee_item.archived" : "fee_item.restored",
      entityType: "fee_item",
      entityId: itemId,
      metadata: { name: item.name },
    });
  });
}

/** Every term, newest first, with how many fee amounts it has (for choosing and copying structures). */
export async function listFeeTerms(database: Database, ctx: TenantContext): Promise<FeeTerm[]> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: terms.id,
        name: terms.name,
        yearName: academicYears.name,
        isCurrent: terms.isCurrent,
        lineCount: sql<number>`(select count(*)::int from ${feeStructureLines} where ${feeStructureLines.termId} = ${terms.id})`,
      })
      .from(terms)
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .where(eq(terms.tenantId, ctx.tenant.id))
      .orderBy(desc(terms.startsOn));
    return rows;
  });
}

export async function getFeeStructure(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<FeeStructure> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    // Sequential: queries in one transaction share a connection.
    const allItems = await selectItems(tx, ctx);
    const levelRows = await tx
      .select({ id: levels.id, name: levels.name })
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.status, "active")))
      .orderBy(asc(levels.sequence), asc(levels.name));
    const classRows = await tx
      .select({ id: classes.id, name: classes.name, levelId: classes.levelId, campusId: classes.campusId })
      .from(classes)
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")))
      .orderBy(asc(classes.name));
    const lines = await selectLines(tx, ctx, termId);
    const used = new Set(lines.map((l) => l.feeItemId));
    const items = allItems.filter((i) => i.status === "active" || used.has(i.id));
    const order = items.map((i) => i.id);
    return {
      items,
      levels: levelRows.map((level) => {
        const amounts: Record<string, number> = {};
        const classAmounts: Record<string, Record<string, number>> = {};
        for (const line of lines) {
          if (line.levelId !== level.id) continue;
          if (line.classId === null) amounts[line.feeItemId] = line.amountPesewas;
          else (classAmounts[line.classId] ??= {})[line.feeItemId] = line.amountPesewas;
        }
        return {
          id: level.id,
          name: level.name,
          amounts,
          classAmounts,
          total: sumPesewas(Object.values(amounts)),
          classes: classRows
            .filter((c) => c.levelId === level.id && canAccessCampus(ctx, c.campusId))
            .map((c) => ({
              id: c.id,
              name: c.name,
              // A class total is shown only where it differs from the level's.
              total: classAmounts[c.id] ? totalFees(resolveFees(lines, level.id, c.id, order)) : null,
            })),
        };
      }),
    };
  });
}

function selectLines(tx: Transaction, ctx: TenantContext, termId: string) {
  return tx
    .select({
      feeItemId: feeStructureLines.feeItemId,
      levelId: feeStructureLines.levelId,
      classId: feeStructureLines.classId,
      amountPesewas: feeStructureLines.amountPesewas,
    })
    .from(feeStructureLines)
    .where(and(eq(feeStructureLines.tenantId, ctx.tenant.id), eq(feeStructureLines.termId, termId)));
}

export interface LevelFeesInput {
  /** Amount text per fee item id, as typed. Blank means the item is not charged. */
  amounts: Record<string, string>;
  /** Amount text per class id, then fee item id. Blank means the class pays the level's amount. */
  classAmounts: Record<string, Record<string, string>>;
}

/** Form field names, shared with the form so errors land on the right input. */
export const levelAmountField = (itemId: string) => `amount:${itemId}`;
export const classAmountField = (classId: string, itemId: string) => `class:${classId}:${itemId}`;

function parseAmount(text: string | undefined, field: string): number | null {
  if (text === undefined || text.trim() === "") return null;
  const pesewas = parseCedis(text);
  if (pesewas === null)
    throw new DomainError("invalid_amount", "Enter an amount in cedis, like 450 or 450.50.", field);
  return pesewas;
}

/** Replaces a level's amounts (and its class overrides) for a term. */
export async function saveLevelFees(
  database: Database,
  ctx: TenantContext,
  termId: string,
  levelId: string,
  input: LevelFeesInput,
): Promise<void> {
  assertCanManageSchoolFees(ctx);
  await withTenant(database, scope(ctx), async (tx) => {
    const [term] = await tx
      .select({ id: terms.id, name: terms.name })
      .from(terms)
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.id, termId)));
    const [level] = await tx
      .select({ id: levels.id, name: levels.name })
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.id, levelId), eq(levels.status, "active")));
    if (!term || !level) throw new DomainError("not_found", "This term or level no longer exists.");

    const activeItems = new Set<string>(
      (await selectItems(tx, ctx)).filter((i) => i.status === "active").map((i) => i.id),
    );
    const levelClasses = new Set(
      (
        await tx
          .select({ id: classes.id })
          .from(classes)
          .where(
            and(
              eq(classes.tenantId, ctx.tenant.id),
              eq(classes.levelId, levelId),
              eq(classes.status, "active"),
            ),
          )
      ).map((c) => c.id),
    );

    if (activeItems.size === 0) throw new DomainError("no_items", "Add a fee item first.");

    const rows: { feeItemId: string; classId: string | null; amountPesewas: number }[] = [];
    for (const [itemId, text] of Object.entries(input.amounts)) {
      if (!activeItems.has(itemId))
        throw new DomainError("unknown_item", "A fee item is no longer available.");
      const amount = parseAmount(text, levelAmountField(itemId));
      if (amount !== null) rows.push({ feeItemId: itemId, classId: null, amountPesewas: amount });
    }
    for (const [classId, byItem] of Object.entries(input.classAmounts)) {
      if (!levelClasses.has(classId))
        throw new DomainError("unknown_class", "A class is no longer part of this level.");
      for (const [itemId, text] of Object.entries(byItem)) {
        if (!activeItems.has(itemId))
          throw new DomainError("unknown_item", "A fee item is no longer available.");
        const amount = parseAmount(text, classAmountField(classId, itemId));
        if (amount !== null) rows.push({ feeItemId: itemId, classId, amountPesewas: amount });
      }
    }

    // Only what the form shows is replaced: amounts for archived items or classes are kept.
    const shownClasses = [...levelClasses];
    await tx
      .delete(feeStructureLines)
      .where(
        and(
          eq(feeStructureLines.tenantId, ctx.tenant.id),
          eq(feeStructureLines.termId, termId),
          eq(feeStructureLines.levelId, levelId),
          inArray(feeStructureLines.feeItemId, [...activeItems]),
          shownClasses.length
            ? or(isNull(feeStructureLines.classId), inArray(feeStructureLines.classId, shownClasses))
            : isNull(feeStructureLines.classId),
        ),
      );
    if (rows.length > 0) {
      await tx
        .insert(feeStructureLines)
        .values(rows.map((r) => ({ ...r, tenantId: ctx.tenant.id, termId, levelId })));
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.structure_updated",
      entityType: "level",
      entityId: levelId,
      metadata: {
        term: term.name,
        level: level.name,
        totalPesewas: sumPesewas(rows.filter((r) => r.classId === null).map((r) => r.amountPesewas)),
        classOverrides: rows.filter((r) => r.classId !== null).length,
      },
    });
  });
}

/**
 * Copies one term's structure into a term that has none, skipping archived items, levels and classes.
 * Returns the number of amounts copied.
 */
export async function copyFeeStructure(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<number> {
  assertCanManageSchoolFees(ctx);
  const { fromTermId, toTermId } = z
    .object({ fromTermId: z.string().uuid("Choose a term to copy from."), toTermId: z.string().uuid() })
    .refine((v) => v.fromTermId !== v.toTermId, { message: "Choose a different term.", path: ["fromTermId"] })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const termRows = await tx
      .select({ id: terms.id, name: terms.name })
      .from(terms)
      .where(and(eq(terms.tenantId, ctx.tenant.id), inArray(terms.id, [fromTermId, toTermId])));
    if (termRows.length !== 2) throw new DomainError("not_found", "This term no longer exists.");
    // Serialise copies into the same term so two people cannot both copy into it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fee-structure:${toTermId}`}))`);
    const [existing] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeStructureLines)
      .where(and(eq(feeStructureLines.tenantId, ctx.tenant.id), eq(feeStructureLines.termId, toTermId)));
    if ((existing?.n ?? 0) > 0)
      throw new DomainError("structure_exists", "This term already has fees. Edit each level instead.");

    const source = await tx
      .select({
        feeItemId: feeStructureLines.feeItemId,
        levelId: feeStructureLines.levelId,
        classId: feeStructureLines.classId,
        amountPesewas: feeStructureLines.amountPesewas,
      })
      .from(feeStructureLines)
      .innerJoin(feeItems, eq(feeItems.id, feeStructureLines.feeItemId))
      .innerJoin(levels, eq(levels.id, feeStructureLines.levelId))
      .leftJoin(classes, eq(classes.id, feeStructureLines.classId))
      .where(
        and(
          eq(feeStructureLines.tenantId, ctx.tenant.id),
          eq(feeStructureLines.termId, fromTermId),
          eq(feeItems.status, "active"),
          eq(levels.status, "active"),
          or(isNull(feeStructureLines.classId), eq(classes.status, "active")),
        ),
      );
    if (source.length === 0)
      throw new DomainError("structure_empty", "The chosen term has no fees to copy.", "fromTermId");
    await tx
      .insert(feeStructureLines)
      .values(source.map((line) => ({ ...line, tenantId: ctx.tenant.id, termId: toTermId })));
    const names = Object.fromEntries(termRows.map((t) => [t.id, t.name]));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.structure_copied",
      entityType: "term",
      entityId: toTermId,
      metadata: { from: names[fromTermId], to: names[toTermId], count: source.length },
    });
    return source.length;
  });
}
