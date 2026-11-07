import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { addDays } from "../../lib/attendance";
import { todayIn } from "../../lib/format";
import { change, rate, schoolDaysBetween } from "../../lib/insights";
import { assertAllowed, allowed } from "../authz/permissions";
import { listAssessmentClasses } from "../assessment/scores";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { planProgress } from "../fees/plan-schedule";
import type { TenantContext } from "../tenancy/service";

/**
 * School insights: descriptive analytics across terms and years, from the school's own records. Nothing
 * here predicts; every figure is a count or an average of records the person can open, and each section
 * is shown only to people whose role covers it (academic leads, finance staff). Campus scope applies.
 *
 *  - Academic figures use published report cards only (frozen at publication, so they never shift).
 *  - Attendance counts register marks (late counts as attending, as everywhere else).
 *  - Money: billed is charges less discounts for the term (reversed entries left out); collected is
 *    receipts not voided dated within the term.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const NONE = "00000000-0000-0000-0000-000000000000";

/** A uuid[] literal from ids (drizzle would otherwise expand an array into a list of parameters). */
const uuidArray = (ids: readonly string[]): SQL =>
  sql`array[${sql.join(
    (ids.length ? ids : [NONE]).map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/** Academic leads see results and attendance for every class (within campus scope). */
export const seesAcademics = (ctx: TenantContext) =>
  allowed(ctx, "academics.manage") || allowed(ctx, "reports.publish");
export const seesFinance = (ctx: TenantContext) => allowed(ctx, "fees.view");

/** Limits a query on a classes alias to the person's campuses. */
function campusOf(ctx: TenantContext, alias: string): SQL {
  if (ctx.campusIds === null) return sql`true`;
  const ids = ctx.campusIds.length ? ctx.campusIds : [NONE];
  return sql`${sql.raw(alias)}.campus_id = any(${uuidArray(ids)})`;
}

/** The student's class this term must be at the person's campuses (finance scope, as in fee reports). */
function studentCampus(ctx: TenantContext, studentRef: string): SQL {
  if (ctx.campusIds === null) return sql`true`;
  const ids = ctx.campusIds.length ? ctx.campusIds : [NONE];
  return sql`exists (select 1 from enrolments e2 join terms t2 on t2.id = e2.term_id and t2.is_current
    join classes c2 on c2.id = e2.class_id where e2.student_id = ${sql.raw(studentRef)} and c2.campus_id = any(${uuidArray(ids)}))`;
}

interface TermRow extends Record<string, unknown> {
  id: string;
  name: string;
  year: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
}

async function recentTerms(tx: Transaction, ctx: TenantContext, limit: number): Promise<TermRow[]> {
  const today = todayIn(ctx.tenant.timezone);
  const rows = await tx.execute<TermRow>(sql`
    select t.id, t.name, y.name as year, t.starts_on::text, t.ends_on::text, t.is_current
    from terms t join academic_years y on y.id = t.academic_year_id
    where t.tenant_id = ${ctx.tenant.id} and t.starts_on <= ${today}
    order by t.starts_on desc limit ${limit}`);
  return rows.rows.reverse();
}

const label = (t: TermRow) => `${t.name}, ${t.year}`;

export interface TermPoint {
  termId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  current: boolean;
  /** Students placed in classes that term. */
  enrolled: number;
  /** Placed for the first time at this school that term. */
  newStudents: number;
  attendanceRate: number | null;
  latenessRate: number | null;
  /** Average of published report cards' overall averages, out of 100. */
  averageScore: number | null;
  publishedCards: number;
  billedPesewas: number | null;
  collectedPesewas: number | null;
  collectionRate: number | null;
}

/** The school term by term (the last `limit` terms that have started), for trends. */
export async function getTermTrends(database: Database, ctx: TenantContext, limit = 6): Promise<TermPoint[]> {
  assertAllowed(ctx, "insights.view");
  const academics = seesAcademics(ctx);
  const finance = seesFinance(ctx);
  return withTenant(database, scope(ctx), async (tx) => {
    const terms = await recentTerms(tx, ctx, limit);
    const result: TermPoint[] = [];
    for (const t of terms) {
      const [enrol] = (
        await tx.execute<{ enrolled: number; new_students: number }>(sql`
          select count(*)::int as enrolled,
            count(*) filter (where not exists (
              select 1 from enrolments p join terms pt on pt.id = p.term_id
              where p.student_id = e.student_id and pt.starts_on < ${t.starts_on}))::int as new_students
          from enrolments e join classes c on c.id = e.class_id
          where e.tenant_id = ${ctx.tenant.id} and e.term_id = ${t.id} and ${campusOf(ctx, "c")}`)
      ).rows;
      let attendanceRate: number | null = null;
      let latenessRate: number | null = null;
      let averageScore: number | null = null;
      let publishedCards = 0;
      if (academics) {
        const [a] = (
          await tx.execute<{ marks: number; attended: number; late: number }>(sql`
            select count(*)::int as marks,
              count(*) filter (where m.status in ('present', 'late'))::int as attended,
              count(*) filter (where m.status = 'late')::int as late
            from attendance_marks m join attendance_registers r on r.id = m.register_id
            join classes c on c.id = r.class_id
            where m.tenant_id = ${ctx.tenant.id} and r.term_id = ${t.id} and ${campusOf(ctx, "c")}`)
        ).rows;
        attendanceRate = rate(a?.attended ?? 0, a?.marks ?? 0);
        latenessRate = rate(a?.late ?? 0, a?.marks ?? 0);
        const [s] = (
          await tx.execute<{ cards: number; average: string | null }>(sql`
            select count(*)::int as cards, round(avg((rc.snapshot -> 'overall' ->> 'average')::numeric), 1)::text as average
            from report_cards rc
            join enrolments e on e.student_id = rc.student_id and e.term_id = rc.term_id
            join classes c on c.id = e.class_id
            where rc.tenant_id = ${ctx.tenant.id} and rc.term_id = ${t.id} and rc.status = 'published'
              and ${campusOf(ctx, "c")}`)
        ).rows;
        publishedCards = s?.cards ?? 0;
        averageScore = s?.average === null || s?.average === undefined ? null : Number(s.average);
      }
      let billed: number | null = null;
      let collected: number | null = null;
      if (finance) {
        const [b] = (
          await tx.execute<{ billed: string }>(sql`
            select coalesce(sum(l.amount_pesewas), 0)::text as billed from ledger_entries l
            where l.tenant_id = ${ctx.tenant.id} and l.term_id = ${t.id} and l.kind in ('charge', 'discount')
              and not exists (select 1 from ledger_entries r where r.reverses_entry_id = l.id)
              and ${studentCampus(ctx, "l.student_id")}`)
        ).rows;
        const [p] = (
          await tx.execute<{ collected: string }>(sql`
            select coalesce(sum(p.amount_pesewas), 0)::text as collected from payments p
            where p.tenant_id = ${ctx.tenant.id} and p.paid_on between ${t.starts_on} and ${t.ends_on}
              and not exists (select 1 from payment_voids v where v.payment_id = p.id)
              and ${studentCampus(ctx, "p.student_id")}`)
        ).rows;
        billed = Number(b?.billed ?? 0);
        collected = Number(p?.collected ?? 0);
      }
      result.push({
        termId: t.id,
        label: label(t),
        startsOn: t.starts_on,
        endsOn: t.ends_on,
        current: t.is_current,
        enrolled: enrol?.enrolled ?? 0,
        newStudents: enrol?.new_students ?? 0,
        attendanceRate,
        latenessRate,
        averageScore,
        publishedCards,
        billedPesewas: billed,
        collectedPesewas: collected,
        collectionRate: billed !== null && collected !== null ? rate(collected, billed) : null,
      });
    }
    return result;
  });
}

export interface LevelPerformance {
  levelId: string;
  levelName: string;
  terms: { termId: string; label: string; average: number | null; students: number }[];
  subjects: { name: string; averages: (number | null)[] }[];
}

/**
 * Results for one level (or every level) across the last `limit` terms: the average of report-card
 * averages, and each subject's average total, from published report cards.
 */
export async function getLevelPerformance(
  database: Database,
  ctx: TenantContext,
  options: { levelId?: string | null; levelName?: string | null; limit?: number } = {},
): Promise<LevelPerformance[]> {
  assertAllowed(ctx, "insights.view");
  if (!seesAcademics(ctx)) return [];
  return withTenant(database, scope(ctx), async (tx) => {
    const terms = await recentTerms(tx, ctx, options.limit ?? 3);
    if (!terms.length) return [];
    const termIds = terms.map((t) => t.id);
    const levelFilter = options.levelId
      ? sql`and l.id = ${options.levelId}`
      : options.levelName
        ? sql`and lower(l.name) = lower(${options.levelName})`
        : sql``;
    const overall = await tx.execute<{
      level_id: string;
      level: string;
      term_id: string;
      average: string | null;
      students: number;
    }>(sql`
      select l.id as level_id, l.name as level, rc.term_id,
        round(avg((rc.snapshot -> 'overall' ->> 'average')::numeric), 1)::text as average, count(*)::int as students
      from report_cards rc
      join enrolments e on e.student_id = rc.student_id and e.term_id = rc.term_id
      join classes c on c.id = e.class_id join levels l on l.id = c.level_id
      where rc.tenant_id = ${ctx.tenant.id} and rc.status = 'published' and rc.term_id = any(${uuidArray(termIds)})
        and ${campusOf(ctx, "c")} ${levelFilter}
      group by l.id, l.name, l.sequence, rc.term_id order by l.sequence`);
    const subjects = await tx.execute<{
      level_id: string;
      subject: string;
      term_id: string;
      average: string | null;
    }>(sql`
      select l.id as level_id, s ->> 'name' as subject, rc.term_id,
        round(avg((s ->> 'total')::numeric), 1)::text as average
      from report_cards rc
      join enrolments e on e.student_id = rc.student_id and e.term_id = rc.term_id
      join classes c on c.id = e.class_id join levels l on l.id = c.level_id
      cross join lateral jsonb_array_elements(rc.snapshot -> 'subjects') s
      where rc.tenant_id = ${ctx.tenant.id} and rc.status = 'published' and rc.term_id = any(${uuidArray(termIds)})
        and ${campusOf(ctx, "c")} ${levelFilter}
      group by l.id, s ->> 'name', rc.term_id order by s ->> 'name'`);
    const levels = new Map<string, LevelPerformance>();
    for (const row of overall.rows) {
      const lp =
        levels.get(row.level_id) ??
        ({
          levelId: row.level_id,
          levelName: row.level,
          terms: terms.map((t) => ({ termId: t.id, label: label(t), average: null, students: 0 })),
          subjects: [],
        } satisfies LevelPerformance);
      const point = lp.terms.find((x) => x.termId === row.term_id)!;
      point.average = row.average === null ? null : Number(row.average);
      point.students = row.students;
      levels.set(row.level_id, lp);
    }
    for (const row of subjects.rows) {
      const lp = levels.get(row.level_id);
      if (!lp) continue;
      let subject = lp.subjects.find((x) => x.name === row.subject);
      if (!subject) {
        subject = { name: row.subject, averages: terms.map(() => null) };
        lp.subjects.push(subject);
      }
      subject.averages[termIds.indexOf(row.term_id)] = row.average === null ? null : Number(row.average);
    }
    return [...levels.values()];
  });
}

export interface StudentTrend {
  studentId: string;
  name: string;
  className: string | null;
  previous: { term: string; average: number } | null;
  latest: { term: string; average: number };
  change: number | null;
}

/**
 * Students whose report-card average fell by at least `drop` points between their last two published
 * cards (declining), and students whose latest average is below `below` (may need support).
 */
export async function getStudentTrends(
  database: Database,
  ctx: TenantContext,
  options: { drop?: number; below?: number; limit?: number } = {},
): Promise<{ declining: StudentTrend[]; support: StudentTrend[] }> {
  assertAllowed(ctx, "insights.view");
  if (!seesAcademics(ctx)) return { declining: [], support: [] };
  const drop = options.drop ?? 10;
  const below = options.below ?? 50;
  const limit = options.limit ?? 50;
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx.execute<{
      student_id: string;
      name: string;
      class_name: string | null;
      latest_term: string;
      latest: string;
      previous_term: string | null;
      previous: string | null;
    }>(sql`
      with cards as (
        select rc.student_id, t.name || ', ' || y.name as term,
          (rc.snapshot -> 'overall' ->> 'average')::numeric as average,
          row_number() over (partition by rc.student_id order by t.starts_on desc) as n
        from report_cards rc join terms t on t.id = rc.term_id join academic_years y on y.id = t.academic_year_id
        where rc.tenant_id = ${ctx.tenant.id} and rc.status = 'published'
          and rc.snapshot -> 'overall' ->> 'average' is not null
      )
      select s.id as student_id, s.first_name || ' ' || s.last_name as name, c.name as class_name,
        a.term as latest_term, a.average::text as latest, b.term as previous_term, b.average::text as previous
      from cards a
      left join cards b on b.student_id = a.student_id and b.n = 2
      join students s on s.id = a.student_id and s.status = 'active'
      left join enrolments e on e.student_id = s.id
        and e.term_id = (select id from terms where tenant_id = ${ctx.tenant.id} and is_current)
      left join classes c on c.id = e.class_id
      where a.n = 1 and ${ctx.campusIds === null ? sql`true` : sql`c.id is not null and ${campusOf(ctx, "c")}`}`);
    const trends: StudentTrend[] = rows.rows.map((r) => {
      const latest = Number(r.latest);
      const previous = r.previous === null ? null : Number(r.previous);
      return {
        studentId: r.student_id,
        name: r.name,
        className: r.class_name,
        latest: { term: r.latest_term, average: latest },
        previous: previous === null ? null : { term: r.previous_term!, average: previous },
        change: previous === null ? null : change(previous, latest),
      };
    });
    return {
      declining: trends
        .filter((t) => t.change !== null && t.change <= -drop)
        .sort((a, b) => a.change! - b.change!)
        .slice(0, limit),
      support: trends
        .filter((t) => t.latest.average < below)
        .sort((a, b) => a.latest.average - b.latest.average)
        .slice(0, limit),
    };
  });
}

export interface AttendanceInsights {
  term: { id: string; label: string } | null;
  byClass: {
    classId: string;
    className: string;
    marks: number;
    absent: number;
    late: number;
    absenceRate: number | null;
  }[];
  /** Absent on at least 10% of their registers this term (once on 5 or more). */
  chronic: {
    studentId: string;
    name: string;
    className: string;
    absent: number;
    marked: number;
    absenceRate: number;
  }[];
  /** Late at least 3 times in the last 30 days. */
  lateness: { studentId: string; name: string; className: string; late: number }[];
}

export async function getAttendanceInsights(
  database: Database,
  ctx: TenantContext,
): Promise<AttendanceInsights> {
  assertAllowed(ctx, "insights.view");
  const empty: AttendanceInsights = { term: null, byClass: [], chronic: [], lateness: [] };
  if (!seesAcademics(ctx)) return empty;
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const [term] = (await recentTerms(tx, ctx, 1)).filter(Boolean);
    if (!term) return empty;
    const byClass = await tx.execute<{
      class_id: string;
      class_name: string;
      marks: number;
      absent: number;
      late: number;
    }>(sql`
      select c.id as class_id, c.name as class_name, count(*)::int as marks,
        count(*) filter (where m.status = 'absent')::int as absent,
        count(*) filter (where m.status = 'late')::int as late
      from attendance_marks m join attendance_registers r on r.id = m.register_id join classes c on c.id = r.class_id
      where m.tenant_id = ${ctx.tenant.id} and r.term_id = ${term.id} and ${campusOf(ctx, "c")}
      group by c.id, c.name`);
    const students = await tx.execute<{
      student_id: string;
      name: string;
      class_name: string;
      absent: number;
      marked: number;
    }>(sql`
      select s.id as student_id, s.first_name || ' ' || s.last_name as name, c.name as class_name,
        count(*) filter (where m.status = 'absent')::int as absent, count(*)::int as marked
      from attendance_marks m join attendance_registers r on r.id = m.register_id join classes c on c.id = r.class_id
      join students s on s.id = m.student_id and s.status = 'active'
      where m.tenant_id = ${ctx.tenant.id} and r.term_id = ${term.id} and ${campusOf(ctx, "c")}
      group by s.id, s.first_name, s.last_name, c.name
      having count(*) >= 5 and count(*) filter (where m.status = 'absent') * 10 >= count(*)`);
    const late = await tx.execute<{ student_id: string; name: string; class_name: string; late: number }>(sql`
      select s.id as student_id, s.first_name || ' ' || s.last_name as name, c.name as class_name, count(*)::int as late
      from attendance_marks m join attendance_registers r on r.id = m.register_id join classes c on c.id = r.class_id
      join students s on s.id = m.student_id and s.status = 'active'
      where m.tenant_id = ${ctx.tenant.id} and m.status = 'late' and r.date > ${addDays(today, -30)}
        and ${campusOf(ctx, "c")}
      group by s.id, s.first_name, s.last_name, c.name having count(*) >= 3`);
    return {
      term: { id: term.id, label: label(term) },
      byClass: byClass.rows
        .map((r) => ({
          classId: r.class_id,
          className: r.class_name,
          marks: r.marks,
          absent: r.absent,
          late: r.late,
          absenceRate: rate(r.absent, r.marks),
        }))
        .sort((a, b) => (b.absenceRate ?? 0) - (a.absenceRate ?? 0)),
      chronic: students.rows
        .map((r) => ({
          studentId: r.student_id,
          name: r.name,
          className: r.class_name,
          absent: r.absent,
          marked: r.marked,
          absenceRate: rate(r.absent, r.marked) ?? 0,
        }))
        .sort((a, b) => b.absenceRate - a.absenceRate),
      lateness: late.rows
        .map((r) => ({ studentId: r.student_id, name: r.name, className: r.class_name, late: r.late }))
        .sort((a, b) => b.late - a.late),
    };
  });
}

export interface FinanceInsights {
  term: { id: string; label: string } | null;
  /** This term by level: billed, collected from those students, and what they owe today. */
  byLevel: {
    levelName: string;
    students: number;
    billedPesewas: number;
    collectedPesewas: number;
    owedPesewas: number;
  }[];
  /** Instalments on active payment plans, still unpaid, by when they fall due (scheduled cash coming in). */
  planDue: {
    overduePesewas: number;
    next30Pesewas: number;
    next60Pesewas: number;
    next90Pesewas: number;
    plans: number;
  };
}

export async function getFinanceInsights(database: Database, ctx: TenantContext): Promise<FinanceInsights> {
  assertAllowed(ctx, "insights.view");
  const empty: FinanceInsights = {
    term: null,
    byLevel: [],
    planDue: { overduePesewas: 0, next30Pesewas: 0, next60Pesewas: 0, next90Pesewas: 0, plans: 0 },
  };
  if (!seesFinance(ctx)) return empty;
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const [term] = await recentTerms(tx, ctx, 1);
    const byLevel = term
      ? await tx.execute<{
          level: string;
          students: number;
          billed: string;
          collected: string;
          owed: string;
        }>(sql`
          with placed as (
            select e.student_id, l.name as level, l.sequence from enrolments e
            join classes c on c.id = e.class_id join levels l on l.id = c.level_id
            where e.tenant_id = ${ctx.tenant.id} and e.term_id = ${term.id} and ${campusOf(ctx, "c")}
          )
          select p.level, count(*)::int as students,
            coalesce(sum((select sum(l.amount_pesewas) from ledger_entries l where l.student_id = p.student_id
              and l.term_id = ${term.id} and l.kind in ('charge', 'discount')
              and not exists (select 1 from ledger_entries r where r.reverses_entry_id = l.id))), 0)::text as billed,
            coalesce(sum((select sum(pm.amount_pesewas) from payments pm where pm.student_id = p.student_id
              and pm.paid_on between ${term.starts_on} and ${term.ends_on}
              and not exists (select 1 from payment_voids v where v.payment_id = pm.id))), 0)::text as collected,
            coalesce(sum(greatest((select sum(l.amount_pesewas) from ledger_entries l where l.student_id = p.student_id), 0)), 0)::text as owed
          from placed p group by p.level, p.sequence order by p.sequence`)
      : { rows: [] };
    const plans = await tx.execute<{
      id: string;
      created_at: Date;
      paid: string;
      instalments: { sequence: number; dueOn: string; amountPesewas: number }[];
    }>(sql`
      select pp.id, pp.created_at,
        coalesce((select sum(pm.amount_pesewas) from payments pm where pm.student_id = pp.student_id
          and pm.recorded_at >= pp.created_at
          and not exists (select 1 from payment_voids v where v.payment_id = pm.id)), 0)::text as paid,
        (select json_agg(json_build_object('sequence', i.sequence, 'dueOn', i.due_on, 'amountPesewas', i.amount_pesewas))
          from payment_plan_instalments i where i.plan_id = pp.id) as instalments
      from payment_plans pp
      where pp.tenant_id = ${ctx.tenant.id} and pp.status = 'active' and ${studentCampus(ctx, "pp.student_id")}`);
    const planDue = { ...empty.planDue, plans: plans.rows.length };
    for (const plan of plans.rows) {
      const progress = planProgress(
        (plan.instalments ?? []).map((i) => ({ ...i, amountPesewas: Number(i.amountPesewas) })),
        Number(plan.paid),
        today,
      );
      for (const inst of progress.instalments) {
        const unpaid = inst.amountPesewas - inst.paidPesewas;
        if (unpaid <= 0) continue;
        if (inst.dueOn < today) planDue.overduePesewas += unpaid;
        else if (inst.dueOn <= addDays(today, 30)) planDue.next30Pesewas += unpaid;
        else if (inst.dueOn <= addDays(today, 60)) planDue.next60Pesewas += unpaid;
        else if (inst.dueOn <= addDays(today, 90)) planDue.next90Pesewas += unpaid;
      }
    }
    return {
      term: term ? { id: term.id, label: label(term) } : null,
      byLevel: byLevel.rows.map((r) => ({
        levelName: r.level,
        students: r.students,
        billedPesewas: Number(r.billed),
        collectedPesewas: Number(r.collected),
        owedPesewas: Number(r.owed),
      })),
      planDue,
    };
  });
}

export interface OperationsInsights {
  /** School days in the last two weeks with no register, per class (current term). */
  missingRegisters: { classId: string; className: string; teacher: string | null; days: string[] }[];
  /** Classes whose score sheets are not complete this term, with the class teacher. */
  marksOutstanding: {
    classId: string;
    className: string;
    teacher: string | null;
    completeSheets: number;
    subjects: number;
  }[];
}

export async function getOperationsInsights(
  database: Database,
  ctx: TenantContext,
): Promise<OperationsInsights> {
  assertAllowed(ctx, "insights.view");
  if (!seesAcademics(ctx)) return { missingRegisters: [], marksOutstanding: [] };
  const today = todayIn(ctx.tenant.timezone);
  const { term, rows, holidays } = await withTenant(database, scope(ctx), async (tx) => {
    const [current] = (
      await tx.execute<TermRow>(sql`
        select t.id, t.name, y.name as year, t.starts_on::text, t.ends_on::text, t.is_current
        from terms t join academic_years y on y.id = t.academic_year_id
        where t.tenant_id = ${ctx.tenant.id} and t.is_current`)
    ).rows;
    if (!current) return { term: null, rows: [], holidays: [] };
    const classes = await tx.execute<{
      id: string;
      name: string;
      teacher: string | null;
      dates: string[] | null;
    }>(sql`
      select c.id, c.name, u.name as teacher,
        (select array_agg(r.date::text) from attendance_registers r where r.class_id = c.id
          and r.date > ${addDays(today, -21)}) as dates
      from classes c left join memberships ms on ms.id = c.class_teacher_membership_id
      left join users u on u.id = ms.user_id
      where c.tenant_id = ${ctx.tenant.id} and c.status = 'active' and ${campusOf(ctx, "c")}
        and exists (select 1 from enrolments e where e.class_id = c.id and e.term_id = ${current.id})
      order by c.name`);
    const off = await tx.execute<{ starts_on: string; ends_on: string }>(sql`
      select starts_on::text, ends_on::text from school_holidays where tenant_id = ${ctx.tenant.id}`);
    return {
      term: current,
      rows: classes.rows,
      holidays: off.rows.map((h) => ({ startsOn: h.starts_on, endsOn: h.ends_on })),
    };
  });
  if (!term) return { missingRegisters: [], marksOutstanding: [] };
  const from = [addDays(today, -13), term.starts_on].sort().at(-1)!;
  const to = [today, term.ends_on].sort()[0]!;
  const days = from <= to ? schoolDaysBetween(from, to, holidays) : [];
  const missingRegisters = rows
    .map((c) => {
      const taken = new Set(c.dates ?? []);
      return {
        classId: c.id,
        className: c.name,
        teacher: c.teacher,
        days: days.filter((d) => !taken.has(d)),
      };
    })
    .filter((c) => c.days.length > 0)
    .sort((a, b) => b.days.length - a.days.length);
  const progress = allowed(ctx, "assessment.enter")
    ? await listAssessmentClasses(database, ctx, term.id)
    : null;
  const marksOutstanding = (progress?.classes ?? [])
    .filter((p) => p.students > 0 && p.completeSheets < p.subjects)
    .map((p) => ({
      classId: p.cls.id,
      className: p.cls.name,
      teacher: p.cls.classTeacherName,
      completeSheets: p.completeSheets,
      subjects: p.subjects,
    }));
  return { missingRegisters, marksOutstanding };
}
