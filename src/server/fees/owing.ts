import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { parseCedis } from "@/lib/money";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  feeReminders,
  guardians,
  ledgerEntries,
  paymentPlanInstalments,
  paymentPlans,
  payments,
  paymentVoids,
  studentGuardians,
  students,
  terms,
} from "../db/schema";
import type { TenantContext } from "../tenancy/service";
import { campusScopeFilter } from "./access";
import { planProgress } from "./plan-schedule";

/**
 * Who owes what: every student with a balance, largest first, with who to contact and how the family
 * is doing against a payment plan. Built for chasing fees: filter by class, by a minimum amount, or to
 * families behind on an agreed plan.
 */

export const OWING_PAGE_SIZE = 50;

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const owingSchema = z.object({
  classId: z.string().uuid().optional(),
  minAmount: z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (!text?.trim()) return undefined;
      const pesewas = parseCedis(text);
      if (pesewas === null) {
        ctx.addIssue({ code: "custom", message: "Enter an amount like 500 or 500.50." });
        return z.NEVER;
      }
      return pesewas;
    }),
  overdueOnly: z.boolean().default(false),
  page: z.number().int().min(1).max(10_000).default(1),
});

export interface OwingContact {
  guardianId: string;
  name: string;
  /** E.164, or null when the guardian has no phone number. */
  phone: string | null;
}

export interface OwingRow {
  studentId: string;
  name: string;
  firstName: string;
  admissionNumber: string;
  status: "active" | "withdrawn" | "graduated";
  className: string | null;
  balancePesewas: number;
  /** The primary contact, or another guardian with a phone when the primary has none. */
  contact: OwingContact | null;
  lastPaidOn: string | null;
  lastRemindedOn: string | null;
  plan: { overduePesewas: number; remainingPesewas: number; nextDueOn: string | null } | null;
}

export interface OwingPage {
  rows: OwingRow[];
  total: number;
  /** Owed by every student matching the filters (not just this page). */
  owedPesewas: number;
  /** Matching students with no guardian phone number to remind. */
  withoutPhone: number;
  page: number;
}

export async function listOwing(database: Database, ctx: TenantContext, input: unknown): Promise<OwingPage> {
  assertAllowed(ctx, "fees.view");
  const filters = owingSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const balances = tx
      .select({
        studentId: ledgerEntries.studentId,
        balance: sql<string>`sum(${ledgerEntries.amountPesewas})`.as("balance"),
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, ctx.tenant.id))
      .groupBy(ledgerEntries.studentId)
      .as("balances");
    const current = tx
      .select({ studentId: enrolments.studentId, classId: enrolments.classId, className: classes.name })
      .from(enrolments)
      .innerJoin(terms, and(eq(terms.id, enrolments.termId), eq(terms.isCurrent, true)))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .where(eq(enrolments.tenantId, ctx.tenant.id))
      .as("current");
    const owing = await tx
      .select({
        studentId: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
        status: students.status,
        className: current.className,
        balance: balances.balance,
      })
      .from(students)
      .innerJoin(balances, eq(balances.studentId, students.id))
      .leftJoin(current, eq(current.studentId, students.id))
      .where(
        and(
          eq(students.tenantId, ctx.tenant.id),
          sql`${balances.balance} > ${Math.max(0, (filters.minAmount ?? 1) - 1)}`,
          campusScopeFilter(ctx, students.id),
          filters.classId ? eq(current.classId, filters.classId) : undefined,
        ),
      )
      .orderBy(desc(sql`${balances.balance}`), asc(students.lastName), asc(students.firstName));

    const ids = owing.map((o) => o.studentId);
    const [contacts, lastPaid, lastReminded, plans] = ids.length
      ? [
          await contactsFor(tx, ctx, ids),
          await lastPaymentDates(tx, ctx, ids),
          await lastReminderDates(tx, ctx, ids),
          await planStates(tx, ctx, ids),
        ]
      : [new Map(), new Map(), new Map(), new Map()];

    let rows: OwingRow[] = owing.map((o) => ({
      studentId: o.studentId,
      name: `${o.firstName} ${o.lastName}`,
      firstName: o.firstName,
      admissionNumber: o.admissionNumber,
      status: o.status,
      className: o.className,
      balancePesewas: Number(o.balance),
      contact: contacts.get(o.studentId) ?? null,
      lastPaidOn: lastPaid.get(o.studentId) ?? null,
      lastRemindedOn: lastReminded.get(o.studentId) ?? null,
      plan: plans.get(o.studentId) ?? null,
    }));
    if (filters.overdueOnly) rows = rows.filter((r) => (r.plan?.overduePesewas ?? 0) > 0);

    const page = Math.min(filters.page, Math.max(1, Math.ceil(rows.length / OWING_PAGE_SIZE)));
    return {
      rows: rows.slice((page - 1) * OWING_PAGE_SIZE, page * OWING_PAGE_SIZE),
      total: rows.length,
      owedPesewas: rows.reduce((sum, r) => sum + r.balancePesewas, 0),
      withoutPhone: rows.filter((r) => !r.contact?.phone).length,
      page,
    };
  });
}

