import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isIsoDate } from "../../lib/attendance";
import { todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { supportPlans, supportPlanUpdates } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { visibleStudents, type VisibleStudent } from "./indicators";
import { scopeOf } from "./rules";

/**
 * Support plans (R5-3, EWS-03): goal, actions, who is responsible and a review date. Never edited: updates are added,
 * each with a note and an optional new review date, and a plan is closed once with its outcome. Visible to the
 * student's class teacher and academic leads, as the indicators are.
 */

const text = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, `Keep it to ${max} characters.`);
const reviewDate = z.string().refine((v) => isIsoDate(v), "Choose the date the plan will be reviewed.");

const planSchema = z.object({
  goal: text(3, 300, "Say what the plan is for."),
  actions: text(3, 1000, "Say what will be done."),
  responsible: text(2, 120, "Say who is responsible."),
  reviewOn: reviewDate,
});
export type PlanInput = z.infer<typeof planSchema>;

/** Validates a plan's fields (also used when a review opens one). */
export function planInput(input: Record<string, unknown>): PlanInput {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError("plan_invalid", issue.message, String(issue.path[0] ?? "goal"));
  }
  return parsed.data;
}

async function currentTermId(tx: Transaction, ctx: TenantContext): Promise<string | null> {
  const [t] = (
    await tx.execute<{ id: string }>(
      sql`select id from terms where tenant_id = ${ctx.tenant.id} and is_current`,
    )
  ).rows;
  return t?.id ?? null;
}

async function studentInView(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
): Promise<VisibleStudent> {
  const termId = await currentTermId(tx, ctx);
  const student = termId
    ? (await visibleStudents(tx, ctx, termId)).find((s) => s.id === studentId)
    : undefined;
  if (!student) throw new DomainError("student_not_found", "This student is not in a class you look after.");
  return student;
}

/** Inserts a plan for a student the person looks after (the caller has checked the permission). */
export async function insertPlan(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
  plan: PlanInput,
): Promise<string> {
  await studentInView(tx, ctx, studentId);
  if (plan.reviewOn < todayIn(ctx.tenant.timezone))
    throw new DomainError("review_in_past", "The review date cannot be in the past.", "reviewOn");
  const [row] = await tx
    .insert(supportPlans)
    .values({ tenantId: ctx.tenant.id, studentId, ...plan, openedByUserId: ctx.userId })
    .returning({ id: supportPlans.id });
  await recordAudit(tx, {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "support_plan.opened",
    entityType: "student",
    entityId: studentId,
    metadata: { plan: row!.id },
  });
  return row!.id;
}

/** Opens a support plan for a student (e.g. after a referral to the Head teacher). */
export async function openSupportPlan(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<string> {
  assertAllowed(ctx, "early_warning.review");
  const studentId = z.string().uuid().safeParse(input.studentId);
  if (!studentId.success) throw new DomainError("student_not_found", "Choose a student.");
  const plan = planInput(input);
  return withTenant(database, scopeOf(ctx), (tx) => insertPlan(tx, ctx, studentId.data, plan));
}

export interface PlanSummary {
  id: string;
  student: VisibleStudent;
  goal: string;
  responsible: string;
  /** The latest review date (from the last update that set one, or the plan's). */
  reviewOn: string;
  openedOn: string;
  closed: boolean;
  /** Open and its review date has passed. */
  overdue: boolean;
}

interface PlanRow extends Record<string, unknown> {
  id: string;
  student_id: string;
  goal: string;
  actions: string;
  responsible: string;
  review_on: string;
  opened_at: Date;
  opened_by: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  outcome: string | null;
}

const planSelect = sql`
  select p.id, p.student_id, p.goal, p.actions, p.responsible,
    coalesce((select u.review_on from support_plan_updates u where u.plan_id = p.id and u.review_on is not null
      order by u.at desc limit 1), p.review_on)::text as review_on,
    p.opened_at, o.name as opened_by, p.closed_at, c.name as closed_by, p.outcome
  from support_plans p
  left join users o on o.id = p.opened_by_user_id
  left join users c on c.id = p.closed_by_user_id`;

/** Plans for the students the person looks after: open ones first (soonest review first), then closed. */
export async function listSupportPlans(database: Database, ctx: TenantContext): Promise<PlanSummary[]> {
  assertAllowed(ctx, "early_warning.view");
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx);
    if (!termId) return [];
    const students = await visibleStudents(tx, ctx, termId);
    if (!students.length) return [];
    const byId = new Map(students.map((s) => [s.id, s]));
    const rows = (
      await tx.execute<PlanRow>(sql`${planSelect}
        where p.tenant_id = ${ctx.tenant.id} and p.student_id in (${sql.join(
          students.map((s) => sql`${s.id}::uuid`),
          sql`, `,
        )})
        order by (p.closed_at is not null), 6, p.opened_at desc`)
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      student: byId.get(r.student_id)!,
      goal: r.goal,
      responsible: r.responsible,
      reviewOn: r.review_on,
      openedOn: new Date(r.opened_at).toISOString().slice(0, 10),
      closed: r.closed_at !== null,
      overdue: r.closed_at === null && r.review_on < today,
    }));
  });
}

