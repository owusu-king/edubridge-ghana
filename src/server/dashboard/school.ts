import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { attendanceRate, NO_ATTENDANCE, type AttendanceTotals } from "../../lib/attendance";
import { holidayOn } from "../academics/holidays";
import { listAssessableClasses, loadTerm, seesAllClasses, type TermRef } from "../assessment/access";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import {
  attendanceMarks,
  attendanceRegisters,
  campuses,
  classes,
  enrolments,
  levels,
  students,
} from "../db/schema";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";

/**
 * Enrolment and attendance figures for the school overview, from enrolment records and registers.
 * Campus scope applies: staff limited to some campuses see only those campuses' classes.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});
const NONE = "00000000-0000-0000-0000-000000000000";
const campusCondition = (ctx: TenantContext) =>
  ctx.campusIds === null
    ? undefined
    : inArray(classes.campusId, ctx.campusIds.length ? ctx.campusIds : [NONE]);

export interface Enrolment {
  campuses: { id: string; name: string }[];
  levels: { id: string; name: string; byCampus: Record<string, number>; total: number }[];
  total: number;
  female: number;
  male: number;
}

/**
 * Students placed in classes for a term, by level and campus. For the current term only active students
 * count (as for billing); for past terms, everyone who was placed.
 */
export async function getEnrolment(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<Enrolment | null> {
  assertAllowed(ctx, "students.view_all");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    if (!term) return null;
    const rows = await tx
      .select({
        levelId: levels.id,
        levelName: levels.name,
        sequence: levels.sequence,
        campusId: campuses.id,
        campusName: campuses.name,
        sex: students.sex,
        n: sql<number>`count(*)::int`,
      })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .innerJoin(campuses, eq(campuses.id, classes.campusId))
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.termId, term.id),
          term.isCurrent ? eq(students.status, "active") : undefined,
          campusCondition(ctx),
        ),
      )
      .groupBy(levels.id, levels.name, levels.sequence, campuses.id, campuses.name, students.sex)
      .orderBy(asc(levels.sequence), asc(campuses.name));
    const campusList = [
      ...new Map(rows.map((r) => [r.campusId, { id: r.campusId, name: r.campusName }])).values(),
    ];
    const levelIds = [...new Set(rows.map((r) => r.levelId))];
    return {
      campuses: campusList.sort((a, b) => a.name.localeCompare(b.name)),
      levels: levelIds.map((id) => {
        const of = rows.filter((r) => r.levelId === id);
        const byCampus: Record<string, number> = {};
        for (const r of of) byCampus[r.campusId] = (byCampus[r.campusId] ?? 0) + r.n;
        return { id, name: of[0]!.levelName, byCampus, total: of.reduce((n, r) => n + r.n, 0) };
      }),
      total: rows.reduce((n, r) => n + r.n, 0),
      female: rows.filter((r) => r.sex === "female").reduce((n, r) => n + r.n, 0),
      male: rows.filter((r) => r.sex === "male").reduce((n, r) => n + r.n, 0),
    };
  });
}

export interface ClassAttendanceSummary {
  id: string;
  name: string;
  campusName: string;
  students: number;
  /** School days with a register for this class. */
  registers: number;
  totals: AttendanceTotals;
  rate: number | null;
}

export interface AttendanceConcern {
  id: string;
  name: string;
  className: string;
  classId: string;
  totals: AttendanceTotals;
  rate: number;
}

export interface AttendanceOverview {
  term: TermRef;
  classes: ClassAttendanceSummary[];
  totals: AttendanceTotals;
  rate: number | null;
  /** Today's registers, when today is in the term. */
  today: { date: string; taken: number; classes: number } | null;
  /** Students below the attendance threshold, lowest first (at most 10 listed). */
  concerns: AttendanceConcern[];
  concernCount: number;
  /** The school's follow-up rule: below this attendance, once on this many registers. */
  concernPercent: number;
  concernMinDays: number;
}

