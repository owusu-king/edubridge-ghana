import "server-only";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { parseCedis } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { paymentPlanInstalments, paymentPlans, payments, paymentVoids, users } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";
import { FREQUENCIES, planProgress, splitInstalments, type PlanProgress } from "./plan-schedule";

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

export interface PaymentPlan {
  id: string;
  totalPesewas: number;
  startsOn: string;
  createdBy: string | null;
  progress: PlanProgress;
}

/** The student's active plan with progress, counting payments (not voided) recorded since it was agreed. */
export async function getPaymentPlan(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<PaymentPlan | null> {
  assertCan(ctx.roles, "fees.view");
  if (!z.string().uuid().safeParse(studentId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await loadFinanceStudent(tx, ctx, studentId))) return null;
    const [plan] = await tx
      .select({
        id: paymentPlans.id,
        totalPesewas: paymentPlans.totalPesewas,
        startsOn: paymentPlans.startsOn,
        createdAt: paymentPlans.createdAt,
        createdBy: users.name,
      })
      .from(paymentPlans)
      .leftJoin(users, eq(users.id, paymentPlans.createdByUserId))
      .where(
        and(
          eq(paymentPlans.tenantId, ctx.tenant.id),
          eq(paymentPlans.studentId, studentId),
          eq(paymentPlans.status, "active"),
        ),
      );
    if (!plan) return null;
    const instalments = await tx
      .select({
        sequence: paymentPlanInstalments.sequence,
        dueOn: paymentPlanInstalments.dueOn,
        amountPesewas: paymentPlanInstalments.amountPesewas,
      })
      .from(paymentPlanInstalments)
      .where(eq(paymentPlanInstalments.planId, plan.id))
      .orderBy(asc(paymentPlanInstalments.sequence));
    const [paid] = await tx
      .select({ total: sql<string>`coalesce(sum(${payments.amountPesewas}), 0)` })
      .from(payments)
      .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
      .where(
        and(
          eq(payments.tenantId, ctx.tenant.id),
          eq(payments.studentId, studentId),
          // Payments recorded after the plan was agreed (earlier ones are already in the plan's total).
          gte(payments.recordedAt, plan.createdAt),
          isNull(paymentVoids.paymentId),
        ),
      );
    return {
      ...plan,
      progress: planProgress(instalments, Number(paid!.total), todayIn(ctx.tenant.timezone)),
    };
  });
}

const createSchema = z.object({
  total: z.string().transform((text, ctx) => {
    const pesewas = parseCedis(text);
    if (pesewas === null || pesewas < 200) {
      ctx.addIssue({ code: "custom", message: "Enter the amount to spread, at least GH₵2.00." });
      return z.NEVER;
    }
    return pesewas;
  }),
  count: z.coerce.number().int().min(2, "Use 2 to 12 instalments.").max(12, "Use 2 to 12 instalments."),
  firstDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date."),
  frequency: z.enum(FREQUENCIES, { message: "Choose how often." }),
});

/** Agrees an instalment plan with the family. One active plan per student; cancel it to agree a new one. */
export async function createPaymentPlan(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<string> {
  assertCan(ctx.roles, "fees.manage");
  const data = createSchema.parse(input);
  const today = todayIn(ctx.tenant.timezone);
  if (data.firstDueOn < today)
    throw new DomainError("past_date", "The first instalment cannot be due in the past.", "firstDueOn");
  const instalments = splitInstalments(data.total, data.count, data.firstDueOn, data.frequency);
  return withTenant(database, scope(ctx), async (tx) => {
    const student = await loadFinanceStudent(tx, ctx, studentId);
    if (!student) throw new DomainError("student_not_found", "Student not found.");
    const [plan] = await tx
      .insert(paymentPlans)
      .values({
        tenantId: ctx.tenant.id,
        studentId: student.id,
        totalPesewas: data.total,
        startsOn: today,
        createdByUserId: ctx.userId,
      })
      .returning({ id: paymentPlans.id });
    await tx
      .insert(paymentPlanInstalments)
      .values(instalments.map((i) => ({ ...i, tenantId: ctx.tenant.id, planId: plan!.id })));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.payment_plan_created",
      entityType: "student",
      entityId: student.id,
      metadata: { totalPesewas: data.total, instalments: data.count, frequency: data.frequency },
    });
    return plan!.id;
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError(
        "plan_exists",
        "This student already has a payment plan. Cancel it to agree a new one.",
      );
    throw error;
  });
}

export async function cancelPaymentPlan(
  database: Database,
  ctx: TenantContext,
  planId: string,
): Promise<void> {
  assertCan(ctx.roles, "fees.manage");
  if (!z.string().uuid().safeParse(planId).success) throw new DomainError("not_found", "Not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [plan] = await tx
      .select()
      .from(paymentPlans)
      .where(and(eq(paymentPlans.tenantId, ctx.tenant.id), eq(paymentPlans.id, planId)));
    if (!plan || !(await loadFinanceStudent(tx, ctx, plan.studentId)))
      throw new DomainError("not_found", "Not found.");
    if (plan.status === "cancelled") return;
    await tx
      .update(paymentPlans)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(paymentPlans.id, planId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.payment_plan_cancelled",
      entityType: "student",
      entityId: plan.studentId,
      metadata: { totalPesewas: plan.totalPesewas },
    });
  });
}
