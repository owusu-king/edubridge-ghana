import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { percent } from "../../lib/dashboard";
import { todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed, ForbiddenError } from "../authz/permissions";
import { listCampuses } from "../campuses/service";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { narrowToCampus } from "../fees/access";
import { getPeriodLock } from "../fees/period-lock";
import { getTermPoint, seesAcademics, type TermPoint } from "../insights/service";
import { countOpenDifferences } from "../mobile-money/reconciliation";
import type { TenantContext } from "../tenancy/service";
import { getOwedToday, getTermFinance, type OwedToday, type TermFinance } from "./finance";
import { getEnrolment, type Enrolment } from "./school";

/**
 * The Command Center's figures that the overview services do not already count (R5-1): enrolment movement,
 * operations now, reconciliation status, and the one-page board summary. The Command Center is the school's
 * overview page (`/s/[school]`); every figure here is counted with the same (campus-narrowed) context as the
 * report it links to.
 */

const NONE = "00000000-0000-0000-0000-000000000000";
const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** A classes alias limited to the person's campuses. */
function campusOf(ctx: TenantContext, alias: string): SQL {
  if (ctx.campusIds === null) return sql`true`;
  const ids = ctx.campusIds.length ? ctx.campusIds : [NONE];
  return sql`${sql.raw(alias)}.campus_id = any(${sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`})`;
}

interface TermRow extends Record<string, unknown> {
  id: string;
  name: string;
  year: string;
  starts_on: string;
  ends_on: string;
}

async function loadTerm(tx: Transaction, tenantId: string, termId: string): Promise<TermRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(termId)) return null;
  const rows = await tx.execute<TermRow>(sql`
    select t.id, t.name, y.name as year, t.starts_on::text, t.ends_on::text
    from terms t join academic_years y on y.id = t.academic_year_id
    where t.tenant_id = ${tenantId} and t.id = ${termId}`);
  return rows.rows[0] ?? null;
}

export interface Reconciliation {
  /** Mobile Money differences not yet looked at. */
  openDifferences: number;
  /** Refunds requested or approved, not yet paid or closed. */
  refundsWaiting: number;
  /** The last day the accounts are closed to, or null. */
  closedTo: string | null;
}

export interface Movement {
  /** Applications received within the term's dates. */
  applications: number;
  /** Applications enrolled within the term's dates. */
  admitted: number;
  /** Students who left within the term's dates, by reason. */
  left: { withdrawn: number; transferred: number; graduated: number };
  /** Of the students placed last term and not graduated, the share placed this term (null without a previous term). */
  retention: { previous: number; returned: number; rate: number | null; previousTerm: string } | null;
}

export interface Operations {
  leaveWaiting: number | null;
  maintenanceOpen: number | null;
  maintenanceUrgent: number | null;
  purchasesWaiting: number | null;
  exeatsOverdue: number | null;
  libraryOverdue: number | null;
  pickupsRefusedToday: number | null;
  visitorsOnSite: number | null;
}

async function readReconciliation(database: Database, ctx: TenantContext): Promise<Reconciliation> {
  const [openDifferences, lock, refunds] = await Promise.all([
    countOpenDifferences(database, ctx),
    getPeriodLock(database, ctx),
    withTenant(database, scopeOf(ctx), async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from refunds f
        where f.tenant_id = ${ctx.tenant.id} and f.status in ('requested', 'approved')`);
      return rows.rows[0]?.n ?? 0;
    }),
  ]);
  return { openDifferences, refundsWaiting: refunds, closedTo: lock.lockedThrough };
}

