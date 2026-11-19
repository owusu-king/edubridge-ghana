import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { parseMoney } from "../../lib/money";
import {
  COMPONENT_BASES,
  COMPONENT_KINDS,
  SUGGESTED_COMPONENTS,
  basisAllowed,
  calculatePay,
  monthBounds,
  payrollTotals,
  type ComponentBasis,
  type ComponentKind,
  type PayItem,
  type PayrollStatus,
  type PayrollTotals,
} from "../../lib/payroll";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  memberships,
  payComponents,
  payrollAdjustments,
  payrollLines,
  payrollRuns,
  staff,
  staffPositions,
  staffSalaries,
  staffSalaryComponents,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Payroll records (R4-2; module payroll, which needs staff_hr). EduBridge keeps the record of what each person is
 * paid; it never pays anyone. Salaries are insert-only and effective from a month; a month's run is a draft that
 * can be recalculated until the Proprietor approves it, after which the database locks it; corrections are
 * adjustments applied in a later run (PRL-02). Salaries are seen only by the Proprietor and Accountant; each
 * person sees their own approved payslips.
 */

const UUID = z.string().uuid();
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.");
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const currentMonth = (ctx: TenantContext) => todayIn(ctx.tenant.timezone).slice(0, 7);

/** "5.5" or "13" (percent) → basis points; null when it is not a percentage with at most two decimals. */
export function parsePercent(input: string): number | null {
  const text = input.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return bp <= 10000 ? bp : null;
}

// ——— Components (PRL-01a) ———

export interface PayComponent {
  id: string;
  name: string;
  kind: ComponentKind;
  basis: ComponentBasis;
  archived: boolean;
}

async function readComponents(tx: Transaction, tenantId: string): Promise<PayComponent[]> {
  const rows = await tx
    .select()
    .from(payComponents)
    .where(eq(payComponents.tenantId, tenantId))
    .orderBy(asc(payComponents.kind), asc(payComponents.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    basis: r.basis,
    archived: r.archivedAt !== null,
  }));
}

export async function listPayComponents(database: Database, ctx: TenantContext): Promise<PayComponent[]> {
  assertAllowed(ctx, "payroll.view");
  return withTenant(database, scopeOf(ctx), (tx) => readComponents(tx, ctx.tenant.id));
}

/** Adds the suggested component names the school does not have (no rates: each salary sets its own). */
export async function addSuggestedComponents(database: Database, ctx: TenantContext): Promise<number> {
  assertAllowed(ctx, "payroll.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const added = await tx
      .insert(payComponents)
      .values(SUGGESTED_COMPONENTS.map((c) => ({ tenantId: ctx.tenant.id, ...c })))
      .onConflictDoNothing()
      .returning({ name: payComponents.name });
    if (added.length)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "payroll.components_added",
        entityType: "pay_component",
        metadata: { names: added.map((a) => a.name) },
      });
    return added.length;
  });
}

const componentSchema = z
  .object({
    name: z.string().trim().min(2, "Use at least 2 characters.").max(60, "Use 60 characters or fewer."),
    kind: z.enum(COMPONENT_KINDS, { message: "Choose what it is." }),
    basis: z.enum(COMPONENT_BASES, { message: "Choose how it is worked out." }),
  })
  .refine((v) => basisAllowed(v.kind, v.basis), {
    message: "An earning cannot be a share of gross pay.",
    path: ["basis"],
  });

/** Adds a component. Its kind and basis never change afterwards (salaries and runs depend on them). */
export async function addPayComponent(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "payroll.manage");
  const data = componentSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .insert(payComponents)
      .values({ tenantId: ctx.tenant.id, ...data })
      .onConflictDoNothing()
      .returning({ id: payComponents.id });
    if (!row)
      throw new DomainError("name_taken", `There is already a component called ${data.name}.`, "name");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payroll.component_added",
      entityType: "pay_component",
      entityId: row.id,
      metadata: data,
    });
    return row.id;
  });
}

