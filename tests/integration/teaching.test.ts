import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  listLevelsWithClasses,
  listTeacherOptions,
  setupDefaultLevels,
  updateClass,
} from "@/server/academics/classes";
import { getTemplate } from "@/server/academics/templates";
import { getClassOverview } from "@/server/assessment/report-cards";
import { getScoreSheet, listAssessmentClasses, saveScores } from "@/server/assessment/scores";
import {
  createSubject,
  getAssessmentSetup,
  readBands,
  readScheme,
  setupDefaultSubjects,
} from "@/server/assessment/setup";
import {
  assignSubjectTeacher,
  getTeachingOverview,
  removeSubjectTeacher,
} from "@/server/assessment/teaching";
import { getRegister } from "@/server/attendance/registers";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { subjectTeachers, tenants } from "@/server/db/schema";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { saveCurriculumTemplate, saveTeachingModel } from "@/server/tenancy/preferences";
import { createTenant, addMember, createUser } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const ctxOf = (s: School, userId: string) =>
  resolveTenantContext(conn.app, s.tenant.slug, userId) as Promise<TenantContext>;

/**
 * A school with GES subjects, Basic 4A (class teacher: "Teacher") and Basic 4B, one pupil in each, and a
 * second teacher, Mr Mensah, who teaches no class.
 */
async function setUp() {
  const s = await school();
  await setupDefaultSubjects(conn.app, s.owner);
  const options = await listTeacherOptions(conn.app, s.owner);
  const classTeacher = options.find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: classTeacher.membershipId,
  });
  const mensahUser = await createUser(conn.owner, "Kwame Mensah");
  const mensahMember = await addMember(conn.owner, s.tenant.id, mensahUser.id, ["teacher"]);
  const mensah = await ctxOf(s, mensahUser.id);
  const ama = await s.add("Ama", s.classA);
  await s.add("Esi", s.classB);
  const setup = (await getAssessmentSetup(conn.app, s.owner, s.termId))!;
  const maths = setup.subjects.find((x) => x.name === "Mathematics")!.id;
  const english = setup.subjects.find((x) => x.name === "English Language")!.id;
  return { s, mensah, mensahMember: mensahMember.id, ama, maths, english };
}

const sheet = (s: School, ctx: TenantContext, classId: string, subjectId: string) =>
  getScoreSheet(conn.app, ctx, s.termId, classId, subjectId);

const mark = (
  s: School,
  ctx: TenantContext,
  classId: string,
  subjectId: string,
  studentId: string,
  value: string,
) =>
  saveScores(conn.app, ctx, s.termId, classId, subjectId, {
    cells: [{ studentId, key: "exam", original: "", value }],
  });

