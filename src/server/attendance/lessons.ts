import "server-only";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ATTENDANCE_STATUSES,
  decideMark,
  isIsoDate,
  normaliseReason,
  REASON_MAX,
} from "../../lib/attendance";
import { isoWeekday } from "../../lib/timetable";
import { seesAllClasses } from "../assessment/access";
import { classStudents, type ClassStudent } from "../assessment/class-data";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  attendanceMarks,
  attendanceRegisters,
  classes,
  enrolments,
  lessonMarkChanges,
  lessonMarks,
  lessonRegisters,
  levels,
  memberships,
  students,
  subjects,
  timetableLessons,
  timetablePeriods,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";
import { fullName } from "../students/service";
import { myMembershipId } from "../timetable/service";
import {
  registerLock,
  syncRegister,
  termOn,
  type RegisterMark,
  type SyncConflict,
  type SyncResult,
  type TermOnDate,
} from "./registers";

/**
 * Lesson attendance (R2): a register for each timetabled lesson, when the school turns it on (Settings,
 * Attendance). The daily class register stays the school's attendance record (report cards, SMS, overview);
 * lesson registers show who was in each lesson, by subject, and who was at school but missed a lesson.
 *
 * The rules are the class register's: marks are versioned and a change applies only if made from the
 * current version, otherwise it comes back as a conflict for the person to decide (never last-write-wins);
 * every change is kept; the same date limits apply (today or earlier, in a term, not a holiday, teachers up
 * to 7 days back). Who may take one: the lesson's teacher, the class teacher, and academic staff.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const NONE = "00000000-0000-0000-0000-000000000000";

export async function lessonAttendanceEnabled(tx: Transaction, tenantId: string): Promise<boolean> {
  return (await readPreferences(tx, tenantId)).lessonAttendance;
}

export interface LessonRef {
  classId: string;
  className: string;
  levelName: string;
  periodId: string;
  periodName: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  subjectName: string;
  teacherMembershipId: string | null;
  teacherName: string | null;
}

/**
 * Conditions on lessons (timetable rows, or registers already taken) this member may take: every lesson
 * within campus scope for academic staff; otherwise lessons they teach or in classes they are class teacher of.
 */
async function reach(
  tx: Transaction,
  ctx: TenantContext,
  teacherColumn: typeof timetableLessons.membershipId | typeof lessonRegisters.teacherMembershipId,
): Promise<SQL[]> {
  const conditions: SQL[] = [];
  if (ctx.campusIds !== null)
    conditions.push(inArray(classes.campusId, ctx.campusIds.length ? ctx.campusIds : [NONE]));
  if (!seesAllClasses(ctx)) {
    const me = (await myMembershipId(tx, ctx)) ?? NONE;
    conditions.push(or(eq(teacherColumn, me), eq(classes.classTeacherMembershipId, me))!);
  }
  return conditions;
}

const teacher = users;

