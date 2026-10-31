import "server-only";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { sumPesewas } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  classes,
  enrolments,
  feeConcessions,
  feeItems,
  feeStructureLines,
  ledgerEntries,
  students,
  terms,
  users,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { assertCanManageSchoolFees, loadFinanceStudent } from "./access";
import { planBilling, type BillingPlan } from "./billing-plan";
import { planDiscounts, type ChargeBase, type PlannedDiscount } from "./discount-plan";

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

/**
 * Whether an entry has been reversed (a reversal row points at it). The outer column is written out in
 * full: Drizzle leaves it unqualified in single-table queries, where it would bind to the inner `r`.
 */
const isReversed = sql<boolean>`exists (select 1 from ledger_entries r where r.reverses_entry_id = ledger_entries.id)`;

export interface BillingStatus {
  /** Active students placed in a class this term. */
  enrolled: number;
  billedStudents: number;
  studentsToBill: number;
  chargesToCreate: number;
  /** Discounts from scholarships and other concessions still to apply. */
  discountsToCreate: number;
  discountsPesewas: number;
  /** Net: charges less discounts. */
  amountToBillPesewas: number;
  /** Charges that no longer match the structure (first 50). */
  differences: BillingDifferenceRow[];
  differenceCount: number;
}

export interface BillingDifferenceRow {
  studentId: string;
  studentName: string;
  admissionNumber: string;
  itemName: string;
  billedPesewas: number;
  structurePesewas: number;
}

async function loadTerm(tx: Transaction, ctx: TenantContext, termId: string) {
  if (!z.string().uuid().safeParse(termId).success) return null;
  const [term] = await tx
    .select({ id: terms.id, name: terms.name, startsOn: terms.startsOn, yearName: academicYears.name })
    .from(terms)
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.id, termId)));
  return term ?? null;
}

/** Everything the billing planner needs for a term, read in one transaction. */
async function planTerm(tx: Transaction, ctx: TenantContext, termId: string): Promise<TermPlan> {
  const enrolled = await tx
    .select({ studentId: enrolments.studentId, classId: enrolments.classId, levelId: classes.levelId })
    .from(enrolments)
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(
      and(
        eq(enrolments.tenantId, ctx.tenant.id),
        eq(enrolments.termId, termId),
        eq(students.status, "active"),
      ),
    );
  const lines = await tx
    .select({
      feeItemId: feeStructureLines.feeItemId,
      levelId: feeStructureLines.levelId,
      classId: feeStructureLines.classId,
      amountPesewas: feeStructureLines.amountPesewas,
    })
    .from(feeStructureLines)
    .where(and(eq(feeStructureLines.tenantId, ctx.tenant.id), eq(feeStructureLines.termId, termId)));
  const order = (
    await tx
      .select({ id: feeItems.id })
      .from(feeItems)
      .where(eq(feeItems.tenantId, ctx.tenant.id))
      .orderBy(asc(feeItems.sequence))
  ).map((i) => i.id);
  const automatic = await tx
    .select({
      studentId: ledgerEntries.studentId,
      kind: ledgerEntries.kind,
      feeItemId: ledgerEntries.feeItemId,
      billingKey: ledgerEntries.billingKey,
      amountPesewas: ledgerEntries.amountPesewas,
      reversed: isReversed,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, ctx.tenant.id),
        eq(ledgerEntries.termId, termId),
        inArray(ledgerEntries.kind, ["charge", "discount"]),
        isNotNull(ledgerEntries.billingKey),
      ),
    );
  const existing = automatic.filter((e) => e.kind === "charge");
  const plan = planBilling(
    termId,
    enrolled,
    lines,
    order,
    existing.map((e) => ({
      studentId: e.studentId,
      billingKey: e.billingKey!,
      netPesewas: e.reversed ? 0 : e.amountPesewas,
    })),
  );

  // Discounts apply to each student's live charges: those already billed plus those about to be.
  const enrolledIds = new Set(enrolled.map((e) => e.studentId));
  const bases = new Map<string, ChargeBase>();
  const addBase = (studentId: string, feeItemId: string, amount: number) => {
    if (!enrolledIds.has(studentId)) return;
    const key = `${studentId}|${feeItemId}`;
    const base = bases.get(key) ?? { studentId, feeItemId, amountPesewas: 0 };
    base.amountPesewas += amount;
    bases.set(key, base);
  };
  for (const e of existing)
    if (!e.reversed && e.feeItemId) addBase(e.studentId, e.feeItemId, e.amountPesewas);
  for (const c of plan.toCreate) addBase(c.studentId, c.feeItemId, c.amountPesewas);
  const concessions = await tx
    .select({
      id: feeConcessions.id,
      studentId: feeConcessions.studentId,
      feeItemId: feeConcessions.feeItemId,
      percentBasisPoints: feeConcessions.percentBasisPoints,
      amountPesewas: feeConcessions.amountPesewas,
      label: feeConcessions.label,
    })
    .from(feeConcessions)
    .where(and(eq(feeConcessions.tenantId, ctx.tenant.id), eq(feeConcessions.status, "active")))
    .orderBy(asc(feeConcessions.createdAt), asc(feeConcessions.id));
  const discounts = planDiscounts(
    termId,
    [...bases.values()],
    concessions.filter((c) => enrolledIds.has(c.studentId)),
    automatic
      .filter((e) => e.kind === "discount")
      .map((e) => ({
        studentId: e.studentId,
        billingKey: e.billingKey!,
        netPesewas: e.reversed ? 0 : e.amountPesewas,
      })),
  );
  return {
    ...plan,
    enrolled: enrolled.length,
    discounts,
    concessionLabels: new Map(concessions.map((c) => [c.id, c.label])),
  };
}