export async function setPayComponentArchived(
  database: Database,
  ctx: TenantContext,
  id: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "payroll.manage");
  if (!UUID.safeParse(id).success) throw new DomainError("not_found", "Component not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(payComponents)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(payComponents.tenantId, ctx.tenant.id), eq(payComponents.id, id)))
      .returning({ name: payComponents.name });
    if (!row) throw new DomainError("not_found", "Component not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: archived ? "payroll.component_archived" : "payroll.component_restored",
      entityType: "pay_component",
      entityId: id,
      metadata: { name: row.name },
    });
  });
}

// ——— Salaries (PRL-01b) ———

interface SalaryRow {
  id: string;
  staffId: string;
  effectiveMonth: string;
  basicMinor: number;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  components: {
    componentId: string;
    name: string;
    kind: ComponentKind;
    basis: ComponentBasis;
    value: number;
  }[];
}

async function salaryComponents(tx: Transaction, tenantId: string, salaryIds: string[]) {
  if (!salaryIds.length) return new Map<string, SalaryRow["components"]>();
  const rows = await tx
    .select({
      salaryId: staffSalaryComponents.salaryId,
      componentId: staffSalaryComponents.componentId,
      value: staffSalaryComponents.value,
      name: payComponents.name,
      kind: payComponents.kind,
      basis: payComponents.basis,
    })
    .from(staffSalaryComponents)
    .innerJoin(payComponents, eq(payComponents.id, staffSalaryComponents.componentId))
    .where(
      and(eq(staffSalaryComponents.tenantId, tenantId), inArray(staffSalaryComponents.salaryId, salaryIds)),
    )
    .orderBy(asc(payComponents.kind), asc(payComponents.name));
  const out = new Map<string, SalaryRow["components"]>();
  for (const r of rows) out.set(r.salaryId, [...(out.get(r.salaryId) ?? []), r]);
  return out;
}

/** The salary in force for each person in a month: the latest effective on or before it (latest entered wins). */
async function salariesFor(tx: Transaction, tenantId: string, month: string, staffIds?: string[]) {
  const rows = await tx
    .select({ s: staffSalaries, by: users.name })
    .from(staffSalaries)
    .innerJoin(users, eq(users.id, staffSalaries.createdByUserId))
    .where(
      and(
        eq(staffSalaries.tenantId, tenantId),
        lte(staffSalaries.effectiveMonth, month),
        staffIds ? inArray(staffSalaries.staffId, staffIds) : undefined,
      ),
    )
    .orderBy(desc(staffSalaries.effectiveMonth), desc(staffSalaries.createdAt));
  const current = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!current.has(r.s.staffId)) current.set(r.s.staffId, r);
  const comps = await salaryComponents(
    tx,
    tenantId,
    [...current.values()].map((r) => r.s.id),
  );
  return new Map(
    [...current.entries()].map(([staffId, { s, by }]) => [
      staffId,
      {
        id: s.id,
        staffId,
        effectiveMonth: s.effectiveMonth,
        basicMinor: s.basicMinor,
        note: s.note,
        createdBy: by,
        createdAt: s.createdAt,
        components: comps.get(s.id) ?? [],
      } satisfies SalaryRow,
    ]),
  );
}

async function latestApprovedMonth(tx: Transaction, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ month: max(payrollRuns.month) })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.status, "approved")));
  return row?.month ?? null;
}

const salarySchema = z.object({
  effectiveMonth: MONTH,
  basic: z.string().trim().min(1, "Enter the basic salary."),
  note: z.preprocess(blank, z.string().trim().max(300, "Use 300 characters or fewer.").nullable().optional()),
  components: z
    .array(z.object({ componentId: UUID, value: z.string().trim() }))
    .max(30)
    .default([]),
});

/**
 * Sets a person's salary from a month: a new insert-only record. Months already approved cannot change (use an
 * adjustment), so every approved month stays as it was paid.
 */