/** The timetabled lessons on a date that this member may take a register for. */
async function lessonsOn(
  tx: Transaction,
  ctx: TenantContext,
  term: TermOnDate,
  date: string,
  extra: SQL[] = [],
): Promise<LessonRef[]> {
  const rows = await tx
    .select({
      classId: classes.id,
      className: classes.name,
      levelName: levels.name,
      periodId: timetablePeriods.id,
      periodName: timetablePeriods.name,
      startsAt: timetablePeriods.startsAt,
      endsAt: timetablePeriods.endsAt,
      subjectId: subjects.id,
      subjectName: subjects.name,
      teacherMembershipId: timetableLessons.membershipId,
      teacherName: teacher.name,
      levelSequence: levels.sequence,
    })
    .from(timetableLessons)
    .innerJoin(classes, eq(classes.id, timetableLessons.classId))
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .innerJoin(timetablePeriods, eq(timetablePeriods.id, timetableLessons.periodId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(memberships, eq(memberships.id, timetableLessons.membershipId))
    .leftJoin(teacher, eq(teacher.id, memberships.userId))
    .where(
      and(
        eq(timetableLessons.tenantId, ctx.tenant.id),
        eq(timetableLessons.termId, term.id),
        eq(timetableLessons.weekday, isoWeekday(date)),
        eq(classes.status, "active"),
        ...(await reach(tx, ctx, timetableLessons.membershipId)),
        ...extra,
      ),
    )
    .orderBy(asc(timetablePeriods.startsAt), asc(levels.sequence), asc(classes.name));
  return rows.map(({ levelSequence: _s, ...r }) => r);
}

/** A register already taken for this class, date and period (it stands even if the timetable changed). */
async function registerFor(
  tx: Transaction,
  ctx: TenantContext,
  classId: string,
  date: string,
  periodId: string,
) {
  const [row] = await tx
    .select({
      id: lessonRegisters.id,
      classId: classes.id,
      className: classes.name,
      levelName: levels.name,
      periodId: timetablePeriods.id,
      periodName: timetablePeriods.name,
      startsAt: timetablePeriods.startsAt,
      endsAt: timetablePeriods.endsAt,
      subjectId: subjects.id,
      subjectName: subjects.name,
      teacherMembershipId: lessonRegisters.teacherMembershipId,
      teacherName: teacher.name,
      takenBy: sql<string | null>`(select name from users where id = ${lessonRegisters.takenByUserId})`,
    })
    .from(lessonRegisters)
    .innerJoin(classes, eq(classes.id, lessonRegisters.classId))
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .innerJoin(timetablePeriods, eq(timetablePeriods.id, lessonRegisters.periodId))
    .innerJoin(subjects, eq(subjects.id, lessonRegisters.subjectId))
    .leftJoin(memberships, eq(memberships.id, lessonRegisters.teacherMembershipId))
    .leftJoin(teacher, eq(teacher.id, memberships.userId))
    .where(
      and(
        eq(lessonRegisters.tenantId, ctx.tenant.id),
        eq(lessonRegisters.classId, classId),
        eq(lessonRegisters.date, date),
        eq(lessonRegisters.periodId, periodId),
        ...(await reach(tx, ctx, lessonRegisters.teacherMembershipId)),
      ),
    );
  return row ?? null;
}

/** The lesson a register is for: the register already taken, else the timetable's lesson on that day. */
async function loadLesson(
  tx: Transaction,
  ctx: TenantContext,
  classId: string,
  date: string,
  periodId: string,
): Promise<{
  lesson: LessonRef;
  registerId: string | null;
  takenBy: string | null;
  term: TermOnDate | null;
} | null> {
  if (!z.string().uuid().safeParse(classId).success || !z.string().uuid().safeParse(periodId).success)
    return null;
  const term = await termOn(tx, ctx.tenant.id, date);
  const existing = await registerFor(tx, ctx, classId, date, periodId);
  if (existing) {
    const { id, takenBy, ...lesson } = existing;
    return { lesson, registerId: id, takenBy, term };
  }
  if (!term) return null;
  const [lesson] = await lessonsOn(tx, ctx, term, date, [
    eq(timetableLessons.classId, classId),
    eq(timetableLessons.periodId, periodId),
  ]);
  return lesson ? { lesson, registerId: null, takenBy: null, term } : null;
}

export interface LessonSummary {
  lesson: LessonRef;
  students: number;
  register: { marked: number; absent: number; takenBy: string | null } | null;
}

export interface MissedLesson {
  studentId: string;
  name: string;
  className: string;
  /** Lessons marked absent although the student was present or late on the class register. */
  lessons: string[];
}

export interface LessonDay {
  date: string;
  enabled: boolean;
  term: TermOnDate | null;
  lock: string | null;
  lessons: LessonSummary[];
  /** For academic staff: students at school that day who were absent from a lesson. */
  missed: MissedLesson[] | null;
}

/** The lessons on a day that this member takes registers for, each with its register's state. */
export async function listLessonRegisters(
  database: Database,
  ctx: TenantContext,
  rawDate: string,
): Promise<LessonDay> {
  assertAllowed(ctx, "attendance.take");
  if (!isIsoDate(rawDate)) throw new DomainError("date_invalid", "Choose a valid date.", "date");
  const date = rawDate;
  return withTenant(database, scope(ctx), async (tx) => {
    const enabled = await lessonAttendanceEnabled(tx, ctx.tenant.id);
    const term = await termOn(tx, ctx.tenant.id, date);
    const lock = registerLock(ctx, date, term);
    if (!enabled || !term) return { date, enabled, term, lock, lessons: [], missed: null };
    const lessons = await lessonsOn(tx, ctx, term, date);
    const classIds = [...new Set(lessons.map((l) => l.classId))];
    const roster = classIds.length
      ? await tx
          .select({ classId: enrolments.classId, n: sql<number>`count(*)::int` })
          .from(enrolments)
          .where(
            and(
              eq(enrolments.tenantId, ctx.tenant.id),
              eq(enrolments.termId, term.id),
              inArray(enrolments.classId, classIds),
            ),
          )
          .groupBy(enrolments.classId)
      : [];
    const taken = classIds.length
      ? await tx
          .select({
            classId: lessonRegisters.classId,
            periodId: lessonRegisters.periodId,
            takenBy: users.name,
            marked: sql<number>`count(${lessonMarks.id})::int`,
            absent: sql<number>`count(${lessonMarks.id}) filter (where ${lessonMarks.status} in ('absent', 'excused'))::int`,
          })
          .from(lessonRegisters)
          .leftJoin(users, eq(users.id, lessonRegisters.takenByUserId))
          .leftJoin(lessonMarks, eq(lessonMarks.registerId, lessonRegisters.id))
          .where(
            and(
              eq(lessonRegisters.tenantId, ctx.tenant.id),
              eq(lessonRegisters.date, date),
              inArray(lessonRegisters.classId, classIds),
            ),
          )
          .groupBy(lessonRegisters.classId, lessonRegisters.periodId, users.name)
      : [];
    return {
      date,
      enabled,
      term,
      lock,
      lessons: lessons.map((lesson) => {
        const r = taken.find((t) => t.classId === lesson.classId && t.periodId === lesson.periodId);
        return {
          lesson,
          students: roster.find((x) => x.classId === lesson.classId)?.n ?? 0,
          register: r ? { marked: r.marked, absent: r.absent, takenBy: r.takenBy } : null,
        };
      }),
      missed: seesAllClasses(ctx) ? await missedLessons(tx, ctx, date) : null,
    };
  });
}

/** Students present or late on their class register who were marked absent from a lesson the same day. */
async function missedLessons(tx: Transaction, ctx: TenantContext, date: string): Promise<MissedLesson[]> {
  const conditions: SQL[] = [
    eq(lessonRegisters.tenantId, ctx.tenant.id),
    eq(lessonRegisters.date, date),
    eq(lessonMarks.status, "absent"),
    inArray(attendanceMarks.status, ["present", "late"]),
  ];
  if (ctx.campusIds !== null)
    conditions.push(inArray(classes.campusId, ctx.campusIds.length ? ctx.campusIds : [NONE]));
  const rows = await tx
    .select({
      studentId: students.id,
      firstName: students.firstName,
      otherNames: students.otherNames,
      lastName: students.lastName,
      className: classes.name,
      subject: subjects.name,
      period: timetablePeriods.name,
      startsAt: timetablePeriods.startsAt,
    })
    .from(lessonMarks)
    .innerJoin(lessonRegisters, eq(lessonRegisters.id, lessonMarks.registerId))
    .innerJoin(classes, eq(classes.id, lessonRegisters.classId))
    .innerJoin(subjects, eq(subjects.id, lessonRegisters.subjectId))
    .innerJoin(timetablePeriods, eq(timetablePeriods.id, lessonRegisters.periodId))
    .innerJoin(students, eq(students.id, lessonMarks.studentId))
    .innerJoin(
      attendanceRegisters,
      and(
        eq(attendanceRegisters.tenantId, lessonRegisters.tenantId),
        eq(attendanceRegisters.classId, lessonRegisters.classId),
        eq(attendanceRegisters.date, lessonRegisters.date),
      ),
    )
    .innerJoin(
      attendanceMarks,
      and(
        eq(attendanceMarks.registerId, attendanceRegisters.id),
        eq(attendanceMarks.studentId, lessonMarks.studentId),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(classes.name), asc(students.lastName), asc(timetablePeriods.startsAt));
  const byStudent = new Map<string, MissedLesson>();
  for (const r of rows) {
    const entry = byStudent.get(r.studentId) ?? {
      studentId: r.studentId,
      name: fullName(r),
      className: r.className,
      lessons: [],
    };
    entry.lessons.push(`${r.subject} (${r.period})`);
    byStudent.set(r.studentId, entry);
  }
  return [...byStudent.values()];
}

export interface LessonRegisterView {
  lesson: LessonRef;
  date: string;
  term: TermOnDate | null;
  lock: string | null;
  takenBy: string | null;
  students: (ClassStudent & { mark: RegisterMark | null })[];
  /** This term in this subject so far: lessons held, and each student's attended (present or late). */
  termSummary: { held: number; attended: Map<string, number> } | null;
}

async function readLessonMarks(tx: Transaction, tenantId: string, registerId: string) {
  return tx
    .select({
      id: lessonMarks.id,
      studentId: lessonMarks.studentId,
      status: lessonMarks.status,
      reason: lessonMarks.reason,
      version: lessonMarks.version,
      by: users.name,
      at: lessonMarks.updatedAt,
    })
    .from(lessonMarks)
    .leftJoin(users, eq(users.id, lessonMarks.recordedByUserId))
    .where(and(eq(lessonMarks.tenantId, tenantId), eq(lessonMarks.registerId, registerId)));
}

/** One lesson's register: every student in the class that term, with their mark if taken. */
export async function getLessonRegister(
  database: Database,
  ctx: TenantContext,
  classId: string,
  rawDate: string,
  periodId: string,
): Promise<LessonRegisterView | null> {
  assertAllowed(ctx, "attendance.take");
  if (!isIsoDate(rawDate)) return null;
  const date = rawDate;
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await lessonAttendanceEnabled(tx, ctx.tenant.id))) return null;
    const found = await loadLesson(tx, ctx, classId, date, periodId);
    if (!found) return null;
    const { lesson, registerId, takenBy, term } = found;
    const roster = term ? await classStudents(tx, ctx.tenant.id, term.id, lesson.classId) : [];
    const marks = registerId ? await readLessonMarks(tx, ctx.tenant.id, registerId) : [];
    const byStudent = new Map(marks.map((m) => [m.studentId, m]));
    let summary: LessonRegisterView["termSummary"] = null;
    if (term) {
      const held = await tx
        .select({ id: lessonRegisters.id })
        .from(lessonRegisters)
        .where(
          and(
            eq(lessonRegisters.tenantId, ctx.tenant.id),
            eq(lessonRegisters.termId, term.id),
            eq(lessonRegisters.classId, lesson.classId),
            eq(lessonRegisters.subjectId, lesson.subjectId),
          ),
        );
      const counts = held.length
        ? await tx
            .select({ studentId: lessonMarks.studentId, n: sql<number>`count(*)::int` })
            .from(lessonMarks)
            .where(
              and(
                eq(lessonMarks.tenantId, ctx.tenant.id),
                inArray(
                  lessonMarks.registerId,
                  held.map((h) => h.id),
                ),
                inArray(lessonMarks.status, ["present", "late"]),
              ),
            )
            .groupBy(lessonMarks.studentId)
        : [];
      summary = { held: held.length, attended: new Map(counts.map((c) => [c.studentId, c.n])) };
    }
    return {
      lesson,
      date,
      term,
      lock: registerLock(ctx, date, term),
      takenBy,
      students: roster.map((s) => {
        const m = byStudent.get(s.id);
        return {
          ...s,
          mark: m ? { status: m.status, reason: m.reason, version: m.version, by: m.by, at: m.at } : null,
        };
      }),
      termSummary: summary,
    };
  });
}

