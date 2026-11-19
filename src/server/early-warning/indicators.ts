import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  absentInARow,
  attendanceLow,
  averageDown,
  REVIEW_OUTCOMES,
  subjectsBelow,
  waitingTooLong,
  type EarlyWarningRule,
  type EarlyWarningSettings,
  type Mark,
  type ReviewOutcome,
} from "../../lib/early-warning";
import { formatCalendarDate, todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import { seesAllClasses } from "../assessment/access";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { earlyWarningReviews } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { insertPlan, planInput } from "./plans";
import { readRules, scopeOf } from "./rules";

/**
 * Early-warning indicators (R5-3, EWS-01, EWS-02): the school's rules applied to this term's records whenever they
 * are read, so they follow every change. Academic leads see every class at their campuses; a teacher sees only the
 * classes they are class teacher of. Never families, students or EduBridge support (permissions).
 */

const NONE = "00000000-0000-0000-0000-000000000000";

export interface VisibleStudent {
  id: string;
  name: string;
  classId: string;
  className: string;
}

export interface CurrentTerm {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
}

async function currentTerm(tx: Transaction, ctx: TenantContext): Promise<CurrentTerm | null> {
  const [t] = (
    await tx.execute<{ id: string; label: string; starts_on: string; ends_on: string }>(sql`
      select t.id, t.name || ', ' || y.name as label, t.starts_on::text, t.ends_on::text
      from terms t join academic_years y on y.id = t.academic_year_id
      where t.tenant_id = ${ctx.tenant.id} and t.is_current`)
  ).rows;
  return t ? { id: t.id, label: t.label, startsOn: t.starts_on, endsOn: t.ends_on } : null;
}

/** Classes this person's early-warning view covers: all at their campuses for leads, their own for teachers. */
async function classFilter(tx: Transaction, ctx: TenantContext): Promise<SQL> {
  const parts: SQL[] = [sql`c.tenant_id = ${ctx.tenant.id}`];
  if (ctx.campusIds !== null) {
    const ids = ctx.campusIds.length ? ctx.campusIds : [NONE];
    parts.push(
      sql`c.campus_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  }
  if (!seesAllClasses(ctx)) {
    const [m] = (
      await tx.execute<{ id: string }>(sql`
        select id from memberships where tenant_id = ${ctx.tenant.id} and user_id = ${ctx.userId}`)
    ).rows;
    parts.push(sql`c.class_teacher_membership_id = ${m?.id ?? NONE}`);
  }
  return sql.join(parts, sql` and `);
}

/** Students placed this term in the classes the person's view covers. */
export async function visibleStudents(
  tx: Transaction,
  ctx: TenantContext,
  termId: string,
): Promise<VisibleStudent[]> {
  const filter = await classFilter(tx, ctx);
  const rows = await tx.execute<{ id: string; name: string; class_id: string; class_name: string }>(sql`
    select s.id, s.first_name || ' ' || s.last_name as name, c.id as class_id, c.name as class_name
    from enrolments e
    join students s on s.id = e.student_id
    join classes c on c.id = e.class_id
    join levels l on l.id = c.level_id
    where e.tenant_id = ${ctx.tenant.id} and e.term_id = ${termId} and s.status = 'active' and ${filter}
    order by l.sequence, c.name, s.last_name, s.first_name`);
  return rows.rows.map((r) => ({ id: r.id, name: r.name, classId: r.class_id, className: r.class_name }));
}

export interface IndicatorReview {
  outcome: ReviewOutcome;
  reason: string;
  by: string;
  at: Date;
  supportPlanId: string | null;
}

export interface Indicator {
  key: string;
  rule: EarlyWarningRule;
  student: VisibleStudent;
  /** The day the records first showed it (see EWS-01b). */
  raisedOn: string;
  evidence: string[];
  review: IndicatorReview | null;
  /** Not reviewed within 7 days of being raised. */
  waiting: boolean;
}

export interface Referral {
  reviewId: string;
  student: VisibleStudent;
  rule: EarlyWarningRule;
  reason: string;
  by: string;
  at: Date;
  /** A support plan was opened for the student after the referral. */
  planOpened: boolean;
}

export interface EarlyWarning {
  term: CurrentTerm | null;
  today: string;
  settings: EarlyWarningSettings;
  indicators: Indicator[];
  referrals: Referral[];
  /** Sees every class at their campuses (academic leads). */
  seesAll: boolean;
  canReview: boolean;
}

const list = (dates: string[]) => {
  const shown = dates.map((d) => formatCalendarDate(d));
  return shown.length <= 2 ? shown.join(" and ") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};

async function compute(tx: Transaction, ctx: TenantContext): Promise<EarlyWarning> {
  const today = todayIn(ctx.tenant.timezone);
  const settings = await readRules(tx, ctx.tenant.id);
  const base = {
    today,
    settings,
    seesAll: seesAllClasses(ctx),
    canReview: allowed(ctx, "early_warning.review"),
  };
  const term = await currentTerm(tx, ctx);
  if (!term) return { ...base, term: null, indicators: [], referrals: [] };
  const students = await visibleStudents(tx, ctx, term.id);
  if (!students.length) return { ...base, term, indicators: [], referrals: [] };
  const ids = sql.join(
    students.map((s) => sql`${s.id}::uuid`),
    sql`, `,
  );

  // Registers this term, far enough back to find when the current stretch began.
  const marks = (
    await tx.execute<{ student_id: string; date: string; status: Mark["status"] }>(sql`
      select m.student_id, r.date::text as date, m.status
      from attendance_marks m join attendance_registers r on r.id = m.register_id
      where m.tenant_id = ${ctx.tenant.id} and r.term_id = ${term.id} and m.student_id in (${ids})
        and r.date <= ${today}
      order by r.date`)
  ).rows;
  const marksOf = new Map<string, Mark[]>();
  for (const m of marks) {
    const of = marksOf.get(m.student_id) ?? [];
    of.push({ date: m.date, status: m.status });
    marksOf.set(m.student_id, of);
  }

  // Each student's published report cards, newest first: this term's, and the one before it.
  const cards = (
    await tx.execute<{
      student_id: string;
      term_id: string;
      term_label: string;
      average: string | null;
      subjects: { name: string; total: number | null }[] | null;
      published_on: string;
    }>(sql`
      select rc.student_id, rc.term_id, t.name || ', ' || y.name as term_label,
        rc.snapshot -> 'overall' ->> 'average' as average, rc.snapshot -> 'subjects' as subjects,
        (rc.published_at at time zone ${ctx.tenant.timezone})::date::text as published_on
      from report_cards rc join terms t on t.id = rc.term_id join academic_years y on y.id = t.academic_year_id
      where rc.tenant_id = ${ctx.tenant.id} and rc.status = 'published' and rc.student_id in (${ids})
        and t.starts_on <= ${term.startsOn}
      order by t.starts_on desc`)
  ).rows;

  const found: Omit<Indicator, "review" | "waiting">[] = [];
  for (const student of students) {
    const own = marksOf.get(student.id) ?? [];
    if (settings.attendanceOn) {
      const low = attendanceLow(own, today, settings.attendancePercent, settings.attendanceDays);
      if (low)
        found.push({
          key: `attendance_low:${student.id}:${term.id}:${low.raisedOn}`,
          rule: "attendance_low",
          student,
          raisedOn: low.raisedOn,
          evidence: [
            `Attended ${low.attended} of ${low.open} registers (${low.rate}%) from ${formatCalendarDate(low.from)} to ${formatCalendarDate(low.to)}, below the school's ${settings.attendancePercent}%.`,
            [
              low.absent ? `${low.absent} absent` : null,
              low.excused ? `${low.excused} absent with permission` : null,
            ]
              .filter(Boolean)
              .join(", ") + ".",
          ],
        });
    }
    if (settings.absencesOn) {
      const run = absentInARow(own, settings.absencesInARow);
      if (run)
        found.push({
          key: `absent_in_a_row:${student.id}:${run.dates[0]}`,
          rule: "absent_in_a_row",
          student,
          raisedOn: run.raisedOn,
          evidence: [
            `Absent without a reason on ${run.dates.length} registers in a row: ${list(run.dates)}.`,
          ],
        });
    }
    const mine = cards.filter((c) => c.student_id === student.id);
    const latest = mine.find((c) => c.term_id === term.id) ?? null;
    const before = mine.find((c) => c.term_id !== term.id) ?? null;
    if (settings.averageOn && latest && before) {
      const change = averageDown(
        before.average === null ? null : Number(before.average),
        latest.average === null ? null : Number(latest.average),
        settings.averageDrop,
      );
      if (change !== null)
        found.push({
          key: `average_down:${student.id}:${term.id}`,
          rule: "average_down",
          student,
          raisedOn: latest.published_on,
          evidence: [
            `Report-card average ${Number(latest.average).toFixed(1)} this term, down ${Math.abs(change).toFixed(1)} from ${Number(before.average).toFixed(1)} in ${before.term_label}.`,
          ],
        });
    }
    if (settings.subjectsOn && latest) {
      const below = subjectsBelow(latest.subjects ?? [], settings.passMark, settings.subjectsCount);
      if (below)
        found.push({
          key: `subjects_below:${student.id}:${term.id}`,
          rule: "subjects_below",
          student,
          raisedOn: latest.published_on,
          evidence: [
            `Below ${settings.passMark} in ${below.length} subjects on this term's report card: ${below
              .map((s) => `${s.name} (${s.total})`)
              .join(", ")}.`,
          ],
        });
    }
  }

  const reviews = (
    await tx.execute<{
      id: string;
      key: string;
      student_id: string;
      rule: EarlyWarningRule;
      outcome: ReviewOutcome;
      reason: string;
      name: string | null;
      at: Date;
      plan_id: string | null;
      plan_after: boolean;
    }>(sql`
      select r.id, r.indicator_key as key, r.student_id, r.rule, r.outcome, r.reason, u.name, r.reviewed_at as at,
        r.support_plan_id as plan_id,
        exists (select 1 from support_plans p where p.student_id = r.student_id and p.opened_at > r.reviewed_at)
          as plan_after
      from early_warning_reviews r left join users u on u.id = r.reviewed_by_user_id
      where r.tenant_id = ${ctx.tenant.id} and r.student_id in (${ids})
        and r.reviewed_at >= ${term.startsOn}::date`)
  ).rows;
  const byKey = new Map(reviews.map((r) => [r.key, r]));
  const byId = new Map(students.map((s) => [s.id, s]));
  return {
    ...base,
    term,
    indicators: found
      .map((f) => {
        const r = byKey.get(f.key);
        const review: IndicatorReview | null = r
          ? {
              outcome: r.outcome,
              reason: r.reason,
              by: r.name ?? "Someone",
              at: new Date(r.at),
              supportPlanId: r.plan_id,
            }
          : null;
        return { ...f, review, waiting: !review && waitingTooLong(f.raisedOn, today) };
      })
      .sort((a, b) => a.raisedOn.localeCompare(b.raisedOn)),
    referrals: reviews
      .filter((r) => r.outcome === "referred")
      .map((r) => ({
        reviewId: r.id,
        student: byId.get(r.student_id)!,
        rule: r.rule,
        reason: r.reason,
        by: r.name ?? "Someone",
        at: new Date(r.at),
        planOpened: r.plan_after,
      })),
  };
}