export interface PlanDetail extends PlanSummary {
  actions: string;
  openedBy: string;
  openedAt: Date;
  closedBy: string | null;
  closedAt: Date | null;
  outcome: string | null;
  updates: { id: string; note: string; reviewOn: string | null; by: string; at: Date }[];
  /** The reviews that led to it. */
  reasons: { rule: string; reason: string; by: string; at: Date }[];
  canChange: boolean;
}

/** One plan, with its history, if the student is one the person looks after. */
export async function getSupportPlan(
  database: Database,
  ctx: TenantContext,
  planId: string,
): Promise<PlanDetail | null> {
  assertAllowed(ctx, "early_warning.view");
  if (!z.string().uuid().safeParse(planId).success) return null;
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [r] = (
      await tx.execute<PlanRow>(sql`${planSelect} where p.tenant_id = ${ctx.tenant.id} and p.id = ${planId}`)
    ).rows;
    if (!r) return null;
    const termId = await currentTermId(tx, ctx);
    const student = termId
      ? (await visibleStudents(tx, ctx, termId)).find((s) => s.id === r.student_id)
      : undefined;
    if (!student) return null;
    const updates = (
      await tx.execute<{
        id: string;
        note: string;
        review_on: string | null;
        name: string | null;
        at: Date;
      }>(sql`
        select u.id, u.note, u.review_on::text, us.name, u.at from support_plan_updates u
        left join users us on us.id = u.by_user_id
        where u.tenant_id = ${ctx.tenant.id} and u.plan_id = ${planId} order by u.at`)
    ).rows;
    const reasons = (
      await tx.execute<{ rule: string; reason: string; name: string | null; at: Date }>(sql`
        select r.rule, r.reason, u.name, r.reviewed_at as at from early_warning_reviews r
        left join users u on u.id = r.reviewed_by_user_id
        where r.tenant_id = ${ctx.tenant.id} and r.support_plan_id = ${planId}`)
    ).rows;
    return {
      id: r.id,
      student,
      goal: r.goal,
      actions: r.actions,
      responsible: r.responsible,
      reviewOn: r.review_on,
      openedOn: new Date(r.opened_at).toISOString().slice(0, 10),
      openedBy: r.opened_by ?? "Someone",
      openedAt: new Date(r.opened_at),
      closed: r.closed_at !== null,
      closedBy: r.closed_by,
      closedAt: r.closed_at ? new Date(r.closed_at) : null,
      outcome: r.outcome,
      overdue: r.closed_at === null && r.review_on < today,
      updates: updates.map((u) => ({
        id: u.id,
        note: u.note,
        reviewOn: u.review_on,
        by: u.name ?? "Someone",
        at: new Date(u.at),
      })),
      reasons: reasons.map((x) => ({
        rule: x.rule,
        reason: x.reason,
        by: x.name ?? "Someone",
        at: new Date(x.at),
      })),
      canChange: allowed(ctx, "early_warning.review") && r.closed_at === null,
    };
  });
}

async function openPlanInView(tx: Transaction, ctx: TenantContext, planId: string) {
  if (!z.string().uuid().safeParse(planId).success)
    throw new DomainError("plan_not_found", "Plan not found.");
  const [p] = (
    await tx.execute<{ student_id: string; closed: boolean }>(sql`
      select student_id, closed_at is not null as closed from support_plans
      where tenant_id = ${ctx.tenant.id} and id = ${planId}`)
  ).rows;
  if (!p) throw new DomainError("plan_not_found", "Plan not found.");
  await studentInView(tx, ctx, p.student_id);
  if (p.closed) throw new DomainError("plan_closed", "This plan is closed.");
  return p;
}

const updateSchema = z.object({
  note: text(3, 1000, "Say what has happened since."),
  reviewOn: z.preprocess((v) => (v === "" || v === undefined ? null : v), reviewDate.nullable()),
});

/** Adds an update to an open plan, with an optional new review date. */
export async function addPlanUpdate(
  database: Database,
  ctx: TenantContext,
  planId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "early_warning.review");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError("update_invalid", issue.message, String(issue.path[0] ?? "note"));
  }
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const p = await openPlanInView(tx, ctx, planId);
    if (parsed.data.reviewOn && parsed.data.reviewOn < todayIn(ctx.tenant.timezone))
      throw new DomainError("review_in_past", "The review date cannot be in the past.", "reviewOn");
    await tx.insert(supportPlanUpdates).values({
      tenantId: ctx.tenant.id,
      planId,
      note: parsed.data.note,
      reviewOn: parsed.data.reviewOn,
      byUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "support_plan.updated",
      entityType: "student",
      entityId: p.student_id,
      metadata: { plan: planId },
    });
  });
}

/** Closes an open plan, once, with its outcome. */
export async function closeSupportPlan(
  database: Database,
  ctx: TenantContext,
  planId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "early_warning.review");
  const outcome = text(3, 500, "Say how it went.").safeParse(input.outcome ?? "");
  if (!outcome.success) throw new DomainError("outcome_invalid", outcome.error.issues[0]!.message, "outcome");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const p = await openPlanInView(tx, ctx, planId);
    await tx.execute(sql`
      update support_plans set closed_at = now(), closed_by_user_id = ${ctx.userId}, outcome = ${outcome.data}
      where tenant_id = ${ctx.tenant.id} and id = ${planId}`);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "support_plan.closed",
      entityType: "student",
      entityId: p.student_id,
      metadata: { plan: planId },
    });
  });
}
