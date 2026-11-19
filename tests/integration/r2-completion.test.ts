import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears } from "@/server/academics/calendar";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import { getSubjectComments, saveSubjectComments } from "@/server/assessment/comments";
import { getReportCard, publishReportCards, withdrawReportCard } from "@/server/assessment/report-cards";
import { getAssessmentSetup, saveGradingScale, setupDefaultSubjects } from "@/server/assessment/setup";
import { saveScores } from "@/server/assessment/scores";
import { assignSubjectTeacher } from "@/server/assessment/teaching";
import { getLessonRegister, listLessonRegisters, syncLessonRegister } from "@/server/attendance/lessons";
import { syncRegister } from "@/server/attendance/registers";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import {
  academicYears,
  lessonMarkChanges,
  lessonMarks,
  subjectComments,
  terms,
  timetableLessons,
} from "@/server/db/schema";
import { DomainError } from "@/server/errors";
import { exportDataset } from "@/server/export/datasets";
import { SYNC_HANDLERS } from "@/server/sync/handlers";
import { applyOperations } from "@/server/sync/protocol";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import {
  saveCurriculumTemplate,
  saveLessonAttendance,
  saveReportCardStyle,
  saveTeachingModel,
} from "@/server/tenancy/preferences";
import {
  clearLesson,
  copyTimetable,
  getClassTimetable,
  getTeacherTimetable,
  getTimetableOverview,
  removePeriod,
  savePeriod,
  setLesson,
} from "@/server/timetable/service";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { isoWeekday } from "@/lib/timetable";
import { addMember, createUser } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