/** The indicators this term for the classes the person sees, with reviews and referrals. */
export async function getEarlyWarning(database: Database, ctx: TenantContext): Promise<EarlyWarning> {
  assertAllowed(ctx, "early_warning.view");
  return withTenant(database, scopeOf(ctx), (tx) => compute(tx, ctx));
}

/** How many indicators are waiting for a review (for the Command Center); null when the person may not see them. */
export async function countWaitingIndicators(database: Database, ctx: TenantContext): Promise<number | null> {
  if (!allowed(ctx, "early_warning.view") || !seesAllClasses(ctx)) return null;
  const ew = await getEarlyWarning(database, ctx);
  return ew.indicators.filter((i) => !i.review).length;
}

const reason = z
  .string()
  .trim()
  .min(3, "Give a reason: what you know about the student, or why no action is needed.")
  .max(500, "Keep the reason to 500 characters.");

const reviewInput = z.object({
  key: z.string().min(3).max(200),
  outcome: z.enum(REVIEW_OUTCOMES, { message: "Choose what happens next." }),
  reason,
});

/**
 * Reviews an indicator once (EWS-02a): no action needed, a support plan (opened in the same step), or referred to the
 * Head teacher; always with a reason. Kept (insert-only) and audited.
 */
export async function reviewIndicator(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<{ supportPlanId: string | null }> {
  assertAllowed(ctx, "early_warning.review");
  const parsed = reviewInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError("review_invalid", issue.message, String(issue.path[0] ?? "reason"));
  }
  const { key, outcome, reason: why } = parsed.data;
  const plan = outcome === "support_plan" ? planInput(input) : null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const ew = await compute(tx, ctx);
    const indicator = ew.indicators.find((i) => i.key === key);
    if (!indicator)
      throw new DomainError("indicator_not_found", "This indicator is no longer showing. Reload the page.");
    if (indicator.review)
      throw new DomainError("already_reviewed", "This indicator has already been reviewed.");
    const supportPlanId = plan ? await insertPlan(tx, ctx, indicator.student.id, plan) : null;
    try {
      const [row] = await tx
        .insert(earlyWarningReviews)
        .values({
          tenantId: ctx.tenant.id,
          indicatorKey: key,
          studentId: indicator.student.id,
          rule: indicator.rule,
          outcome,
          reason: why,
          supportPlanId,
          reviewedByUserId: ctx.userId,
        })
        .returning({ id: earlyWarningReviews.id });
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "early_warning.reviewed",
        entityType: "student",
        entityId: indicator.student.id,
        metadata: { review: row!.id, rule: indicator.rule, outcome },
      });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new DomainError("already_reviewed", "This indicator has already been reviewed.");
      throw error;
    }
    return { supportPlanId };
  });
}