/** A term's attendance across the classes this member oversees. Academic leads only. */
export async function getAttendanceOverview(
  database: Database,
  ctx: TenantContext,
  termId: string,
  today: string,
): Promise<AttendanceOverview | null> {
  if (!allowed(ctx, "attendance.take") || !seesAllClasses(ctx)) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    if (!term) return null;
    const prefs = await readPreferences(tx, ctx.tenant.id);
    const all = await listAssessableClasses(tx, ctx, "attendance.take");
    const classIds = all.map((c) => c.id);
    if (classIds.length === 0)
      return {
        term,
        classes: [],
        totals: { ...NO_ATTENDANCE },
        rate: null,
        today: null,
        concerns: [],
        concernCount: 0,
        concernPercent: prefs.attendanceConcernPercent,
        concernMinDays: prefs.attendanceConcernMinDays,
      };

    const roster = await tx
      .select({
        studentId: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        classId: enrolments.classId,
      })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.termId, term.id),
          inArray(enrolments.classId, classIds),
        ),
      );
    const marks = await tx
      .select({
        classId: attendanceRegisters.classId,
        studentId: attendanceMarks.studentId,
        status: attendanceMarks.status,
        n: sql<number>`count(*)::int`,
      })
      .from(attendanceMarks)
      .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
      .where(
        and(
          eq(attendanceMarks.tenantId, ctx.tenant.id),
          eq(attendanceRegisters.termId, term.id),
          inArray(attendanceRegisters.classId, classIds),
        ),
      )
      .groupBy(attendanceRegisters.classId, attendanceMarks.studentId, attendanceMarks.status);
    const registers = await tx
      .select({
        classId: attendanceRegisters.classId,
        n: sql<number>`count(*)::int`,
        today: sql<number>`count(*) filter (where ${attendanceRegisters.date} = ${today})::int`,
      })
      .from(attendanceRegisters)
      .where(
        and(
          eq(attendanceRegisters.tenantId, ctx.tenant.id),
          eq(attendanceRegisters.termId, term.id),
          inArray(attendanceRegisters.classId, classIds),
        ),
      )
      .groupBy(attendanceRegisters.classId);

    const add = (t: AttendanceTotals, status: keyof Omit<AttendanceTotals, "open">, n: number) => {
      t[status] += n;
      t.open += n;
    };
    const overall = { ...NO_ATTENDANCE };
    const perStudent = new Map<string, AttendanceTotals>();
    const perClass = new Map<string, AttendanceTotals>();
    for (const m of marks) {
      add(overall, m.status, m.n);
      const s = perStudent.get(m.studentId) ?? { ...NO_ATTENDANCE };
      add(s, m.status, m.n);
      perStudent.set(m.studentId, s);
      const c = perClass.get(m.classId) ?? { ...NO_ATTENDANCE };
      add(c, m.status, m.n);
      perClass.set(m.classId, c);
    }

    const shown = all.filter((c) => c.status === "active" || roster.some((r) => r.classId === c.id));
    const className = new Map(all.map((c) => [c.id, c.name]));
    const concerns = roster
      .map((r) => ({ r, totals: perStudent.get(r.studentId) }))
      .filter((x): x is { r: (typeof roster)[number]; totals: AttendanceTotals } =>
        Boolean(x.totals && x.totals.open >= prefs.attendanceConcernMinDays),
      )
      .map(({ r, totals }) => ({
        id: r.studentId,
        name: `${r.firstName} ${r.lastName}`,
        classId: r.classId,
        className: className.get(r.classId) ?? "",
        totals,
        rate: attendanceRate(totals)!,
      }))
      .filter((c) => c.rate < prefs.attendanceConcernPercent)
      .sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name));
    // Today's registers only count on a school day: in the term and not a holiday.
    const inTerm =
      today >= term.startsOn && today <= term.endsOn && !(await holidayOn(tx, ctx.tenant.id, today));
    const activeClasses = shown.filter((c) => c.status === "active");
    return {
      term,
      classes: shown.map((c) => {
        const totals = perClass.get(c.id) ?? { ...NO_ATTENDANCE };
        return {
          id: c.id,
          name: c.name,
          campusName: c.campusName,
          students: roster.filter((r) => r.classId === c.id).length,
          registers: registers.find((r) => r.classId === c.id)?.n ?? 0,
          totals,
          rate: attendanceRate(totals),
        };
      }),
      totals: overall,
      rate: attendanceRate(overall),
      today: inTerm
        ? {
            date: today,
            taken: activeClasses.filter((c) => (registers.find((r) => r.classId === c.id)?.today ?? 0) > 0)
              .length,
            classes: activeClasses.length,
          }
        : null,
      concerns: concerns.slice(0, 10),
      concernCount: concerns.length,
      concernPercent: prefs.attendanceConcernPercent,
      concernMinDays: prefs.attendanceConcernMinDays,
    };
  });
}
