import "server-only";
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  isSchoolWeekday,
  normaliseTime,
  overlappingPeriod,
  sortPeriods,
  WEEKDAY_NAMES,
} from "../../lib/timetable";
import { seesAllClasses } from "../assessment/access";
import { readTeachingModel } from "../assessment/teaching";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  campuses,
  classes,
  lessonRegisters,
  levels,
  levelSubjects,
  memberships,
  subjects,
  subjectTeachers,
  terms,
  timetableLessons,
  timetablePeriods,
  users,
} from "../db/schema";
import { DomainError, pgConstraint, pgErrorCode, PG_UNIQUE_VIOLATION } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Timetables (R2): the school day's periods, and each class's lessons per term (weekday, period, subject,
 * teacher). Academic staff plan them; teachers see their own lessons and their classes' timetables. A
 * teacher is never in two classes at once (checked here with a clear message, and by a unique index).
 * Lesson attendance (src/server/attendance/lessons.ts) is taken from these lessons.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const NONE = "00000000-0000-0000-0000-000000000000";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const TEACHING_ROLES = ["owner", "headteacher", "admin", "teacher"];

export interface Period {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  kind: "lesson" | "break";
}

export interface TimetableClass {
  id: string;
  name: string;
  levelId: string;
  levelName: string;
  campusName: string;
}

export interface Lesson {
  id: string;
  classId: string;
  className: string;
  weekday: number;
  periodId: string;
  subjectId: string;
  subjectName: string;
  membershipId: string | null;
  teacherName: string | null;
}

export async function readPeriods(tx: Transaction, tenantId: string): Promise<Period[]> {
  const rows = await tx
    .select({
      id: timetablePeriods.id,
      name: timetablePeriods.name,
      startsAt: timetablePeriods.startsAt,
      endsAt: timetablePeriods.endsAt,
      kind: timetablePeriods.kind,
    })
    .from(timetablePeriods)
    .where(eq(timetablePeriods.tenantId, tenantId));
  return sortPeriods(rows);
}

export async function myMembershipId(tx: Transaction, ctx: TenantContext): Promise<string | null> {
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
  return row?.id ?? null;
}

function campusCondition(ctx: TenantContext): SQL | null {
  return ctx.campusIds === null
    ? null
    : inArray(classes.campusId, ctx.campusIds.length ? ctx.campusIds : [NONE]);
}