export async function setSalary(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "payroll.manage");
  if (!UUID.safeParse(staffId).success) throw new DomainError("not_found", "Staff member not found.");
  const data = salarySchema.parse(input);
  const currency = ctx.tenant.currencyCode;
  const basic = parseMoney(data.basic, currency);
  if (basic === null)
    throw new DomainError("amount_invalid", "Enter the salary, like 2500 or 2500.00.", "basic");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [person] = await tx
      .select({ id: staff.id, name: sql<string>`${staff.firstName} || ' ' || ${staff.lastName}` })
      .from(staff)
      .where(and(eq(staff.tenantId, ctx.tenant.id), eq(staff.id, staffId)));
    if (!person) throw new DomainError("not_found", "Staff member not found.");
    const approved = await latestApprovedMonth(tx, ctx.tenant.id);
    if (approved && data.effectiveMonth <= approved)
      throw new DomainError(
        "month_approved",
        `Payroll is approved up to ${approved}. Choose a later month, or add an adjustment for earlier ones.`,
        "effectiveMonth",
      );
    const components = await readComponents(tx, ctx.tenant.id);
    const values: { componentId: string; value: number }[] = [];
    for (const c of data.components) {
      if (c.value === "") continue;
      const def = components.find((d) => d.id === c.componentId && !d.archived);
      if (!def) throw new DomainError("not_found", "Choose a component from the list.", "components");
      const value = def.basis === "fixed" ? parseMoney(c.value, currency) : parsePercent(c.value);
      if (value === null)
        throw new DomainError(
          "amount_invalid",
          def.basis === "fixed"
            ? `${def.name}: enter an amount, like 200 or 200.00.`
            : `${def.name}: enter a percentage, like 5.5.`,
          "components",
        );
      values.push({ componentId: def.id, value });
    }
    const [row] = await tx
      .insert(staffSalaries)
      .values({
        tenantId: ctx.tenant.id,
        staffId,
        effectiveMonth: data.effectiveMonth,
        basicMinor: basic,
        currencyCode: currency,
        note: data.note ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: staffSalaries.id });
    if (values.length)
      await tx
        .insert(staffSalaryComponents)
        .values(values.map((v) => ({ tenantId: ctx.tenant.id, salaryId: row!.id, ...v })));
    // Amounts are not copied into the audit log: salaries are confidential.
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payroll.salary_set",
      entityType: "staff",
      entityId: staffId,
      metadata: { salaryId: row!.id, effectiveMonth: data.effectiveMonth, components: values.length },
    });
    return row!.id;
  });
}

// ——— Adjustments (PRL-02b) ———

const adjustmentSchema = z.object({
  staffId: UUID,
  month: MONTH,
  kind: z.enum(["earning", "deduction"], { message: "Choose earning or deduction." }),
  description: z
    .string()
    .trim()
    .min(3, "Describe it, for the payslip.")
    .max(120, "Use 120 characters or fewer."),
  amount: z.string().trim().min(1, "Enter the amount."),
});

export async function addAdjustment(database: Database, ctx: TenantContext, input: unknown): Promise<string> {
  assertAllowed(ctx, "payroll.manage");
  const data = adjustmentSchema.parse(input);
  const amount = parseMoney(data.amount, ctx.tenant.currencyCode);
  if (amount === null || amount <= 0)
    throw new DomainError("amount_invalid", "Enter an amount above zero, like 150 or 150.00.", "amount");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [person] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.tenantId, ctx.tenant.id), eq(staff.id, data.staffId)));
    if (!person) throw new DomainError("not_found", "Staff member not found.", "staffId");
    const [row] = await tx
      .insert(payrollAdjustments)
      .values({
        tenantId: ctx.tenant.id,
        staffId: data.staffId,
        month: data.month,
        kind: data.kind,
        description: data.description,
        amountMinor: amount,
        createdByUserId: ctx.userId,
      })
      .returning({ id: payrollAdjustments.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payroll.adjustment_added",
      entityType: "staff",
      entityId: data.staffId,
      metadata: { adjustmentId: row!.id, month: data.month, kind: data.kind, description: data.description },
    });
    return row!.id;
  });
}