async function readMovement(tx: Transaction, ctx: TenantContext, term: TermRow): Promise<Movement> {
  const [apps] = (
    await tx.execute<{ applications: number; admitted: number }>(sql`
      select count(*) filter (where a.created_at::date between ${term.starts_on} and ${term.ends_on})::int as applications,
        count(*) filter (where a.status = 'enrolled' and a.closed_at::date between ${term.starts_on} and ${term.ends_on})::int as admitted
      from applications a where a.tenant_id = ${ctx.tenant.id}`)
  ).rows;
  // Students whose class in the term is at the person's campuses, and who left within its dates.
  const [left] = (
    await tx.execute<{ withdrawn: number; transferred: number; graduated: number }>(sql`
      select count(*) filter (where s.status = 'withdrawn')::int as withdrawn,
        count(*) filter (where s.status = 'transferred')::int as transferred,
        count(*) filter (where s.status = 'graduated')::int as graduated
      from students s
      where s.tenant_id = ${ctx.tenant.id} and s.status in ('withdrawn', 'transferred', 'graduated')
        and s.status_changed_at::date between ${term.starts_on} and ${term.ends_on}
        and exists (select 1 from enrolments e join classes c on c.id = e.class_id
          where e.student_id = s.id and e.term_id = ${term.id} and ${campusOf(ctx, "c")})`)
  ).rows;
  const [previous] = (
    await tx.execute<{ id: string; label: string }>(sql`
      select t.id, t.name || ', ' || y.name as label from terms t join academic_years y on y.id = t.academic_year_id
      where t.tenant_id = ${ctx.tenant.id} and t.starts_on < ${term.starts_on}
      order by t.starts_on desc limit 1`)
  ).rows;
  let retention: Movement["retention"] = null;
  if (previous) {
    const [r] = (
      await tx.execute<{ previous: number; returned: number }>(sql`
        select count(*)::int as previous,
          count(*) filter (where exists (
            select 1 from enrolments now where now.student_id = e.student_id and now.term_id = ${term.id}))::int as returned
        from enrolments e join classes c on c.id = e.class_id join students s on s.id = e.student_id
        where e.tenant_id = ${ctx.tenant.id} and e.term_id = ${previous.id} and ${campusOf(ctx, "c")}
          and s.status <> 'graduated'`)
    ).rows;
    retention = {
      previous: r?.previous ?? 0,
      returned: r?.returned ?? 0,
      rate: percent(r?.returned ?? 0, r?.previous ?? 0),
      previousTerm: previous.label,
    };
  }
  return {
    applications: apps?.applications ?? 0,
    admitted: apps?.admitted ?? 0,
    left: {
      withdrawn: left?.withdrawn ?? 0,
      transferred: left?.transferred ?? 0,
      graduated: left?.graduated ?? 0,
    },
    retention,
  };
}

/** Who joined and left in a term, and how many came back from the term before (CMD-03). Null for no such term. */
export async function getMovement(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<Movement | null> {
  assertAllowed(ctx, "students.view_all");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    return term ? readMovement(tx, ctx, term) : null;
  });
}

/**
 * Operational counts now (CMD-04), each only for a module the school has and a page the person may open (null
 * otherwise). These records have no campus, so the counts are only for people who see every campus.
 */
export async function getOperationsNow(database: Database, ctx: TenantContext): Promise<Operations | null> {
  if (ctx.campusIds !== null) return null;
  const today = todayIn(ctx.tenant.timezone);
  const t = ctx.tenant.id;
  const maintenance = allowed(ctx, "maintenance.manage") || allowed(ctx, "inventory.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const count = async (when: boolean, query: SQL) =>
      when ? ((await tx.execute<{ n: number }>(query)).rows[0]?.n ?? 0) : null;
    return {
      leaveWaiting: await count(
        allowed(ctx, "leave.approve"),
        sql`select count(*)::int as n from leave_requests where tenant_id = ${t} and status = 'pending'`,
      ),
      maintenanceOpen: await count(
        maintenance,
        sql`select count(*)::int as n from maintenance_requests where tenant_id = ${t} and status in ('open', 'in_progress')`,
      ),
      maintenanceUrgent: await count(
        maintenance,
        sql`select count(*)::int as n from maintenance_requests where tenant_id = ${t} and status in ('open', 'in_progress') and priority = 'urgent'`,
      ),
      purchasesWaiting: await count(
        allowed(ctx, "inventory.view"),
        sql`select count(*)::int as n from purchase_requests where tenant_id = ${t} and status = 'pending'`,
      ),
      exeatsOverdue: await count(
        allowed(ctx, "boarding.view"),
        sql`select count(*)::int as n from boarding_exeats where tenant_id = ${t} and back_at is null and expected_back_on < ${today}`,
      ),
      libraryOverdue: await count(
        allowed(ctx, "library.view"),
        sql`select count(*)::int as n from library_loans where tenant_id = ${t} and returned_at is null and lost_at is null and due_on < ${today}`,
      ),
      pickupsRefusedToday: await count(
        allowed(ctx, "pickup.view"),
        sql`select count(*)::int as n from pickups where tenant_id = ${t} and on_date = ${today} and outcome = 'refused' and cancelled_at is null`,
      ),
      visitorsOnSite: await count(
        allowed(ctx, "visitors.view"),
        sql`select count(*)::int as n from visitor_visits where tenant_id = ${t} and signed_out_at is null`,
      ),
    };
  });
}