/** Who to contact per student: the primary guardian if they have a phone, else a guardian who does. */
export async function contactsFor(
  tx: Transaction,
  ctx: { tenant: { id: string } },
  studentIds: string[],
): Promise<Map<string, OwingContact>> {
  const links = await tx
    .select({
      studentId: studentGuardians.studentId,
      guardianId: guardians.id,
      name: guardians.fullName,
      phone: guardians.phone,
      isPrimary: studentGuardians.isPrimary,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(and(eq(studentGuardians.tenantId, ctx.tenant.id), inArray(studentGuardians.studentId, studentIds)))
    .orderBy(desc(studentGuardians.isPrimary), asc(guardians.fullName));
  const byStudent = new Map<string, OwingContact>();
  for (const link of links) {
    const chosen = byStudent.get(link.studentId);
    // Keep the primary contact unless they have no phone and this guardian does.
    if (!chosen || (!chosen.phone && link.phone))
      byStudent.set(link.studentId, { guardianId: link.guardianId, name: link.name, phone: link.phone });
  }
  return byStudent;
}

async function lastPaymentDates(tx: Transaction, ctx: TenantContext, studentIds: string[]) {
  const rows = await tx
    .select({ studentId: payments.studentId, on: max(payments.paidOn) })
    .from(payments)
    .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
    .where(
      and(
        eq(payments.tenantId, ctx.tenant.id),
        inArray(payments.studentId, studentIds),
        isNull(paymentVoids.paymentId),
      ),
    )
    .groupBy(payments.studentId);
  return new Map(rows.map((r) => [r.studentId, r.on!]));
}

async function lastReminderDates(tx: Transaction, ctx: TenantContext, studentIds: string[]) {
  const rows = await tx
    .select({ studentId: feeReminders.studentId, on: max(feeReminders.sentOn) })
    .from(feeReminders)
    .where(and(eq(feeReminders.tenantId, ctx.tenant.id), inArray(feeReminders.studentId, studentIds)))
    .groupBy(feeReminders.studentId);
  return new Map(rows.map((r) => [r.studentId, r.on!]));
}

/** Progress of each student's active payment plan (same rules as the student's page). */
async function planStates(tx: Transaction, ctx: TenantContext, studentIds: string[]) {
  const plans = await tx
    .select({
      id: paymentPlans.id,
      studentId: paymentPlans.studentId,
      createdAt: paymentPlans.createdAt,
    })
    .from(paymentPlans)
    .where(
      and(
        eq(paymentPlans.tenantId, ctx.tenant.id),
        eq(paymentPlans.status, "active"),
        inArray(paymentPlans.studentId, studentIds),
      ),
    );
  const states = new Map<string, NonNullable<OwingRow["plan"]>>();
  if (plans.length === 0) return states;
  const planIds = plans.map((p) => p.id);
  const instalments = await tx
    .select({
      planId: paymentPlanInstalments.planId,
      sequence: paymentPlanInstalments.sequence,
      dueOn: paymentPlanInstalments.dueOn,
      amountPesewas: paymentPlanInstalments.amountPesewas,
    })
    .from(paymentPlanInstalments)
    .where(inArray(paymentPlanInstalments.planId, planIds));
  // Payments (not voided) recorded since each plan was agreed.
  const paid = await tx
    .select({ planId: paymentPlans.id, total: sql<string>`coalesce(sum(${payments.amountPesewas}), 0)` })
    .from(paymentPlans)
    .innerJoin(
      payments,
      and(eq(payments.studentId, paymentPlans.studentId), gte(payments.recordedAt, paymentPlans.createdAt)),
    )
    .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
    .where(and(inArray(paymentPlans.id, planIds), isNull(paymentVoids.paymentId)))
    .groupBy(paymentPlans.id);
  const paidByPlan = new Map(paid.map((p) => [p.planId, Number(p.total)]));
  const today = todayIn(ctx.tenant.timezone);
  for (const plan of plans) {
    const progress = planProgress(
      instalments.filter((i) => i.planId === plan.id),
      paidByPlan.get(plan.id) ?? 0,
      today,
    );
    states.set(plan.studentId, {
      overduePesewas: progress.overduePesewas,
      remainingPesewas: progress.remainingPesewas,
      nextDueOn: progress.nextDue?.dueOn ?? null,
    });
  }
  return states;
}
