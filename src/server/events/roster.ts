import "server-only";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { Transaction } from "../db/client";
import {
  classes,
  enrolments,
  guardians,
  schoolHolidays,
  studentGuardians,
  students,
  terms,
} from "../db/schema";

/**
 * Who events and consent forms concern: each active student with this term's class, and each of their
 * guardians. A guardian stopped from using the parent view (portal_blocked_at) can still be recorded as
 * answering on paper, but never answers or is messaged through the parent view.
 */
export interface RosterRow {
  studentId: string;
  firstName: string;
  otherNames: string | null;
  lastName: string;
  admissionNumber: string;
  classId: string | null;
  className: string | null;
  levelId: string | null;
  campusId: string | null;
  guardianId: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  /** False: the guardian turned announcements off (no notices or reminders). */
  receivesMessages: boolean;
  portalBlocked: boolean;
}

export async function schoolRoster(
  tx: Transaction,
  tenantId: string,
  filter: { phone?: string; studentId?: string } = {},
): Promise<RosterRow[]> {
  const rows = await tx
    .select({
      studentId: students.id,
      firstName: students.firstName,
      otherNames: students.otherNames,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
      classId: classes.id,
      className: classes.name,
      levelId: classes.levelId,
      campusId: classes.campusId,
      guardianId: guardians.id,
      guardianName: guardians.fullName,
      guardianPhone: guardians.phone,
      receivesMessages: sql<boolean>`coalesce(${studentGuardians.receivesMessages}, false)`,
      portalBlocked: sql<boolean>`${guardians.portalBlockedAt} is not null`,
    })
    .from(students)
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, students.id),
        sql`${enrolments.termId} = (select id from ${terms} where ${terms.tenantId} = ${tenantId} and ${terms.isCurrent})`,
      ),
    )
    .leftJoin(classes, eq(classes.id, enrolments.classId))
    .leftJoin(studentGuardians, eq(studentGuardians.studentId, students.id))
    .leftJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(
      and(
        eq(students.tenantId, tenantId),
        eq(students.status, "active"),
        filter.phone ? eq(guardians.phone, filter.phone) : undefined,
        filter.studentId ? eq(students.id, filter.studentId) : undefined,
      ),
    )
    .orderBy(asc(classes.name), asc(students.firstName), asc(students.lastName));
  return rows;
}

export const fullName = (r: { firstName: string; otherNames: string | null; lastName: string }) =>
  [r.firstName, r.otherNames, r.lastName].filter(Boolean).join(" ");

/** Term dates and holidays from the school's academic calendar, as read-only calendar entries. */
export interface CalendarEntry {
  kind: "term_start" | "term_end" | "holiday";
  name: string;
  startsOn: string;
  endsOn: string;
}

export async function academicCalendar(
  tx: Transaction,
  tenantId: string,
  from: string,
  to: string,
): Promise<CalendarEntry[]> {
  const termRows = await tx
    .select({ name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), lte(terms.startsOn, to), gte(terms.endsOn, from)));
  const holidays = await tx
    .select({ name: schoolHolidays.name, startsOn: schoolHolidays.startsOn, endsOn: schoolHolidays.endsOn })
    .from(schoolHolidays)
    .where(
      and(
        eq(schoolHolidays.tenantId, tenantId),
        lte(schoolHolidays.startsOn, to),
        gte(schoolHolidays.endsOn, from),
      ),
    );
  const within = (d: string) => d >= from && d <= to;
  return [
    ...termRows.flatMap((t) => [
      ...(within(t.startsOn)
        ? [
            {
              kind: "term_start" as const,
              name: `${t.name} begins`,
              startsOn: t.startsOn,
              endsOn: t.startsOn,
            },
          ]
        : []),
      ...(within(t.endsOn)
        ? [{ kind: "term_end" as const, name: `${t.name} ends`, startsOn: t.endsOn, endsOn: t.endsOn }]
        : []),
    ]),
    ...holidays.map((h) => ({ kind: "holiday" as const, ...h })),
  ].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
}