export async function cancelAdjustment(database: Database, ctx: TenantContext, id: string): Promise<void> {
  assertAllowed(ctx, "payroll.manage");
  if (!UUID.safeParse(id).success) throw new DomainError("not_found", "Adjustment not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(payrollAdjustments)
      .set({ cancelledAt: new Date(), cancelledByUserId: ctx.userId })
      .where(
        and(
          eq(payrollAdjustments.tenantId, ctx.tenant.id),
          eq(payrollAdjustments.id, id),
          isNull(payrollAdjustments.appliedRunId),
          isNull(payrollAdjustments.cancelledAt),
        ),
      )
      .returning({ staffId: payrollAdjustments.staffId });
    if (!row) throw new DomainError("adjustment_closed", "This adjustment was already paid or cancelled.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payroll.adjustment_cancelled",
      entityType: "staff",
      entityId: row.staffId,
      metadata: { adjustmentId: id },
    });
  });
}

async function openAdjustments(tx: Transaction, tenantId: string, month: string, staffIds?: string[]) {
  return tx
    .select()
    .from(payrollAdjustments)
    .where(
      and(
        eq(payrollAdjustments.tenantId, tenantId),
        lte(payrollAdjustments.month, month),
        isNull(payrollAdjustments.appliedRunId),
        isNull(payrollAdjustments.cancelledAt),
        staffIds ? inArray(payrollAdjustments.staffId, staffIds) : undefined,
      ),
    )
    .orderBy(asc(payrollAdjustments.createdAt));
}

// ——— Runs (PRL-02a, PRL-02c) ———

/** Staff who worked at any point of a month. */
async function staffInMonth(tx: Transaction, tenantId: string, month: string) {
  const { first, last } = monthBounds(month);
  return tx
    .select({
      id: staff.id,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      position: staffPositions.name,
    })
    .from(staff)
    .leftJoin(staffPositions, eq(staffPositions.id, staff.positionId))
    .where(
      and(
        eq(staff.tenantId, tenantId),
        lte(staff.startedOn, last),
        or(isNull(staff.leftOn), sql`${staff.leftOn} >= ${first}`),
      ),
    )
    .orderBy(asc(staff.lastName), asc(staff.firstName));
}

/**
 * Prepares a month's payroll as a draft, or recalculates the draft: every person who worked in the month and
 * has a salary in force, with the adjustments waiting for them. People without a salary are listed for the
 * Accountant to complete.
 */
