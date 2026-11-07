import "server-only";
import { sql } from "drizzle-orm";
import { SETUP_STEPS, setupState, type SetupCounts, type SetupStep, type StepState } from "../../lib/setup";
import { allowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import type { TenantContext } from "../tenancy/service";

/**
 * How far a school is through setting up, worked out from its records each time. Shown to the people who
 * set a school up (Proprietor, Head teacher, Administrator); each step says who can do it.
 */

export function canSeeSetup(ctx: TenantContext): boolean {
  return allowed(ctx, "school.settings.manage") || allowed(ctx, "academics.manage");
}

export interface SetupProgress {
  counts: SetupCounts;
  steps: Record<SetupStep, StepState>;
  /** The steps that apply to this school, in order (subjects only when its plan includes assessment). */
  applicable: SetupStep[];
  done: number;
  complete: boolean;
}

export async function getSetupProgress(
  database: Database,
  ctx: TenantContext,
): Promise<SetupProgress | null> {
  if (!canSeeSetup(ctx)) return null;
  const t = ctx.tenant.id;
  const counts = await withTenant(
    database,
    { tenantId: t, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      // Counts only (no names or amounts), all scoped to this school; row-level security applies as well.
      const result = await tx.execute<Record<string, number | string | null>>(sql`
      with cur as (
        select t.id, t.name || ', ' || y.name as label
        from terms t join academic_years y on y.id = t.academic_year_id
        where t.tenant_id = ${t} and t.is_current
      ),
      active_classes as (
        select c.id, c.level_id, c.class_teacher_membership_id
        from classes c join levels l on l.id = c.level_id
        where c.tenant_id = ${t} and c.status = 'active' and l.status = 'active'
      ),
      placed as (
        select e.student_id from enrolments e
        join cur on cur.id = e.term_id
        join students s on s.id = e.student_id and s.status = 'active'
        where e.tenant_id = ${t}
      )
      select
        (select label from cur) as current_term,
        (select count(*) from academic_years where tenant_id = ${t})::int as years,
        (select count(*) from levels where tenant_id = ${t} and status = 'active')::int as levels,
        (select count(*) from active_classes)::int as classes,
        (select count(*) from active_classes where class_teacher_membership_id is not null)::int
          as classes_with_teacher,
        ((select count(*) from memberships where tenant_id = ${t} and status = 'active'
            and roles && array['headteacher','admin','bursar','teacher']::text[])
          + (select count(*) from invitations where tenant_id = ${t} and accepted_at is null
            and revoked_at is null and expires_at > now()
            and roles && array['headteacher','admin','bursar','teacher']::text[]))::int as staff,
        (select count(*) from students where tenant_id = ${t} and status = 'active')::int as active_students,
        (select count(*) from placed)::int as placed_students,
        (select count(*) from placed p where exists (
          select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id
          where sg.student_id = p.student_id and g.phone is not null))::int as placed_with_phone,
        (select count(*) from fee_items where tenant_id = ${t} and status = 'active')::int as fee_items,
        (select count(*) from fee_structure_lines f join cur on cur.id = f.term_id
          where f.tenant_id = ${t} and f.amount_pesewas > 0)::int as fee_lines,
        (select count(*) from placed p where exists (
          select 1 from ledger_entries le join cur on cur.id = le.term_id
          where le.tenant_id = ${t} and le.student_id = p.student_id and le.kind = 'charge'))::int
          as billed_students,
        (select count(distinct level_id) from active_classes)::int as levels_in_use,
        (select count(distinct ac.level_id) from active_classes ac
          where exists (select 1 from level_subjects ls where ls.level_id = ac.level_id))::int
          as levels_in_use_with_subjects
    `);
      const row = result.rows[0]!;
      const n = (key: string) => Number(row[key] ?? 0);
      return {
        currentTerm: (row.current_term as string | null) ?? null,
        years: n("years"),
        levels: n("levels"),
        classes: n("classes"),
        classesWithTeacher: n("classes_with_teacher"),
        staff: n("staff"),
        activeStudents: n("active_students"),
        placedStudents: n("placed_students"),
        placedWithPhone: n("placed_with_phone"),
        feeItems: n("fee_items"),
        feeLines: n("fee_lines"),
        billedStudents: n("billed_students"),
        levelsInUse: n("levels_in_use"),
        levelsInUseWithSubjects: n("levels_in_use_with_subjects"),
      } satisfies SetupCounts;
    },
  );
  const steps = setupState(counts);
  const applicable = SETUP_STEPS.filter(
    (step) => step !== "assessment" || ctx.features.includes("assessment"),
  );
  const done = applicable.filter((step) => steps[step].status === "done").length;
  return { counts, steps, applicable, done, complete: done === applicable.length };
}