/** Active classes whose timetable this member sees: all (within campus scope) for academic staff, else their own. */
async function reachableClasses(tx: Transaction, ctx: TenantContext): Promise<TimetableClass[]> {
  const conditions: SQL[] = [eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")];
  const campus = campusCondition(ctx);
  if (campus) conditions.push(campus);
  if (!seesAllClasses(ctx))
    conditions.push(eq(classes.classTeacherMembershipId, (await myMembershipId(tx, ctx)) ?? NONE));
  return tx
    .select({
      id: classes.id,
      name: classes.name,
      levelId: classes.levelId,
      levelName: levels.name,
      campusName: campuses.name,
    })
    .from(classes)
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .innerJoin(campuses, eq(campuses.id, classes.campusId))
    .where(and(...conditions))
    .orderBy(asc(levels.sequence), asc(classes.name));
}

const lessonColumns = {
  id: timetableLessons.id,
  classId: timetableLessons.classId,
  className: classes.name,
  weekday: timetableLessons.weekday,
  periodId: timetableLessons.periodId,
  subjectId: timetableLessons.subjectId,
  subjectName: subjects.name,
  membershipId: timetableLessons.membershipId,
  teacherName: users.name,
};

/** Lessons matching the conditions (always within the school), with class, subject and teacher names. */
export async function readLessons(
  tx: Transaction,
  tenantId: string,
  ...conditions: SQL[]
): Promise<Lesson[]> {
  return tx
    .select(lessonColumns)
    .from(timetableLessons)
    .innerJoin(classes, eq(classes.id, timetableLessons.classId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(memberships, eq(memberships.id, timetableLessons.membershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(timetableLessons.tenantId, tenantId), ...conditions));
}

async function loadTermRef(tx: Transaction, tenantId: string, termId: string) {
  if (!z.string().uuid().safeParse(termId).success) return null;
  const [row] = await tx
    .select({ id: terms.id, name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.id, termId)));
  return row ?? null;
}

// ——— The school day ———

export async function listPeriods(database: Database, ctx: TenantContext): Promise<Period[]> {
  assertAllowed(ctx, "timetable.view");
  return withTenant(database, scope(ctx), (tx) => readPeriods(tx, ctx.tenant.id));
}

const periodSchema = z.object({
  id: z.string().uuid().optional(),
  name: z
    .string()
    .trim()
    .min(1, "Give the period a name, such as Period 1 or Break.")
    .max(40, "Use 40 characters or fewer."),
  startsAt: z.string().transform((v, c) => {
    const t = normaliseTime(v);
    if (!t) c.addIssue({ code: "custom", message: "Enter a start time such as 08:00." });
    return t ?? "";
  }),
  endsAt: z.string().transform((v, c) => {
    const t = normaliseTime(v);
    if (!t) c.addIssue({ code: "custom", message: "Enter an end time such as 08:40." });
    return t ?? "";
  }),
  kind: z.enum(["lesson", "break"], { message: "Choose lesson or break." }),
});

/** Adds a period to the school day, or changes one. Periods may not overlap. */
export async function savePeriod(database: Database, ctx: TenantContext, input: unknown): Promise<Period> {
  assertAllowed(ctx, "academics.manage");
  const data = periodSchema.parse(input);
  if (data.endsAt <= data.startsAt)
    throw new DomainError("period_times", "The period must end after it starts.", "endsAt");
  return withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`periods:${ctx.tenant.id}`}))`);
    const existing = await readPeriods(tx, ctx.tenant.id);
    const before = data.id ? existing.find((p) => p.id === data.id) : undefined;
    if (data.id && !before) throw new DomainError("period_not_found", "Period not found.");
    const clash = overlappingPeriod({ ...data, id: data.id }, existing);
    if (clash)
      throw new DomainError(
        "period_overlap",
        `This overlaps ${clash.name} (${clash.startsAt}–${clash.endsAt}).`,
        "startsAt",
      );
    if (before && before.kind === "lesson" && data.kind === "break") {
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(timetableLessons)
        .where(and(eq(timetableLessons.tenantId, ctx.tenant.id), eq(timetableLessons.periodId, before.id)));
      if (used && used.n > 0)
        throw new DomainError(
          "period_in_use",
          `${before.name} has ${used.n} ${used.n === 1 ? "lesson" : "lessons"} on timetables. Clear them before making it a break.`,
          "kind",
        );
    }
    let saved: Period | undefined;
    try {
      const values = { name: data.name, startsAt: data.startsAt, endsAt: data.endsAt, kind: data.kind };
      [saved] = before
        ? await tx
            .update(timetablePeriods)
            .set({ ...values, updatedAt: new Date() })
            .where(and(eq(timetablePeriods.tenantId, ctx.tenant.id), eq(timetablePeriods.id, before.id)))
            .returning()
        : await tx
            .insert(timetablePeriods)
            .values({ tenantId: ctx.tenant.id, ...values })
            .returning();
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new DomainError("period_name_taken", `There is already a period called ${data.name}.`, "name");
      throw error;
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: before ? "timetable.period_changed" : "timetable.period_added",
      entityType: "timetable_period",
      entityId: saved!.id,
      metadata: { name: data.name, startsAt: data.startsAt, endsAt: data.endsAt, kind: data.kind },
    });
    return {
      id: saved!.id,
      name: saved!.name,
      startsAt: saved!.startsAt,
      endsAt: saved!.endsAt,
      kind: saved!.kind,
    };
  });
}

/**
 * Removes a period and the timetabled lessons in it. A period that lesson registers were taken in stays
 * (those registers refer to it); its times and name can still be changed.
 */
export async function removePeriod(database: Database, ctx: TenantContext, periodId: string): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  if (!z.string().uuid().safeParse(periodId).success)
    throw new DomainError("period_not_found", "Period not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(lessonRegisters)
      .where(and(eq(lessonRegisters.tenantId, ctx.tenant.id), eq(lessonRegisters.periodId, periodId)));
    if (used && used.n > 0)
      throw new DomainError(
        "period_has_registers",
        "Lesson registers were taken in this period, so it stays. Change its name or times instead.",
      );
    let removed;
    try {
      [removed] = await tx
        .delete(timetablePeriods)
        .where(and(eq(timetablePeriods.tenantId, ctx.tenant.id), eq(timetablePeriods.id, periodId)))
        .returning();
    } catch (error) {
      if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION)
        throw new DomainError(
          "period_has_registers",
          "Lesson registers were taken in this period, so it stays. Change its name or times instead.",
        );
      throw error;
    }
    if (!removed) throw new DomainError("period_not_found", "Period not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "timetable.period_removed",
      entityType: "timetable_period",
      entityId: removed.id,
      metadata: { name: removed.name, startsAt: removed.startsAt, endsAt: removed.endsAt },
    });
  });
}

// ——— Timetables ———

export interface TimetableOverview {
  term: { id: string; name: string };
  periods: Period[];
  classes: (TimetableClass & { lessons: number })[];
  /** How many lessons the member teaches this term. */
  myLessons: number;
  canManage: boolean;
}

/** The classes whose timetable the member sees for a term, with how many lessons each has. */
export async function getTimetableOverview(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<TimetableOverview | null> {
  assertAllowed(ctx, "timetable.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTermRef(tx, ctx.tenant.id, termId);
    if (!term) return null;
    const list = await reachableClasses(tx, ctx);
    const counts = list.length
      ? await tx
          .select({ classId: timetableLessons.classId, n: sql<number>`count(*)::int` })
          .from(timetableLessons)
          .where(
            and(
              eq(timetableLessons.tenantId, ctx.tenant.id),
              eq(timetableLessons.termId, term.id),
              inArray(
                timetableLessons.classId,
                list.map((c) => c.id),
              ),
            ),
          )
          .groupBy(timetableLessons.classId)
      : [];
    const me = await myMembershipId(tx, ctx);
    const [mine] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(timetableLessons)
      .where(
        and(
          eq(timetableLessons.tenantId, ctx.tenant.id),
          eq(timetableLessons.termId, term.id),
          eq(timetableLessons.membershipId, me ?? NONE),
        ),
      );
    return {
      term: { id: term.id, name: term.name },
      periods: await readPeriods(tx, ctx.tenant.id),
      classes: list.map((c) => ({ ...c, lessons: counts.find((r) => r.classId === c.id)?.n ?? 0 })),
      myLessons: mine?.n ?? 0,
      canManage: allowed(ctx, "academics.manage"),
    };
  });
}

export interface ClassTimetable {
  term: { id: string; name: string };
  cls: TimetableClass;
  periods: Period[];
  lessons: Lesson[];
  canManage: boolean;
  /** For planning (academic staff only): the subjects the class's level takes, and who could teach. */
  options: {
    subjects: { id: string; name: string; suggestedTeacher: string | null }[];
    teachers: { membershipId: string; name: string }[];
  } | null;
}

/** Subjects a level takes, with the teacher who usually teaches each in this class (subject or class teacher). */
async function subjectOptions(tx: Transaction, tenantId: string, cls: { id: string; levelId: string }) {
  const rows = await tx
    .select({ id: subjects.id, name: subjects.name })
    .from(levelSubjects)
    .innerJoin(subjects, eq(subjects.id, levelSubjects.subjectId))
    .where(
      and(
        eq(levelSubjects.tenantId, tenantId),
        eq(levelSubjects.levelId, cls.levelId),
        eq(subjects.status, "active"),
      ),
    )
    .orderBy(asc(levelSubjects.sequence), asc(subjects.name));
  const [classRow] = await tx
    .select({ teacher: classes.classTeacherMembershipId })
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), eq(classes.id, cls.id)));
  const assigned =
    (await readTeachingModel(tx, tenantId)) === "subject"
      ? await tx
          .select({ subjectId: subjectTeachers.subjectId, membershipId: subjectTeachers.membershipId })
          .from(subjectTeachers)
          .where(and(eq(subjectTeachers.tenantId, tenantId), eq(subjectTeachers.classId, cls.id)))
      : [];
  return rows.map((s) => ({
    ...s,
    suggestedTeacher: assigned.find((a) => a.subjectId === s.id)?.membershipId ?? classRow?.teacher ?? null,
  }));
}

async function teacherOptions(tx: Transaction, tenantId: string) {
  return tx
    .select({ membershipId: memberships.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        sql`${memberships.roles} && ${sql.raw(`ARRAY['${TEACHING_ROLES.join("','")}']`)}::text[]`,
      ),
    )
    .orderBy(asc(users.name));
}

/** One class's timetable for a term (and, for academic staff, what can be planned in it). */
export async function getClassTimetable(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
): Promise<ClassTimetable | null> {
  assertAllowed(ctx, "timetable.view");
  if (!z.string().uuid().safeParse(classId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTermRef(tx, ctx.tenant.id, termId);
    const cls = (await reachableClasses(tx, ctx)).find((c) => c.id === classId);
    if (!term || !cls) return null;
    const canManage = allowed(ctx, "academics.manage");
    return {
      term: { id: term.id, name: term.name },
      cls,
      periods: await readPeriods(tx, ctx.tenant.id),
      lessons: await readLessons(
        tx,
        ctx.tenant.id,
        eq(timetableLessons.termId, term.id),
        eq(timetableLessons.classId, cls.id),
      ),
      canManage,
      options: canManage
        ? {
            subjects: await subjectOptions(tx, ctx.tenant.id, cls),
            teachers: await teacherOptions(tx, ctx.tenant.id),
          }
        : null,
    };
  });
}

export interface TeacherTimetable {
  term: { id: string; name: string };
  teacher: { membershipId: string; name: string };
  /** Whether it is the member's own timetable. */
  own: boolean;
  periods: Period[];
  lessons: Lesson[];
  /** Other teachers whose timetable this member may open (academic staff), for choosing. */
  teachers: { membershipId: string; name: string }[];
}

/** A teacher's lessons for a term: the member's own, or (academic staff) any teacher's. */
export async function getTeacherTimetable(
  database: Database,
  ctx: TenantContext,
  termId: string,
  membershipId?: string,
): Promise<TeacherTimetable | null> {
  assertAllowed(ctx, "timetable.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTermRef(tx, ctx.tenant.id, termId);
    if (!term) return null;
    const me = await myMembershipId(tx, ctx);
    const all = seesAllClasses(ctx);
    const wanted = membershipId && all ? membershipId : me;
    if (!wanted || !z.string().uuid().safeParse(wanted).success) return null;
    const teachers = await teacherOptions(tx, ctx.tenant.id);
    const [person] = await tx
      .select({ membershipId: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, wanted)));
    if (!person) return null;
    const conditions: SQL[] = [
      eq(timetableLessons.termId, term.id),
      eq(timetableLessons.membershipId, wanted),
    ];
    const campus = campusCondition(ctx);
    if (campus && all) conditions.push(campus);
    return {
      term: { id: term.id, name: term.name },
      teacher: person,
      own: wanted === me,
      periods: await readPeriods(tx, ctx.tenant.id),
      lessons: await readLessons(tx, ctx.tenant.id, ...conditions),
      teachers: all ? teachers : [],
    };
  });
}

const slotSchema = z.object({
  termId: z.string().uuid(),
  classId: z.string().uuid(),
  weekday: z.coerce.number().int(),
  periodId: z.string().uuid({ message: "Choose a period." }),
});

const lessonSchema = slotSchema.extend({
  subjectId: z.string().uuid({ message: "Choose a subject." }),
  membershipId: z
    .string()
    .transform((v) => (v ? v : null))
    .pipe(z.string().uuid({ message: "Choose a teacher." }).nullable())
    .optional(),
});

async function loadSlot(tx: Transaction, ctx: TenantContext, data: z.infer<typeof slotSchema>) {
  if (!isSchoolWeekday(data.weekday))
    throw new DomainError("weekday_invalid", "Choose a school day from Monday to Friday.", "weekday");
  const term = await loadTermRef(tx, ctx.tenant.id, data.termId);
  if (!term) throw new DomainError("term_not_found", "Term not found.");
  const cls = (await reachableClasses(tx, ctx)).find((c) => c.id === data.classId);
  if (!cls) throw new DomainError("class_not_found", "Class not found.");
  const period = (await readPeriods(tx, ctx.tenant.id)).find((p) => p.id === data.periodId);
  if (!period) throw new DomainError("period_not_found", "Period not found.", "periodId");
  if (period.kind !== "lesson")
    throw new DomainError("period_is_break", `${period.name} is a break, not a lesson.`, "periodId");
  return { term, cls, period };
}

/**
 * Puts a lesson on a class's timetable (or changes the one there): the subject must be one the class's level
 * takes, and the teacher must not already be teaching another class at that time.
 */
export async function setLesson(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const data = lessonSchema.parse(input);
  const membershipId = data.membershipId ?? null;
  await withTenant(database, scope(ctx), async (tx) => {
    const { term, cls, period } = await loadSlot(tx, ctx, data);
    const subject = (await subjectOptions(tx, ctx.tenant.id, cls)).find((s) => s.id === data.subjectId);
    if (!subject)
      throw new DomainError("subject_not_taken", `${cls.levelName} does not take that subject.`, "subjectId");
    let teacherName: string | null = null;
    if (membershipId) {
      const teacher = (await teacherOptions(tx, ctx.tenant.id)).find((t) => t.membershipId === membershipId);
      if (!teacher)
        throw new DomainError(
          "teacher_invalid",
          "Choose an active member of teaching staff.",
          "membershipId",
        );
      teacherName = teacher.name;
      const [busy] = await readLessons(
        tx,
        ctx.tenant.id,
        eq(timetableLessons.termId, term.id),
        eq(timetableLessons.membershipId, membershipId),
        eq(timetableLessons.weekday, data.weekday),
        eq(timetableLessons.periodId, period.id),
      );
      if (busy && busy.classId !== cls.id)
        throw new DomainError(
          "teacher_busy",
          `${teacher.name} already teaches ${busy.subjectName} in ${busy.className} on ${WEEKDAY_NAMES[data.weekday]}, ${period.name}.`,
          "membershipId",
        );
    }
    try {
      await tx
        .insert(timetableLessons)
        .values({
          tenantId: ctx.tenant.id,
          termId: term.id,
          classId: cls.id,
          weekday: data.weekday,
          periodId: period.id,
          subjectId: subject.id,
          membershipId,
          updatedByUserId: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [
            timetableLessons.tenantId,
            timetableLessons.termId,
            timetableLessons.classId,
            timetableLessons.weekday,
            timetableLessons.periodId,
          ],
          set: { subjectId: subject.id, membershipId, updatedByUserId: ctx.userId, updatedAt: new Date() },
        });
    } catch (error) {
      // Two people placing the same teacher at once: the index decides, and the message stays the same.
      if (pgConstraint(error) === "timetable_lessons_teacher_slot_unique")
        throw new DomainError(
          "teacher_busy",
          `${teacherName ?? "This teacher"} already teaches another class on ${WEEKDAY_NAMES[data.weekday]}, ${period.name}.`,
          "membershipId",
        );
      throw error;
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "timetable.lesson_set",
      entityType: "class",
      entityId: cls.id,
      metadata: {
        term: term.name,
        class: cls.name,
        day: WEEKDAY_NAMES[data.weekday],
        period: period.name,
        subject: subject.name,
        teacher: teacherName,
      },
    });
  });
}

/** Takes a lesson off a class's timetable (registers already taken in it stay). */
export async function clearLesson(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const data = slotSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const { term, cls, period } = await loadSlot(tx, ctx, data);
    const [removed] = await tx
      .delete(timetableLessons)
      .where(
        and(
          eq(timetableLessons.tenantId, ctx.tenant.id),
          eq(timetableLessons.termId, term.id),
          eq(timetableLessons.classId, cls.id),
          eq(timetableLessons.weekday, data.weekday),
          eq(timetableLessons.periodId, period.id),
        ),
      )
      .returning();
    if (!removed) return;
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "timetable.lesson_cleared",
      entityType: "class",
      entityId: cls.id,
      metadata: { term: term.name, class: cls.name, day: WEEKDAY_NAMES[data.weekday], period: period.name },
    });
  });
}

/**
 * Copies every class's lessons from one term into another. Classes that already have lessons in the new
 * term are left as they are (nothing is overwritten), and so are lessons whose teacher would clash.
 */
export async function copyTimetable(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ classes: number; lessons: number; skipped: number }> {
  assertAllowed(ctx, "academics.manage");
  const data = z
    .object({ fromTermId: z.string().uuid("Choose a term to copy from."), toTermId: z.string().uuid() })
    .parse(input);
  if (data.fromTermId === data.toTermId)
    throw new DomainError("same_term", "Choose a different term to copy from.", "fromTermId");
  return withTenant(database, scope(ctx), async (tx) => {
    const from = await loadTermRef(tx, ctx.tenant.id, data.fromTermId);
    const to = await loadTermRef(tx, ctx.tenant.id, data.toTermId);
    if (!from || !to) throw new DomainError("term_not_found", "Term not found.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`timetable:${ctx.tenant.id}:${to.id}`}))`);
    const reach = new Set((await reachableClasses(tx, ctx)).map((c) => c.id));
    const source = (
      await tx
        .select()
        .from(timetableLessons)
        .where(and(eq(timetableLessons.tenantId, ctx.tenant.id), eq(timetableLessons.termId, from.id)))
    ).filter((l) => reach.has(l.classId));
    const target = await tx
      .select({
        classId: timetableLessons.classId,
        membershipId: timetableLessons.membershipId,
        weekday: timetableLessons.weekday,
        periodId: timetableLessons.periodId,
      })
      .from(timetableLessons)
      .where(and(eq(timetableLessons.tenantId, ctx.tenant.id), eq(timetableLessons.termId, to.id)));
    const planned = new Set(target.map((l) => l.classId));
    const busy = new Set(
      target.filter((l) => l.membershipId).map((l) => `${l.membershipId}:${l.weekday}:${l.periodId}`),
    );
    const activeTeachers = new Set((await teacherOptions(tx, ctx.tenant.id)).map((t) => t.membershipId));
    const copied = new Set<string>();
    let lessons = 0;
    let skipped = 0;
    for (const l of source) {
      if (planned.has(l.classId)) continue;
      const teacher = l.membershipId && activeTeachers.has(l.membershipId) ? l.membershipId : null;
      const key = `${teacher}:${l.weekday}:${l.periodId}`;
      if (teacher && busy.has(key)) {
        skipped++;
        continue;
      }
      if (teacher) busy.add(key);
      await tx.insert(timetableLessons).values({
        tenantId: ctx.tenant.id,
        termId: to.id,
        classId: l.classId,
        weekday: l.weekday,
        periodId: l.periodId,
        subjectId: l.subjectId,
        membershipId: teacher,
        updatedByUserId: ctx.userId,
      });
      copied.add(l.classId);
      lessons++;
    }
    if (lessons)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "timetable.copied",
        entityType: "term",
        entityId: to.id,
        metadata: { from: from.name, to: to.name, classes: copied.size, lessons, skipped },
      });
    return { classes: copied.size, lessons, skipped };
  });
}

/** The lessons a teacher (membership) has on a weekday in a term, in period order. */
export async function teacherLessonsOn(
  tx: Transaction,
  tenantId: string,
  termId: string,
  membershipId: string,
  weekday: number,
): Promise<Lesson[]> {
  return readLessons(
    tx,
    tenantId,
    eq(timetableLessons.termId, termId),
    eq(timetableLessons.membershipId, membershipId),
    eq(timetableLessons.weekday, weekday),
    isNotNull(timetableLessons.membershipId),
  );
}