export async function preparePayroll(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ runId: string; lines: number; withoutSalary: string[] }> {
  assertAllowed(ctx, "payroll.manage");
  if (ctx.campusIds !== null)
    throw new DomainError("campus_scope", "Payroll covers every campus: it needs access to all of them.");
  const { month } = z.object({ month: MONTH }).parse(input);
  if (month > currentMonth(ctx))
    throw new DomainError("month_future", "Choose this month or an earlier one.", "month");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"payroll:" + ctx.tenant.id}, 0))`);
    const [existing] = await tx
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.tenantId, ctx.tenant.id),
          eq(payrollRuns.month, month),
          sql`${payrollRuns.status} <> 'cancelled'`,
        ),
      );
    if (existing?.status === "approved")
      throw new DomainError("run_approved", `Payroll for ${month} is approved and cannot change.`, "month");
    let runId: string;
    if (existing) {
      runId = existing.id;
      await tx.delete(payrollLines).where(eq(payrollLines.runId, runId));
      await tx
        .update(payrollRuns)
        .set({ preparedByUserId: ctx.userId, preparedAt: new Date() })
        .where(eq(payrollRuns.id, runId));
    } else {
      const [row] = await tx
        .insert(payrollRuns)
        .values({
          tenantId: ctx.tenant.id,
          month,
          currencyCode: ctx.tenant.currencyCode,
          preparedByUserId: ctx.userId,
        })
        .returning({ id: payrollRuns.id });
      runId = row!.id;
    }
    const people = await staffInMonth(tx, ctx.tenant.id, month);
    const salaries = await salariesFor(
      tx,
      ctx.tenant.id,
      month,
      people.map((p) => p.id),
    );
    const adjustments = await openAdjustments(
      tx,
      ctx.tenant.id,
      month,
      people.map((p) => p.id),
    );
    const withoutSalary: string[] = [];
    let lines = 0;
    for (const p of people) {
      const salary = salaries.get(p.id);
      if (!salary) {
        withoutSalary.push(`${p.firstName} ${p.lastName}`);
        continue;
      }
      const pay = calculatePay(
        salary.basicMinor,
        salary.components.map((c) => ({ name: c.name, kind: c.kind, basis: c.basis, value: c.value })),
        adjustments
          .filter((a) => a.staffId === p.id)
          .map((a) => ({ description: a.description, kind: a.kind, amount: a.amountMinor })),
      );
      await tx.insert(payrollLines).values({
        tenantId: ctx.tenant.id,
        runId,
        staffId: p.id,
        staffName: `${p.firstName} ${p.lastName}`,
        staffNumber: p.staffNumber,
        position: p.position,
        salaryId: salary.id,
        basicMinor: pay.basic,
        grossMinor: pay.gross,
        deductionsMinor: pay.deductions,
        netMinor: pay.net,
        employerMinor: pay.employer,
        items: pay.items,
      });
      lines++;
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: existing ? "payroll.recalculated" : "payroll.prepared",
      entityType: "payroll_run",
      entityId: runId,
      metadata: { month, lines, withoutSalary: withoutSalary.length },
    });
    return { runId, lines, withoutSalary };
  });
}

async function readRunForUpdate(tx: Transaction, ctx: TenantContext, runId: string) {
  if (!UUID.safeParse(runId).success) throw new DomainError("not_found", "Payroll not found.");
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, runId)))
    .for("update");
  if (!run) throw new DomainError("not_found", "Payroll not found.");
  return run;
}

/**
 * The Proprietor approves a draft: refused if any net pay is negative, or if salaries or adjustments changed
 * after it was prepared (recalculate first). Its adjustments are marked paid in the same transaction, and the
 * database locks the run and its lines from then on.
 */
export async function approvePayroll(database: Database, ctx: TenantContext, runId: string): Promise<void> {
  assertAllowed(ctx, "payroll.approve");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"payroll:" + ctx.tenant.id}, 0))`);
    const run = await readRunForUpdate(tx, ctx, runId);
    if (run.status !== "draft") throw new DomainError("run_closed", "This payroll is no longer a draft.");
    const lines = await tx.select().from(payrollLines).where(eq(payrollLines.runId, run.id));
    if (!lines.length) throw new DomainError("run_empty", "This payroll has nobody on it yet.");
    if (lines.some((l) => l.netMinor < 0))
      throw new DomainError(
        "negative_net",
        "Someone's net pay is below zero. Check their deductions and adjustments.",
      );
    const [changed] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(staffSalaries)
      .where(and(eq(staffSalaries.tenantId, ctx.tenant.id), gt(staffSalaries.createdAt, run.preparedAt)));
    const [adjusted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollAdjustments)
      .where(
        and(
          eq(payrollAdjustments.tenantId, ctx.tenant.id),
          or(
            gt(payrollAdjustments.createdAt, run.preparedAt),
            gt(payrollAdjustments.cancelledAt, run.preparedAt),
          ),
        ),
      );
    if ((changed?.n ?? 0) > 0 || (adjusted?.n ?? 0) > 0)
      throw new DomainError(
        "run_stale",
        "Salaries or adjustments changed since this was prepared. Recalculate it first.",
      );
    await tx
      .update(payrollRuns)
      .set({ status: "approved", approvedByUserId: ctx.userId, approvedAt: new Date() })
      .where(eq(payrollRuns.id, run.id));
    const applied = await openAdjustments(
      tx,
      ctx.tenant.id,
      run.month,
      lines.map((l) => l.staffId),
    );
    if (applied.length)
      await tx
        .update(payrollAdjustments)
        .set({ appliedRunId: run.id })
        .where(
          inArray(
            payrollAdjustments.id,
            applied.map((a) => a.id),
          ),
        );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payroll.approved",
      entityType: "payroll_run",
      entityId: run.id,
      metadata: {
        month: run.month,
        lines: lines.length,
        adjustments: applied.length,
        ...payrollTotals(lines.map(toLine)),
      },
    });
  });
}