/** May print the board summary: sees the school's money or every student. */
export const printsBoardSummary = (ctx: TenantContext) =>
  allowed(ctx, "fees.view") || allowed(ctx, "students.view_all");

export interface BoardSummary {
  term: { id: string; label: string; startsOn: string; endsOn: string };
  campus: { id: string; name: string } | null;
  money: { finance: TermFinance | null; owed: OwedToday; reconciliation: Reconciliation } | null;
  enrolment: { enrolment: Enrolment | null; movement: Movement } | null;
  /** Attendance and published report cards for the term, for academic leads. */
  results: TermPoint | null;
  /** Campuses side by side, for people who see every campus of a school with more than one. */
  comparison: { id: string; name: string; point: TermPoint | null }[] | null;
}

/**
 * The board summary of a term and, optionally, one campus (CMD-06): only the sections the person sees on the
 * Command Center, from the same services. Null when the term does not exist.
 */
export async function getBoardSummary(
  database: Database,
  ctx: TenantContext,
  input: { termId: string; campusId?: string | null },
): Promise<BoardSummary | null> {
  if (!printsBoardSummary(ctx)) throw new ForbiddenError("fees.view");
  const campusList = (await listCampuses(database, ctx)).filter((c) => c.status === "active");
  // CMD-05: the figures for one campus, with exactly the scope a member of that campus has (as the overview).
  const scoped = narrowToCampus(ctx, campusList.length > 1 ? input.campusId : null);
  const campus = scoped === ctx ? null : (campusList.find((c) => c.id === input.campusId) ?? null);
  const term = await withTenant(database, scopeOf(ctx), (tx) => loadTerm(tx, ctx.tenant.id, input.termId));
  if (!term) return null;
  const finance = allowed(scoped, "fees.view");
  const insights = allowed(scoped, "insights.view");
  const [termFinance, owed, reconciliation, enrolment, movement, results, comparison] = await Promise.all([
    finance ? getTermFinance(database, scoped, term.id) : null,
    finance ? getOwedToday(database, scoped) : null,
    finance ? readReconciliation(database, scoped) : null,
    allowed(scoped, "students.view_all") ? getEnrolment(database, scoped, term.id) : null,
    allowed(scoped, "students.view_all") ? getMovement(database, scoped, term.id) : null,
    insights && seesAcademics(scoped) ? getTermPoint(database, scoped, term.id) : null,
    campusList.length > 1 && ctx.campusIds === null && insights
      ? Promise.all(
          campusList.map(async (c) => ({
            id: c.id,
            name: c.name,
            point: await getTermPoint(database, narrowToCampus(ctx, c.id), term.id),
          })),
        )
      : null,
  ]);
  return {
    term: {
      id: term.id,
      label: `${term.name}, ${term.year}`,
      startsOn: term.starts_on,
      endsOn: term.ends_on,
    },
    campus: campus ? { id: campus.id, name: campus.name } : null,
    money: owed && reconciliation ? { finance: termFinance, owed, reconciliation } : null,
    enrolment: movement ? { enrolment, movement } : null,
    results,
    comparison,
  };
}

/** Records that the board summary was downloaded (CMD-06), with the term and campus it covered. */
export async function recordSummaryDownload(
  database: Database,
  ctx: TenantContext,
  summary: Pick<BoardSummary, "term" | "campus">,
): Promise<void> {
  if (!printsBoardSummary(ctx)) throw new ForbiddenError("fees.view");
  await withTenant(database, scopeOf(ctx), (tx) =>
    recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "command_center.summary_downloaded",
      entityType: "term",
      entityId: summary.term.id,
      metadata: { term: summary.term.label, campus: summary.campus?.name ?? null },
    }),
  );
}