const syncSchema = z.object({
  classId: z.string().uuid(),
  periodId: z.string().uuid(),
  date: z.string(),
  source: z.enum(["online", "offline", "kept_mine"]),
  recordedAt: z.string().datetime().optional(),
  marks: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: z.enum(ATTENDANCE_STATUSES),
        reason: z
          .string()
          .max(REASON_MAX * 2)
          .nullable()
          .optional(),
        baseVersion: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(300),
});

/**
 * Saves marks on a lesson register, from the screen or replayed from a device that was offline, with the
 * class register's conflict rules. No SMS is sent for lesson absences.
 */
export async function syncLessonRegister(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<SyncResult> {
  assertAllowed(ctx, "attendance.take");
  const data = syncSchema.parse(input);
  if (!isIsoDate(data.date)) throw new DomainError("date_invalid", "Choose a valid date.", "date");
  const recordedAt = data.recordedAt ? new Date(data.recordedAt) : null;
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await lessonAttendanceEnabled(tx, ctx.tenant.id)))
      throw new DomainError("lesson_attendance_off", "This school does not take lesson registers.");
    const found = await loadLesson(tx, ctx, data.classId, data.date, data.periodId);
    if (!found) throw new DomainError("lesson_not_found", "There is no such lesson on this day.");
    const { lesson, term } = found;
    const lock = registerLock(ctx, data.date, term);
    if (lock || !term) throw new DomainError("register_locked", lock ?? "This date is not in a term.");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`lesson:${lesson.classId}:${data.date}:${lesson.periodId}`}))`,
    );
    const roster = new Map(
      (await classStudents(tx, ctx.tenant.id, term.id, lesson.classId)).map((s) => [s.id, s]),
    );
    let registerId = (await registerFor(tx, ctx, lesson.classId, data.date, lesson.periodId))?.id ?? null;
    if (!registerId) {
      const [created] = await tx
        .insert(lessonRegisters)
        .values({
          tenantId: ctx.tenant.id,
          classId: lesson.classId,
          termId: term.id,
          date: data.date,
          periodId: lesson.periodId,
          subjectId: lesson.subjectId,
          teacherMembershipId: lesson.teacherMembershipId,
          takenByUserId: ctx.userId,
        })
        .returning({ id: lessonRegisters.id });
      registerId = created!.id;
    }
    const current = new Map(
      (await readLessonMarks(tx, ctx.tenant.id, registerId)).map((m) => [m.studentId, m]),
    );
    const result: SyncResult = { applied: 0, unchanged: 0, conflicts: [], skipped: [], alerts: 0 };
    const now = new Date();
    for (const change of data.marks) {
      const student = roster.get(change.studentId);
      if (!student) {
        result.skipped.push(change.studentId);
        continue;
      }
      const reason = normaliseReason(change.status, change.reason);
      const existing = current.get(change.studentId) ?? null;
      const decision = decideMark(existing, {
        status: change.status,
        reason,
        baseVersion: change.baseVersion,
      });
      if (decision === "unchanged") {
        result.unchanged++;
        continue;
      }
      if (decision === "conflict") {
        const conflict: SyncConflict = {
          studentId: student.id,
          name: student.name,
          yours: { status: change.status, reason },
          theirs: {
            status: existing!.status,
            reason: existing!.reason,
            version: existing!.version,
            by: existing!.by,
            at: existing!.at,
          },
        };
        result.conflicts.push(conflict);
        continue;
      }
      let markId: string;
      let version: number;
      if (decision === "insert") {
        const [row] = await tx
          .insert(lessonMarks)
          .values({
            tenantId: ctx.tenant.id,
            registerId,
            studentId: student.id,
            status: change.status,
            reason,
            recordedByUserId: ctx.userId,
          })
          .returning({ id: lessonMarks.id, version: lessonMarks.version });
        markId = row!.id;
        version = row!.version;
      } else {
        version = existing!.version + 1;
        markId = existing!.id;
        await tx
          .update(lessonMarks)
          .set({ status: change.status, reason, version, recordedByUserId: ctx.userId, updatedAt: now })
          .where(eq(lessonMarks.id, existing!.id));
      }
      await tx.insert(lessonMarkChanges).values({
        tenantId: ctx.tenant.id,
        markId,
        studentId: student.id,
        fromStatus: existing?.status ?? null,
        toStatus: change.status,
        fromReason: existing?.reason ?? null,
        toReason: reason,
        version,
        source: data.source,
        recordedOnDeviceAt: data.source === "online" ? null : recordedAt,
        changedByUserId: ctx.userId,
      });
      result.applied++;
    }
    if (result.applied) {
      await tx
        .update(lessonRegisters)
        .set({ takenByUserId: ctx.userId, updatedAt: now })
        .where(eq(lessonRegisters.id, registerId));
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "attendance.lesson_register_saved",
        entityType: "class",
        entityId: lesson.classId,
        metadata: {
          class: lesson.className,
          subject: lesson.subjectName,
          period: lesson.periodName,
          date: data.date,
          marks: result.applied,
          conflicts: result.conflicts.length,
          source: data.source,
        },
      });
    }
    return result;
  });
}

/** A class register or a lesson register (when the payload names a period), from the screen or a device. */
export async function syncAnyRegister(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<SyncResult> {
  const isLesson =
    typeof input === "object" &&
    input !== null &&
    typeof (input as { periodId?: unknown }).periodId === "string";
  return isLesson ? syncLessonRegister(database, ctx, input) : syncRegister(database, ctx, input);
}