export async function cancelPayroll(database: Database, ctx: TenantContext, runId: string): Promise<void> {
  assertAllowed(ctx, "payroll.manage");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const run = await readRunForUpdate(tx, ctx, runId);
    if (run.status !== "draft") throw new DomainError("run_closed", "Only a draft can be cancelled.");
    await tx
      .update(payrollRuns)
      .set({ status: "cancelled", cancelledByUserId: ctx.userId, cancelledAt: new Date() })
      .where(eq(payrollRuns.id, run.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payroll.cancelled",
      entityType: "payroll_run",
      entityId: run.id,
      metadata: { month: run.month },
    });
  });
}

// ——— Views ———

const toLine = (l: typeof payrollLines.$inferSelect) => ({
  basic: l.basicMinor,
  gross: l.grossMinor,
  deductions: l.deductionsMinor,
  net: l.netMinor,
  employer: l.employerMinor,
});

export interface RunSummary {
  id: string;
  month: string;
  status: PayrollStatus;
  totals: PayrollTotals;
  preparedBy: string;
  preparedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
}

export async function listPayrollRuns(database: Database, ctx: TenantContext): Promise<RunSummary[]> {
  assertAllowed(ctx, "payroll.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const runs = await tx
      .select({ r: payrollRuns, preparedBy: users.name })
      .from(payrollRuns)
      .innerJoin(users, eq(users.id, payrollRuns.preparedByUserId))
      .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), sql`${payrollRuns.status} <> 'cancelled'`))
      .orderBy(desc(payrollRuns.month))
      .limit(36);
    if (!runs.length) return [];
    const lines = await tx
      .select()
      .from(payrollLines)
      .where(
        inArray(
          payrollLines.runId,
          runs.map((r) => r.r.id),
        ),
      );
    const approvers = await approverNames(
      tx,
      runs.map((r) => r.r.approvedByUserId),
    );
    return runs.map(({ r, preparedBy }) => ({
      id: r.id,
      month: r.month,
      status: r.status,
      totals: payrollTotals(lines.filter((l) => l.runId === r.id).map(toLine)),
      preparedBy,
      preparedAt: r.preparedAt,
      approvedBy: r.approvedByUserId ? (approvers.get(r.approvedByUserId) ?? null) : null,
      approvedAt: r.approvedAt,
    }));
  });
}

async function approverNames(tx: Transaction, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface PayrollLineView {
  id: string;
  staffId: string;
  staffName: string;
  staffNumber: string;
  position: string | null;
  basic: number;
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  items: PayItem[];
}

const toView = (l: typeof payrollLines.$inferSelect): PayrollLineView => ({
  id: l.id,
  staffId: l.staffId,
  staffName: l.staffName,
  staffNumber: l.staffNumber,
  position: l.position,
  ...toLine(l),
  items: l.items,
});

export interface RunDetail extends RunSummary {
  currencyCode: string;
  lines: PayrollLineView[];
  /** People who worked in the month without a salary (drafts only). */
  withoutSalary: string[];
  /** Salaries or adjustments changed since the draft was prepared. */
  stale: boolean;
}

export async function getPayrollRun(
  database: Database,
  ctx: TenantContext,
  runId: string,
): Promise<RunDetail> {
  assertAllowed(ctx, "payroll.view");
  if (!UUID.safeParse(runId).success) throw new DomainError("not_found", "Payroll not found.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [found] = await tx
      .select({ r: payrollRuns, preparedBy: users.name })
      .from(payrollRuns)
      .innerJoin(users, eq(users.id, payrollRuns.preparedByUserId))
      .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, runId)));
    if (!found) throw new DomainError("not_found", "Payroll not found.");
    const { r, preparedBy } = found;
    const lines = await tx
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.runId, r.id))
      .orderBy(asc(payrollLines.staffName));
    let withoutSalary: string[] = [];
    let stale = false;
    if (r.status === "draft") {
      const onRun = new Set(lines.map((l) => l.staffId));
      withoutSalary = (await staffInMonth(tx, ctx.tenant.id, r.month))
        .filter((p) => !onRun.has(p.id))
        .map((p) => `${p.firstName} ${p.lastName}`);
      const [changed] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(staffSalaries)
        .where(and(eq(staffSalaries.tenantId, ctx.tenant.id), gt(staffSalaries.createdAt, r.preparedAt)));
      const [adjusted] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(payrollAdjustments)
        .where(
          and(
            eq(payrollAdjustments.tenantId, ctx.tenant.id),
            or(
              gt(payrollAdjustments.createdAt, r.preparedAt),
              gt(payrollAdjustments.cancelledAt, r.preparedAt),
            ),
          ),
        );
      stale = (changed?.n ?? 0) > 0 || (adjusted?.n ?? 0) > 0;
    }
    const approvers = await approverNames(tx, [r.approvedByUserId]);
    return {
      id: r.id,
      month: r.month,
      status: r.status,
      currencyCode: r.currencyCode,
      totals: payrollTotals(lines.map(toLine)),
      preparedBy,
      preparedAt: r.preparedAt,
      approvedBy: r.approvedByUserId ? (approvers.get(r.approvedByUserId) ?? null) : null,
      approvedAt: r.approvedAt,
      lines: lines.map(toView),
      withoutSalary,
      stale,
    };
  });
}