describe("teaching by class or by subject", () => {
  it("by class (the default): the class teacher enters every subject, assignments have no effect", async () => {
    const { s, mensah, mensahMember, ama, maths, english } = await setUp();
    await assignSubjectTeacher(conn.app, s.owner, {
      membershipId: mensahMember,
      subjectId: maths,
      classIds: [s.classA],
    });
    expect(await sheet(s, s.teacher, s.classA, maths)).not.toBeNull();
    expect(await sheet(s, s.teacher, s.classA, english)).not.toBeNull();
    expect(await sheet(s, mensah, s.classA, maths)).toBeNull();
    expect((await listAssessmentClasses(conn.app, mensah, s.termId))!.classes).toEqual([]);
    expect((await mark(s, s.teacher, s.classA, maths, ama.id, "70")).saved).toBe(1);
  });

  it("by subject: one teacher teaches a subject across classes; the class teacher keeps the rest", async () => {
    const { s, mensah, mensahMember, ama, maths, english } = await setUp();
    await saveTeachingModel(conn.app, s.owner, { teachingModel: "subject" });
    await assignSubjectTeacher(conn.app, s.owner, {
      membershipId: mensahMember,
      subjectId: maths,
      classIds: [s.classA, s.classB],
    });

    // Mr Mensah: Mathematics in both classes, nothing else, and no class overview, register or report cards.
    const listed = (await listAssessmentClasses(conn.app, mensah, s.termId))!.classes;
    expect(listed.map((c) => [c.cls.name, c.wholeClass, c.mySubjects.map((x) => x.name)])).toEqual([
      ["Basic 4A", false, ["Mathematics"]],
      ["Basic 4B", false, ["Mathematics"]],
    ]);
    expect(await sheet(s, mensah, s.classB, maths)).not.toBeNull();
    expect(await sheet(s, mensah, s.classA, english)).toBeNull();
    expect((await mark(s, mensah, s.classA, maths, ama.id, "81")).saved).toBe(1);
    await expect(mark(s, mensah, s.classA, english, ama.id, "60")).rejects.toMatchObject({
      code: "class_not_found",
    });
    expect(await getClassOverview(conn.app, mensah, s.termId, s.classA)).toBeNull();
    expect(await getRegister(conn.app, mensah, s.classA, "2026-09-09")).toBeNull();

    // The class teacher: every other subject of Basic 4A, not Mathematics.
    expect(await sheet(s, s.teacher, s.classA, maths)).toBeNull();
    expect(await sheet(s, s.teacher, s.classA, english)).not.toBeNull();
    const overview = (await getClassOverview(conn.app, s.teacher, s.termId, s.classA))!;
    const mathsRow = overview.subjects.find((x) => x.id === maths)!;
    expect(mathsRow).toMatchObject({ teacher: "Kwame Mensah", canEnter: false });
    expect(overview.subjects.find((x) => x.id === english)).toMatchObject({ teacher: null, canEnter: true });

    // Academic leads still reach every sheet.
    expect(await sheet(s, s.head, s.classA, maths)).not.toBeNull();

    // The overview groups one teacher and one subject with its classes: no duplicated teachers or subjects.
    const teaching = await getTeachingOverview(conn.app, s.owner);
    expect(teaching.model).toBe("subject");
    expect(teaching.assignments.map((a) => [a.teacherName, a.subjectName, a.className])).toEqual([
      ["Kwame Mensah", "Mathematics", "Basic 4A"],
      ["Kwame Mensah", "Mathematics", "Basic 4B"],
    ]);

    // Removing the assignment hands Basic 4A Mathematics back to the class teacher.
    await removeSubjectTeacher(conn.app, s.owner, teaching.assignments[0]!.id);
    expect(await sheet(s, s.teacher, s.classA, maths)).not.toBeNull();
    expect(await sheet(s, mensah, s.classA, maths)).toBeNull();
    expect(await sheet(s, mensah, s.classB, maths)).not.toBeNull();

    // Switching back to class teachers keeps the remaining assignment for later.
    await saveTeachingModel(conn.app, s.owner, { teachingModel: "class" });
    expect(await sheet(s, mensah, s.classB, maths)).toBeNull();
    const rows = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(subjectTeachers).where(eq(subjectTeachers.tenantId, s.tenant.id)),
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps one teacher per subject per class, checks the subject is taught there, and is for leads only", async () => {
    const { s, mensah, mensahMember, maths } = await setUp();
    await saveTeachingModel(conn.app, s.owner, { teachingModel: "subject" });
    const teacherMember = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
    await assignSubjectTeacher(conn.app, s.owner, {
      membershipId: mensahMember,
      subjectId: maths,
      classIds: [s.classA],
    });
    // Giving Basic 4A Mathematics to someone else moves it; the class never has two Mathematics teachers.
    await assignSubjectTeacher(conn.app, s.owner, {
      membershipId: teacherMember.membershipId,
      subjectId: maths,
      classIds: [s.classA],
    });
    const rows = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select()
        .from(subjectTeachers)
        .where(and(eq(subjectTeachers.tenantId, s.tenant.id), eq(subjectTeachers.subjectId, maths))),
    );
    expect(rows.map((r) => r.membershipId)).toEqual([teacherMember.membershipId]);
    expect(await sheet(s, mensah, s.classA, maths)).toBeNull();

    // A class whose level does not take the subject is refused.
    const latin = await createSubject(conn.app, s.owner, { name: "Latin", levelIds: [] });
    await expect(
      assignSubjectTeacher(conn.app, s.owner, {
        membershipId: mensahMember,
        subjectId: latin,
        classIds: [s.classA],
      }),
    ).rejects.toMatchObject({ code: "subject_not_taken" });
    await expect(
      assignSubjectTeacher(conn.app, s.teacher, {
        membershipId: mensahMember,
        subjectId: maths,
        classIds: [s.classB],
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(saveTeachingModel(conn.app, s.teacher, { teachingModel: "class" })).rejects.toThrow(
      ForbiddenError,
    );
    // Another school's teacher cannot be assigned.
    const other = await school();
    const outsider = (await listTeacherOptions(conn.app, other.owner)).find((t) => t.name === "Teacher")!;
    await expect(
      assignSubjectTeacher(conn.app, s.owner, {
        membershipId: outsider.membershipId,
        subjectId: maths,
        classIds: [s.classB],
      }),
    ).rejects.toMatchObject({ code: "teacher_invalid" });
  });
});

describe("country starter templates", () => {
  async function kenyanSchool() {
    const tenant = await createTenant(conn.owner, "Synthetic Nairobi School");
    await conn.owner
      .update(tenants)
      .set({ countryCode: "KE", currencyCode: "KES", timezone: "Africa/Nairobi" })
      .where(eq(tenants.id, tenant.id));
    const user = await createUser(conn.owner, "Head of Academics");
    await addMember(conn.owner, tenant.id, user.id, ["owner"]);
    return (await resolveTenantContext(conn.app, tenant.slug, user.id)) as TenantContext;
  }

  it("start a Kenyan school from Competency-Based Education: levels, subjects, grades and parts", async () => {
    const ke = await kenyanSchool();
    expect((await getTemplate(conn.app, ke)).id).toBe("kenya_cbe");
    await setupDefaultLevels(conn.app, ke, { stages: ["nursery", "kindergarten", "primary", "jhs"] });
    const names = (await listLevelsWithClasses(conn.app, ke)).map((l) => l.name);
    expect(names).toEqual([
      "PP1",
      "PP2",
      "Grade 1",
      "Grade 2",
      "Grade 3",
      "Grade 4",
      "Grade 5",
      "Grade 6",
      "Grade 7",
      "Grade 8",
      "Grade 9",
    ]);
    await setupDefaultSubjects(conn.app, ke);
    const setup = await withTenant(conn.app, { tenantId: ke.tenant.id, userId: ke.userId }, async (tx) => ({
      jhs: await readBands(tx, ke.tenant.id, "jhs"),
      primary: await readBands(tx, ke.tenant.id, "primary"),
      scheme: await readScheme(tx, ke.tenant.id, "00000000-0000-0000-0000-000000000000"),
    }));
    expect(setup.primary.map((b) => b.grade)).toEqual(["EE", "ME", "AE", "BE"]);
    expect(setup.jhs[0]).toMatchObject({ grade: "EE1", min: 90 });
    expect(setup.scheme.components.map((c) => c.weight)).toEqual([40, 60]);
  });

  it("let a school choose another template, and its grades follow until it sets its own", async () => {
    const ke = await kenyanSchool();
    await setupDefaultLevels(conn.app, ke, { stages: ["primary"], template: "international" });
    expect((await listLevelsWithClasses(conn.app, ke)).map((l) => l.name)).toEqual([
      "Year 1",
      "Year 2",
      "Year 3",
      "Year 4",
      "Year 5",
      "Year 6",
    ]);
    expect((await getTemplate(conn.app, ke)).id).toBe("international");
    await saveCurriculumTemplate(conn.app, ke, { curriculumTemplate: "nigeria_ube" });
    const bands = await withTenant(conn.app, { tenantId: ke.tenant.id, userId: ke.userId }, (tx) =>
      readBands(tx, ke.tenant.id, "primary"),
    );
    expect(bands[0]).toMatchObject({ grade: "A", min: 70 });
    await expect(saveCurriculumTemplate(conn.app, ke, { curriculumTemplate: "made_up" })).rejects.toThrow();
  });
});