type TermPlan = BillingPlan & {
  enrolled: number;
  discounts: PlannedDiscount[];
  concessionLabels: Map<string, string>;
};

async function summarise(tx: Transaction, ctx: TenantContext, plan: TermPlan): Promise<BillingStatus> {
  const shown = plan.differences.slice(0, 50);
  let differences: BillingDifferenceRow[] = [];
  if (shown.length > 0) {
    const ids = [...new Set(shown.map((d) => d.studentId))];
    const people = await tx
      .select({
        id: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
      })
      .from(students)
      .where(and(eq(students.tenantId, ctx.tenant.id), inArray(students.id, ids)));
    const items = await tx
      .select({ id: feeItems.id, name: feeItems.name })
      .from(feeItems)
      .where(eq(feeItems.tenantId, ctx.tenant.id));
    differences = shown.map((d) => {
      const person = people.find((p) => p.id === d.studentId)!;
      return {
        studentId: d.studentId,
        studentName: `${person.firstName} ${person.lastName}`,
        admissionNumber: person.admissionNumber,
        itemName: items.find((i) => i.id === d.feeItemId)?.name ?? "Fee item",
        billedPesewas: d.billedPesewas,
        structurePesewas: d.structurePesewas,
      };
    });
  }
  return {
    enrolled: plan.enrolled,
    billedStudents: plan.billedStudents,
    studentsToBill: new Set([...plan.toCreate, ...plan.discounts].map((c) => c.studentId)).size,
    chargesToCreate: plan.toCreate.length,
    discountsToCreate: plan.discounts.length,
    discountsPesewas: -sumPesewas(plan.discounts.map((d) => d.amountPesewas)),
    amountToBillPesewas: sumPesewas([...plan.toCreate, ...plan.discounts].map((c) => c.amountPesewas)),
    differences,
    differenceCount: plan.differences.length,
  };
}

export async function getBillingStatus(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<BillingStatus | null> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await loadTerm(tx, ctx, termId))) return null;
    return summarise(tx, ctx, await planTerm(tx, ctx, termId));
  });
}

/**
 * Charges every active student placed in a class this term what the fee structure says. Safe to run
 * again: students and items already billed are skipped, so it picks up only new students and new items.
 */
export async function billTerm(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<BillingStatus> {
  assertCanManageSchoolFees(ctx);
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx, termId);
    if (!term) throw new DomainError("not_found", "This term no longer exists.");
    // One billing run per term at a time; the unique billing key also guards every charge.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${termId}`}))`);
    const plan = await planTerm(tx, ctx, termId);
    if (plan.toCreate.length === 0 && plan.discounts.length === 0) {
      throw new DomainError(
        "nothing_to_bill",
        plan.enrolled === 0
          ? "No students are placed in a class this term."
          : "Everyone has already been billed for this term.",
      );
    }
    const names = new Map(
      (
        await tx
          .select({ id: feeItems.id, name: feeItems.name })
          .from(feeItems)
          .where(eq(feeItems.tenantId, ctx.tenant.id))
      ).map((i) => [i.id, i.name]),
    );
    const termLabel = `${term.name} ${term.yearName}`;
    // Insert in batches to keep statements a sensible size for large schools.
    for (let i = 0; i < plan.toCreate.length; i += 500) {
      await tx
        .insert(ledgerEntries)
        .values(
          plan.toCreate.slice(i, i + 500).map((c) => ({
            tenantId: ctx.tenant.id,
            studentId: c.studentId,
            termId,
            kind: "charge" as const,
            feeItemId: c.feeItemId,
            description: `${names.get(c.feeItemId) ?? "Fees"}, ${termLabel}`,
            amountPesewas: c.amountPesewas,
            billingKey: c.billingKey,
            effectiveOn: term.startsOn,
            recordedByUserId: ctx.userId,
          })),
        )
        .onConflictDoNothing({
          target: [ledgerEntries.tenantId, ledgerEntries.studentId, ledgerEntries.billingKey],
        });
    }
    // Discounts are recorded after the charges, and each names the item it reduces.
    for (let i = 0; i < plan.discounts.length; i += 500) {
      await tx
        .insert(ledgerEntries)
        .values(
          plan.discounts.slice(i, i + 500).map((d) => ({
            tenantId: ctx.tenant.id,
            studentId: d.studentId,
            termId,
            kind: "discount" as const,
            feeItemId: d.feeItemId,
            description:
              `${plan.concessionLabels.get(d.concessionId) ?? "Discount"} on ${names.get(d.feeItemId) ?? "fees"}, ${termLabel}`.slice(
                0,
                200,
              ),
            amountPesewas: d.amountPesewas,
            billingKey: d.billingKey,
            effectiveOn: term.startsOn,
            recordedByUserId: ctx.userId,
          })),
        )
        .onConflictDoNothing({
          target: [ledgerEntries.tenantId, ledgerEntries.studentId, ledgerEntries.billingKey],
        });
    }
    const status = await summarise(tx, ctx, plan);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.term_billed",
      entityType: "term",
      entityId: termId,
      metadata: {
        term: termLabel,
        students: status.studentsToBill,
        charges: status.chargesToCreate,
        discounts: status.discountsToCreate,
        totalPesewas: status.amountToBillPesewas,
      },
    });
    return status;
  });
}