export interface StaffPayRow {
  staffId: string;
  staffNumber: string;
  name: string;
  position: string | null;
  status: "active" | "left";
  salary: { effectiveMonth: string; basic: number; components: number } | null;
}

/** Everyone working now, with the salary in force this month (Payroll, People). */
export async function listStaffPay(database: Database, ctx: TenantContext): Promise<StaffPayRow[]> {
  assertAllowed(ctx, "payroll.view");
  const month = currentMonth(ctx);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const people = await staffInMonth(tx, ctx.tenant.id, month);
    const salaries = await salariesFor(
      tx,
      ctx.tenant.id,
      month,
      people.map((p) => p.id),
    );
    const statuses = people.length
      ? await tx
          .select({ id: staff.id, status: staff.status })
          .from(staff)
          .where(
            and(
              eq(staff.tenantId, ctx.tenant.id),
              inArray(
                staff.id,
                people.map((p) => p.id),
              ),
            ),
          )
      : [];
    const statusOf = new Map(statuses.map((s) => [s.id, s.status]));
    return people.map((p) => {
      const s = salaries.get(p.id);
      return {
        staffId: p.id,
        staffNumber: p.staffNumber,
        name: `${p.firstName} ${p.lastName}`,
        position: p.position,
        status: statusOf.get(p.id) ?? "active",
        salary: s
          ? { effectiveMonth: s.effectiveMonth, basic: s.basicMinor, components: s.components.length }
          : null,
      };
    });
  });
}

export interface StaffPayDetail {
  staffId: string;
  name: string;
  staffNumber: string;
  salaries: SalaryRow[];
  adjustments: {
    id: string;
    month: string;
    kind: "earning" | "deduction";
    description: string;
    amount: number;
    state: "waiting" | "paid" | "cancelled";
    paidIn: string | null;
  }[];
  components: PayComponent[];
  approvedThrough: string | null;
}