/** A database refusal (trigger or check) whose message matches; drizzle wraps it in the query error. */
const dbRefused = (pattern: RegExp) => (error: unknown) =>
  pattern.test(
    String((error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message),
  );

/** The latest weekday on or before a date. */
function schoolDay(date: string): string {
  let d = date;
  while (isoWeekday(d) > 5) d = addDays(d, -1);
  return d;
}

/**
 * A school whose term runs around today, GES subjects, Basic 4A (class teacher: "Teacher") with two pupils,
 * a subject teacher Mr Mensah who is nobody's class teacher, and two lesson periods with a break between.
 */
async function setUp() {
  const s = await school();
  const today = todayIn(s.tenant.timezone);
  await asSchool(s, async (tx) => {
    await tx
      .update(terms)
      .set({ startsOn: addDays(today, -60), endsOn: addDays(today, 60) })
      .where(eq(terms.id, s.termId));
    await tx
      .update(academicYears)
      .set({ startsOn: addDays(today, -60), endsOn: addDays(today, 60) })
      .where(eq(academicYears.tenantId, s.tenant.id));
  });
  await setupDefaultSubjects(conn.app, s.owner);
  const options = await listTeacherOptions(conn.app, s.owner);
  const classTeacher = options.find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: classTeacher.membershipId,
  });
  const mensahUser = await createUser(conn.owner, "Kwame Mensah");
  const mensahMember = await addMember(conn.owner, s.tenant.id, mensahUser.id, ["teacher"]);
  const mensah = (await resolveTenantContext(conn.app, s.tenant.slug, mensahUser.id)) as TenantContext;
  const ama = await s.add("Ama", s.classA);
  const kofi = await s.add("Kofi", s.classA);
  const setup = (await getAssessmentSetup(conn.app, s.owner, s.termId))!;
  const maths = setup.subjects.find((x) => x.name === "Mathematics")!.id;
  const english = setup.subjects.find((x) => x.name === "English Language")!.id;
  const p1 = await savePeriod(conn.app, s.owner, {
    name: "Period 1",
    startsAt: "08:00",
    endsAt: "08:40",
    kind: "lesson",
  });
  await savePeriod(conn.app, s.owner, { name: "Break", startsAt: "08:40", endsAt: "09:00", kind: "break" });
  const p2 = await savePeriod(conn.app, s.owner, {
    name: "Period 2",
    startsAt: "9:00",
    endsAt: "9:40",
    kind: "lesson",
  });
  const day = schoolDay(today);
  return {
    s,
    today,
    day,
    weekday: isoWeekday(day),
    mensah,
    mensahMember: mensahMember.id,
    classTeacher: classTeacher.membershipId,
    ama,
    kofi,
    maths,
    english,
    p1,
    p2,
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

const lesson = (t: Setup, extra: Record<string, unknown> = {}) =>
  setLesson(conn.app, t.s.owner, {
    termId: t.s.termId,
    classId: t.s.classA,
    weekday: t.weekday,
    periodId: t.p1.id,
    subjectId: t.maths,
    membershipId: t.mensahMember,
    ...extra,
  });

const mark = (
  t: Setup,
  ctx: TenantContext,
  marks: { studentId: string; status: "present" | "late" | "absent" | "excused"; baseVersion: number }[],
  periodId = t.p1.id,
) =>
  syncLessonRegister(conn.app, ctx, { classId: t.s.classA, periodId, date: t.day, source: "online", marks });

describe("timetables", () => {
  it("keeps the school day in order and refuses overlapping periods", async () => {
    const t = await setUp();
    const overview = (await getTimetableOverview(conn.app, t.s.owner, t.s.termId))!;
    expect(overview.periods.map((p) => [p.name, p.startsAt, p.kind])).toEqual([
      ["Period 1", "08:00", "lesson"],
      ["Break", "08:40", "break"],
      ["Period 2", "09:00", "lesson"],
    ]);
    await expect(
      savePeriod(conn.app, t.s.owner, {
        name: "Assembly",
        startsAt: "08:30",
        endsAt: "08:50",
        kind: "lesson",
      }),
    ).rejects.toThrow(/overlaps Period 1/);
    await expect(
      savePeriod(conn.app, t.s.owner, {
        name: "period 1",
        startsAt: "12:00",
        endsAt: "12:40",
        kind: "lesson",
      }),
    ).rejects.toThrow(/already a period called/);
    await expect(
      savePeriod(conn.app, t.s.teacher, {
        name: "Period 3",
        startsAt: "10:00",
        endsAt: "10:40",
        kind: "lesson",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("plans lessons: subjects the level takes, and never a teacher in two classes at once", async () => {
    const t = await setUp();
    await lesson(t);
    const timetable = (await getClassTimetable(conn.app, t.s.owner, t.s.termId, t.s.classA))!;
    expect(timetable.lessons).toMatchObject([
      { weekday: t.weekday, subjectName: "Mathematics", teacherName: "Kwame Mensah" },
    ]);
    // The same slot in another class with the same teacher is refused, by the service and by the database.
    await expect(lesson(t, { classId: t.s.classB })).rejects.toThrow(
      /Kwame Mensah already teaches Mathematics in Basic 4A/,
    );
    await expect(
      asSchool(t.s, (tx) =>
        tx.insert(timetableLessons).values({
          tenantId: t.s.tenant.id,
          termId: t.s.termId,
          classId: t.s.classB,
          weekday: t.weekday,
          periodId: t.p1.id,
          subjectId: t.maths,
          membershipId: t.mensahMember,
        }),
      ),
    ).rejects.toThrow();
    // A break holds no lessons; a weekend is not a school day.
    const brk = timetable.periods.find((p) => p.kind === "break")!;
    await expect(lesson(t, { periodId: brk.id })).rejects.toThrow(/is a break/);
    await expect(lesson(t, { weekday: 6 })).rejects.toThrow(/Monday to Friday/);
    // Changing the slot replaces the lesson; clearing removes it.
    await lesson(t, { subjectId: t.english, membershipId: "" });
    expect((await getClassTimetable(conn.app, t.s.owner, t.s.termId, t.s.classA))!.lessons).toMatchObject([
      { subjectName: "English Language", teacherName: null },
    ]);
    await clearLesson(conn.app, t.s.owner, {
      termId: t.s.termId,
      classId: t.s.classA,
      weekday: t.weekday,
      periodId: t.p1.id,
    });
    expect((await getClassTimetable(conn.app, t.s.owner, t.s.termId, t.s.classA))!.lessons).toEqual([]);
  });

  it("suggests the subject teacher, and shows teachers their own lessons only", async () => {
    const t = await setUp();
    await saveTeachingModel(conn.app, t.s.owner, { teachingModel: "subject" });
    await assignSubjectTeacher(conn.app, t.s.owner, {
      membershipId: t.mensahMember,
      subjectId: t.maths,
      classIds: [t.s.classA],
    });
    const plan = (await getClassTimetable(conn.app, t.s.owner, t.s.termId, t.s.classA))!;
    expect(plan.options!.subjects.find((x) => x.id === t.maths)!.suggestedTeacher).toBe(t.mensahMember);
    expect(plan.options!.subjects.find((x) => x.id === t.english)!.suggestedTeacher).toBe(t.classTeacher);
    await lesson(t);
    const own = (await getTeacherTimetable(conn.app, t.mensah, t.s.termId))!;
    expect(own.own).toBe(true);
    expect(own.lessons.map((l) => l.className)).toEqual(["Basic 4A"]);
    expect(own.teachers).toEqual([]);
    // Asking for someone else's timetable gives a teacher their own.
    expect((await getTeacherTimetable(conn.app, t.mensah, t.s.termId, t.classTeacher))!.own).toBe(true);
    // The class teacher sees the class's timetable; Mr Mensah is not its class teacher.
    expect(await getClassTimetable(conn.app, t.s.teacher, t.s.termId, t.s.classA)).not.toBeNull();
    expect(await getClassTimetable(conn.app, t.mensah, t.s.termId, t.s.classA)).toBeNull();
    expect((await getClassTimetable(conn.app, t.s.teacher, t.s.termId, t.s.classA))!.options).toBeNull();
    await expect(lesson(t, { periodId: t.p2.id })).resolves.toBeUndefined();
    await expect(
      setLesson(conn.app, t.s.teacher, {
        termId: t.s.termId,
        classId: t.s.classA,
        weekday: t.weekday,
        periodId: t.p2.id,
        subjectId: t.maths,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("copies a term's timetables without overwriting classes already planned", async () => {
    const t = await setUp();
    await lesson(t);
    await lesson(t, { classId: t.s.classB, membershipId: "", periodId: t.p2.id });
    const today = t.today;
    await createAcademicYear(conn.app, t.s.owner, {
      name: "2030/2031",
      terms: [{ name: "Term 1", startsOn: addDays(today, 100), endsOn: addDays(today, 180) }],
    });
    const next = (await listAcademicYears(conn.app, t.s.owner)).find((y) => y.name === "2030/2031")!
      .terms[0]!;
    // Basic 4B is planned already in the new term; only Basic 4A is copied.
    await setLesson(conn.app, t.s.owner, {
      termId: next.id,
      classId: t.s.classB,
      weekday: 1,
      periodId: t.p1.id,
      subjectId: t.english,
    });
    const copied = await copyTimetable(conn.app, t.s.owner, { fromTermId: t.s.termId, toTermId: next.id });
    expect(copied).toEqual({ classes: 1, lessons: 1, skipped: 0 });
    const b = (await getClassTimetable(conn.app, t.s.owner, next.id, t.s.classB))!;
    expect(b.lessons.map((l) => l.subjectName)).toEqual(["English Language"]);
    const again = await copyTimetable(conn.app, t.s.owner, { fromTermId: t.s.termId, toTermId: next.id });
    expect(again.lessons).toBe(0);
  });
});

describe("lesson attendance", () => {
  it("is off until the school turns it on", async () => {
    const t = await setUp();
    await lesson(t);
    expect((await listLessonRegisters(conn.app, t.mensah, t.day)).enabled).toBe(false);
    await expect(
      mark(t, t.mensah, [{ studentId: t.ama.id, status: "present", baseVersion: 0 }]),
    ).rejects.toThrow(/does not take lesson registers/);
    await expect(
      saveLessonAttendance(conn.app, t.s.teacher, { lessonAttendance: "on" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets the lesson's teacher take it, keeps every change, and never overwrites a newer mark", async () => {
    const t = await setUp();
    await lesson(t);
    await saveLessonAttendance(conn.app, t.s.owner, { lessonAttendance: "on" });
    const day = await listLessonRegisters(conn.app, t.mensah, t.day);
    expect(day.lessons.map((l) => [l.lesson.subjectName, l.lesson.className, l.students])).toEqual([
      ["Mathematics", "Basic 4A", 2],
    ]);
    // Mr Mensah teaches the lesson though he is not the class teacher; another subject's teacher cannot.
    const first = await mark(t, t.mensah, [
      { studentId: t.ama.id, status: "present", baseVersion: 0 },
      { studentId: t.kofi.id, status: "absent", baseVersion: 0 },
    ]);
    expect(first).toMatchObject({ applied: 2, conflicts: [] });
    const otherUser = await createUser(conn.owner, "Efua Other");
    await addMember(conn.owner, t.s.tenant.id, otherUser.id, ["teacher"]);
    const other = (await resolveTenantContext(conn.app, t.s.tenant.slug, otherUser.id)) as TenantContext;
    await expect(mark(t, other, [{ studentId: t.ama.id, status: "absent", baseVersion: 1 }])).rejects.toThrow(
      /no such lesson/,
    );
    expect(await getLessonRegister(conn.app, other, t.s.classA, t.day, t.p1.id)).toBeNull();
    // The class teacher corrects Kofi (he was late); Mr Mensah's later change from the old version conflicts.
    await mark(t, t.s.teacher, [{ studentId: t.kofi.id, status: "late", baseVersion: 1 }]);
    const stale = await mark(t, t.mensah, [{ studentId: t.kofi.id, status: "excused", baseVersion: 1 }]);
    expect(stale.applied).toBe(0);
    expect(stale.conflicts).toMatchObject([
      { name: "Kofi Mensah", theirs: { status: "late", by: "Teacher" } },
    ]);
    const view = (await getLessonRegister(conn.app, t.mensah, t.s.classA, t.day, t.p1.id))!;
    expect(view.students.map((s) => s.mark?.status)).toEqual(["present", "late"]);
    expect(view.termSummary?.held).toBe(1);
    expect(view.termSummary?.attended.get(t.kofi.id)).toBe(1);
    const history = await asSchool(t.s, (tx) =>
      tx
        .select({ to: lessonMarkChanges.toStatus })
        .from(lessonMarkChanges)
        .where(eq(lessonMarkChanges.studentId, t.kofi.id)),
    );
    expect(history.map((h) => h.to).sort()).toEqual(["absent", "late"]);
    // History cannot be rewritten, and versions only step by one.
    await expect(
      asSchool(t.s, (tx) => tx.delete(lessonMarkChanges).where(eq(lessonMarkChanges.studentId, t.kofi.id))),
    ).rejects.toSatisfy(dbRefused(/append-only/));
    await expect(
      asSchool(t.s, (tx) =>
        tx.update(lessonMarks).set({ version: 9 }).where(eq(lessonMarks.studentId, t.kofi.id)),
      ),
    ).rejects.toSatisfy(dbRefused(/go up by one/));
  });

  it("applies a register sent from an offline device once, through the sync protocol", async () => {
    const t = await setUp();
    await lesson(t);
    await saveLessonAttendance(conn.app, t.s.owner, { lessonAttendance: "on" });
    const op = {
      id: randomUUID(),
      kind: "attendance.register" as const,
      recordedAt: new Date().toISOString(),
      payload: {
        classId: t.s.classA,
        periodId: t.p1.id,
        date: t.day,
        marks: [{ studentId: t.ama.id, status: "absent", baseVersion: 0 }],
      },
    };
    const [first] = await applyOperations(conn.app, t.mensah, { operations: [op] }, SYNC_HANDLERS);
    const [again] = await applyOperations(conn.app, t.mensah, { operations: [op] }, SYNC_HANDLERS);
    expect(first).toMatchObject({ status: "applied", replayed: false });
    expect(again).toMatchObject({ status: "applied", replayed: true });
    const rows = await asSchool(t.s, (tx) =>
      tx.select().from(lessonMarkChanges).where(eq(lessonMarkChanges.studentId, t.ama.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "offline", toStatus: "absent" });
    expect(rows[0]!.recordedOnDeviceAt).not.toBeNull();
  });

  it("lists students at school who missed a lesson, for academic staff", async () => {
    const t = await setUp();
    await lesson(t);
    await saveLessonAttendance(conn.app, t.s.owner, { lessonAttendance: "on" });
    await syncRegister(conn.app, t.s.teacher, {
      classId: t.s.classA,
      date: t.day,
      source: "online",
      marks: [
        { studentId: t.ama.id, status: "present", baseVersion: 0 },
        { studentId: t.kofi.id, status: "absent", baseVersion: 0 },
      ],
    });
    await mark(t, t.mensah, [
      { studentId: t.ama.id, status: "absent", baseVersion: 0 },
      { studentId: t.kofi.id, status: "absent", baseVersion: 0 },
    ]);
    const lead = await listLessonRegisters(conn.app, t.s.head, t.day);
    expect(lead.missed).toEqual([
      { studentId: t.ama.id, name: "Ama Mensah", className: "Basic 4A", lessons: ["Mathematics (Period 1)"] },
    ]);
    expect((await listLessonRegisters(conn.app, t.mensah, t.day)).missed).toBeNull();
  });

  it("keeps a period that registers were taken in", async () => {
    const t = await setUp();
    await lesson(t);
    await saveLessonAttendance(conn.app, t.s.owner, { lessonAttendance: "on" });
    await mark(t, t.mensah, [{ studentId: t.ama.id, status: "present", baseVersion: 0 }]);
    await expect(removePeriod(conn.app, t.s.owner, t.p1.id)).rejects.toThrow(/registers were taken/);
    await expect(removePeriod(conn.app, t.s.owner, t.p2.id)).resolves.toBeUndefined();
    // The register stands even when the lesson leaves the timetable.
    await clearLesson(conn.app, t.s.owner, {
      termId: t.s.termId,
      classId: t.s.classA,
      weekday: t.weekday,
      periodId: t.p1.id,
    });
    const view = await getLessonRegister(conn.app, t.mensah, t.s.classA, t.day, t.p1.id);
    expect(view?.lesson.subjectName).toBe("Mathematics");
    const { csv } = await exportDataset(conn.app, t.s.owner, "lesson_attendance");
    expect(csv).toContain("Mathematics");
  });
});

describe("report cards: comments, layouts and GPA", () => {
  async function graded(t: Setup) {
    for (const subjectId of [t.maths, t.english])
      await saveScores(conn.app, t.s.owner, t.s.termId, t.s.classA, subjectId, {
        cells: [
          { studentId: t.ama.id, key: "class", original: "", value: "45" },
          { studentId: t.ama.id, key: "exam", original: "", value: "90" },
        ],
      });
  }

  it("saves subject comments without overwriting another person's, and locks them when published", async () => {
    const t = await setUp();
    const save = (ctx: TenantContext, value: string, original = "") =>
      saveSubjectComments(conn.app, ctx, t.s.termId, t.s.classA, t.maths, {
        comments: [{ studentId: t.ama.id, original, value }],
      });
    expect(await save(t.s.teacher, "  Strong   on fractions.  ")).toEqual({
      saved: 1,
      conflicts: [],
      locked: [],
    });
    const view = (await getSubjectComments(conn.app, t.s.teacher, t.s.termId, t.s.classA, t.maths))!;
    expect(view.students.find((s) => s.id === t.ama.id)!.comment).toBe("Strong on fractions.");
    // Someone who opened the page before that save does not overwrite it.
    expect(await save(t.s.head, "Needs practice.", "")).toEqual({
      saved: 0,
      conflicts: ["Ama Mensah"],
      locked: [],
    });
    // Mr Mensah does not teach Mathematics in this class (class teachers enter every subject by default).
    expect(await getSubjectComments(conn.app, t.mensah, t.s.termId, t.s.classA, t.maths)).toBeNull();
    await expect(save(t.mensah, "x")).rejects.toThrow(DomainError);
    await graded(t);
    await publishReportCards(conn.app, t.s.head, t.s.termId, t.s.classA, { studentIds: [t.ama.id] });
    expect(await save(t.s.teacher, "Changed.", "Strong on fractions.")).toEqual({
      saved: 0,
      conflicts: [],
      locked: ["Ama Mensah"],
    });
    await expect(
      asSchool(t.s, (tx) => tx.delete(subjectComments).where(eq(subjectComments.studentId, t.ama.id))),
    ).rejects.toSatisfy(dbRefused(/locked/));
    const card = (await getReportCard(conn.app, t.s.head, t.s.termId, t.s.classA, t.ama.id))!;
    expect(card.snapshot.style).toBe("ges");
    expect(card.snapshot.subjects.find((x) => x.name === "Mathematics")).toMatchObject({
      comment: "Strong on fractions.",
      teacher: "Teacher",
    });
    await withdrawReportCard(conn.app, t.s.head, t.s.termId, t.s.classA, t.ama.id, { reason: "Comment fix" });
    expect((await save(t.s.teacher, "", "Strong on fractions.")).saved).toBe(1);
  });

  it("freezes the layout and GPA a card was published with", async () => {
    const t = await setUp();
    await saveCurriculumTemplate(conn.app, t.s.owner, { curriculumTemplate: "american" });
    // Basic 4 is a primary-stage level: the American template's letter grades carry grade points.
    await graded(t);
    const draft = (await getReportCard(conn.app, t.s.head, t.s.termId, t.s.classA, t.ama.id))!;
    expect(draft.snapshot.style).toBe("american");
    // 45/50 and 90/100 with the American parts (40% and 60%, each out of 100): 18 + 54 = 72 → C- (1.70).
    expect(draft.snapshot.subjects.find((x) => x.name === "Mathematics")).toMatchObject({
      total: 72,
      grade: "C-",
    });
    expect(draft.snapshot.overall.gpa).toBe(170);
    await publishReportCards(conn.app, t.s.head, t.s.termId, t.s.classA, { studentIds: [t.ama.id] });
    // A later change of layout or grade points does not alter the published card.
    await saveReportCardStyle(conn.app, t.s.owner, { reportCardStyle: "cambridge" });
    await saveGradingScale(conn.app, t.s.owner, "primary", {
      bands: [
        { min: 50, grade: "P", remark: "Pass", points: "2" },
        { min: 0, grade: "F", remark: "Fail", points: "0" },
      ],
    });
    const published = (await getReportCard(conn.app, t.s.head, t.s.termId, t.s.classA, t.ama.id))!;
    expect(published.snapshot.style).toBe("american");
    expect(published.snapshot.overall.gpa).toBe(170);
    const kofi = (await getReportCard(conn.app, t.s.head, t.s.termId, t.s.classA, t.kofi.id))!;
    expect(kofi.snapshot.style).toBe("cambridge");
    await expect(
      saveGradingScale(conn.app, t.s.owner, "primary", {
        bands: [{ min: 0, grade: "F", remark: "", points: "12" }],
      }),
    ).rejects.toThrow(/grade points/i);
    await saveReportCardStyle(conn.app, t.s.owner, { reportCardStyle: "template" });
    const back = (await getReportCard(conn.app, t.s.head, t.s.termId, t.s.classA, t.kofi.id))!;
    expect(back.snapshot.style).toBe("american");
    // Lesson rows in the database are only ever this school's.
    const lessons = await asSchool(t.s, (tx) =>
      tx
        .select()
        .from(timetableLessons)
        .where(and(eq(timetableLessons.tenantId, t.s.tenant.id))),
    );
    expect(lessons).toEqual([]);
  });
});