export interface AccountEntry {
  id: string;
  kind: (typeof ledgerEntries.$inferSelect)["kind"];
  description: string;
  effectiveOn: string;
  amountPesewas: number;
  /** Balance after this entry. */
  balancePesewas: number;
  reversed: boolean;
  /** Set for payments and voids: links to the receipt. */
  paymentId: string | null;
  recordedBy: string | null;
  recordedAt: Date;
}

export interface StudentAccount {
  student: { id: string; name: string; admissionNumber: string };
  /** Oldest first, with a running balance. */
  entries: AccountEntry[];
  /** Positive: the family owes this. Negative: the family is in credit. */
  balancePesewas: number;
}

export async function getStudentAccount(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<StudentAccount | null> {
  assertCan(ctx.roles, "fees.view");
  if (!z.string().uuid().safeParse(studentId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const student = await loadFinanceStudent(tx, ctx, studentId);
    if (!student) return null;
    const rows = await tx
      .select({
        id: ledgerEntries.id,
        kind: ledgerEntries.kind,
        description: ledgerEntries.description,
        effectiveOn: ledgerEntries.effectiveOn,
        amountPesewas: ledgerEntries.amountPesewas,
        reversed: isReversed,
        paymentId: ledgerEntries.paymentId,
        recordedBy: users.name,
        recordedAt: ledgerEntries.recordedAt,
      })
      .from(ledgerEntries)
      .leftJoin(users, eq(users.id, ledgerEntries.recordedByUserId))
      .where(and(eq(ledgerEntries.tenantId, ctx.tenant.id), eq(ledgerEntries.studentId, studentId)))
      .orderBy(asc(ledgerEntries.effectiveOn), asc(ledgerEntries.entryNumber));
    let balance = 0;
    const entries = rows.map((row) => {
      balance = sumPesewas([balance, row.amountPesewas]);
      return { ...row, balancePesewas: balance };
    });
    return {
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber,
      },
      entries,
      balancePesewas: balance,
    };
  });
}

const reverseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Say why this is being reversed.")
    .max(120, "Use 120 characters or fewer."),
});

/**
 * Cancels an entry by recording its exact opposite. The original stays on the statement, marked as
 * reversed, so the history is never lost. Each entry can be reversed once.
 */
export async function reverseEntry(
  database: Database,
  ctx: TenantContext,
  entryId: string,
  input: unknown,
): Promise<string> {
  assertCan(ctx.roles, "fees.manage");
  const { reason } = reverseSchema.parse(input);
  if (!z.string().uuid().safeParse(entryId).success)
    throw new DomainError("not_found", "This entry no longer exists.");
  return withTenant(database, scope(ctx), async (tx) => {
    const [original] = await tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, ctx.tenant.id), eq(ledgerEntries.id, entryId)));
    if (!original || !(await loadFinanceStudent(tx, ctx, original.studentId)))
      throw new DomainError("not_found", "This entry no longer exists.");
    if (original.kind === "payment")
      throw new DomainError("use_void", "To cancel a payment, void its receipt instead.");
    if (original.kind === "reversal")
      throw new DomainError(
        "not_reversible",
        "A reversal cannot itself be reversed. Record a new entry instead.",
      );
    const description = `Reversed: ${original.description} (${reason})`.slice(0, 200);
    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        tenantId: ctx.tenant.id,
        studentId: original.studentId,
        termId: original.termId,
        kind: "reversal",
        feeItemId: original.feeItemId,
        description,
        amountPesewas: -original.amountPesewas,
        reversesEntryId: original.id,
        effectiveOn: sql`(now() at time zone ${ctx.tenant.timezone})::date`,
        recordedByUserId: ctx.userId,
      })
      .returning({ id: ledgerEntries.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "ledger.entry_reversed",
      entityType: "student",
      entityId: original.studentId,
      metadata: { entry: original.description, amountPesewas: original.amountPesewas, reason },
    });
    return entry!.id;
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError("already_reversed", "This entry has already been reversed.");
    throw error;
  });
}