/** One person's salary history and adjustments (Payroll, a person). */
export async function getStaffPay(
  database: Database,
  ctx: TenantContext,
  staffId: string,
): Promise<StaffPayDetail> {
  assertAllowed(ctx, "payroll.view");
  if (!UUID.safeParse(staffId).success) throw new DomainError("not_found", "Staff member not found.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [person] = await tx
      .select()
      .from(staff)
      .where(and(eq(staff.tenantId, ctx.tenant.id), eq(staff.id, staffId)));
    if (!person) throw new DomainError("not_found", "Staff member not found.");
    const rows = await tx
      .select({ s: staffSalaries, by: users.name })
      .from(staffSalaries)
      .innerJoin(users, eq(users.id, staffSalaries.createdByUserId))
      .where(and(eq(staffSalaries.tenantId, ctx.tenant.id), eq(staffSalaries.staffId, staffId)))
      .orderBy(desc(staffSalaries.effectiveMonth), desc(staffSalaries.createdAt));
    const comps = await salaryComponents(
      tx,
      ctx.tenant.id,
      rows.map((r) => r.s.id),
    );
    const adjustments = await tx
      .select({ a: payrollAdjustments, paidIn: payrollRuns.month })
      .from(payrollAdjustments)
      .leftJoin(payrollRuns, eq(payrollRuns.id, payrollAdjustments.appliedRunId))
      .where(and(eq(payrollAdjustments.tenantId, ctx.tenant.id), eq(payrollAdjustments.staffId, staffId)))
      .orderBy(desc(payrollAdjustments.createdAt));
    return {
      staffId,
      name: `${person.firstName} ${person.lastName}`,
      staffNumber: person.staffNumber,
      salaries: rows.map(({ s, by }) => ({
        id: s.id,
        staffId,
        effectiveMonth: s.effectiveMonth,
        basicMinor: s.basicMinor,
        note: s.note,
        createdBy: by,
        createdAt: s.createdAt,
        components: comps.get(s.id) ?? [],
      })),
      adjustments: adjustments.map(({ a, paidIn }) => ({
        id: a.id,
        month: a.month,
        kind: a.kind,
        description: a.description,
        amount: a.amountMinor,
        state: a.appliedRunId ? "paid" : a.cancelledAt ? "cancelled" : "waiting",
        paidIn,
      })),
      components: await readComponents(tx, ctx.tenant.id),
      approvedThrough: await latestApprovedMonth(tx, ctx.tenant.id),
    };
  });
}

// ——— Payslips (PRL-03) ———

export interface Payslip extends PayrollLineView {
  month: string;
  currencyCode: string;
  status: PayrollStatus;
  approvedAt: Date | null;
}

/**
 * A payslip: payroll staff see any line; everyone else only their own, and only from an approved run. A payslip
 * from a draft is marked as such.
 */
export async function getPayslip(
  database: Database,
  ctx: TenantContext,
  lineId: string,
): Promise<Payslip | null> {
  if (!allowed(ctx, "payroll.view")) assertAllowed(ctx, "payroll.own");
  if (!UUID.safeParse(lineId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({ l: payrollLines, r: payrollRuns, memberUser: memberships.userId })
      .from(payrollLines)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
      .innerJoin(staff, eq(staff.id, payrollLines.staffId))
      .leftJoin(memberships, eq(memberships.id, staff.membershipId))
      .where(and(eq(payrollLines.tenantId, ctx.tenant.id), eq(payrollLines.id, lineId)));
    if (!row || row.r.status === "cancelled") return null;
    const own = row.memberUser === ctx.userId;
    if (!allowed(ctx, "payroll.view") && !(own && row.r.status === "approved")) return null;
    return {
      ...toView(row.l),
      month: row.r.month,
      currencyCode: row.r.currencyCode,
      status: row.r.status,
      approvedAt: row.r.approvedAt,
    };
  });
}

/** The signed-in member's own approved payslips, newest first. */
export async function listMyPayslips(
  database: Database,
  ctx: TenantContext,
): Promise<{
  hasStaffRecord: boolean;
  payslips: { id: string; month: string; net: number; gross: number }[];
}> {
  assertAllowed(ctx, "payroll.own");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [me] = await tx
      .select({ id: staff.id })
      .from(staff)
      .innerJoin(memberships, eq(memberships.id, staff.membershipId))
      .where(and(eq(staff.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
    if (!me) return { hasStaffRecord: false, payslips: [] };
    const rows = await tx
      .select({
        id: payrollLines.id,
        month: payrollRuns.month,
        net: payrollLines.netMinor,
        gross: payrollLines.grossMinor,
      })
      .from(payrollLines)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
      .where(
        and(
          eq(payrollLines.tenantId, ctx.tenant.id),
          eq(payrollLines.staffId, me.id),
          eq(payrollRuns.status, "approved"),
        ),
      )
      .orderBy(desc(payrollRuns.month));
    return { hasStaffRecord: true, payslips: rows };
  });
}
