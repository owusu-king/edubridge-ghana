import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, setupDefaultLevels, listLevelsWithClasses } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses } from "@/server/db/schema";
import {
  assignClass,
  createStudent,
  getStudent,
  listStudents,
  setStudentStatus,
  updateStudent,
} from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

const year = {
  name: "2026/2027",
  terms: [
    { name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" },
    { name: "Term 2", startsOn: "2027-01-11", endsOn: "2027-04-09" },
  ],
};

async function school({ withTerm = true } = {}) {
  const tenant = await createTenant(conn.owner);
  const users = {
    head: await createUser(conn.owner, "Head"),
    teacher: await createUser(conn.owner, "Class Teacher"),
    other: await createUser(conn.owner, "Other Teacher"),
    bursar: await createUser(conn.owner, "Accountant"),
  };
  await addMember(conn.owner, tenant.id, users.head.id, ["headteacher"]);
  const teacherM = await addMember(conn.owner, tenant.id, users.teacher.id, ["teacher"]);
  await addMember(conn.owner, tenant.id, users.other.id, ["teacher"]);
  await addMember(conn.owner, tenant.id, users.bursar.id, ["bursar"]);
  const [campus] = await withTenant(conn.owner, { tenantId: tenant.id, userId: users.head.id }, (tx) =>
    tx.insert(campuses).values({ tenantId: tenant.id, name: "Main" }).returning(),
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  const head = await ctx(users.head.id);
  await setupDefaultLevels(conn.app, head, { stages: ["primary"] });
  const [b1, b2] = await listLevelsWithClasses(conn.app, head);
  const classA = await createClass(conn.app, head, {
    levelId: b1!.id,
    campusId: campus!.id,
    name: "Basic 1",
    classTeacherMembershipId: teacherM.id,
  });
  const classB = await createClass(conn.app, head, {
    levelId: b2!.id,
    campusId: campus!.id,
    name: "Basic 2",
  });
  if (withTerm) {
    await createAcademicYear(conn.app, head, year);
    const [y] = await listAcademicYears(conn.app, head);
    await setCurrentTerm(conn.app, head, y!.terms[0]!.id);
  }
  return {
    head,
    teacher: await ctx(users.teacher.id),
    other: await ctx(users.other.id),
    bursar: await ctx(users.bursar.id),
    classA,
    classB,
  };
}

const ama = {
  firstName: "Ama",
  otherNames: "Serwaa",
  lastName: "Mensah",
  sex: "female",
  dateOfBirth: "2018-03-14",
};

describe("students", () => {
  it("creates a student with an automatic admission number and places them in a class", async () => {
    const s = await school();
    const first = await createStudent(conn.app, s.head, { ...ama, classId: s.classA });
    const second = await createStudent(conn.app, s.head, {
      firstName: "Kofi",
      lastName: "Owusu",
      sex: "male",
    });
    expect([first.admissionNumber, second.admissionNumber]).toEqual(["0001", "0002"]);
    const detail = await getStudent(conn.app, s.head, first.id);
    expect(detail).toMatchObject({
      fullName: "Ama Serwaa Mensah",
      currentClass: { name: "Basic 1" },
      status: "active",
    });
    expect(detail!.history).toEqual([
      { termName: "Term 1", yearName: "2026/2027", className: "Basic 1", levelName: "Basic 1" },
    ]);
  });

  it("keeps admission numbers unique and skips numbers already in use", async () => {
    const s = await school();
    await createStudent(conn.app, s.head, { ...ama, admissionNumber: "0001" });
    const auto = await createStudent(conn.app, s.head, {
      firstName: "Kojo",
      lastName: "Asante",
      sex: "male",
    });
    expect(auto.admissionNumber).toBe("0002");
    await expect(createStudent(conn.app, s.head, { ...ama, admissionNumber: "0002" })).rejects.toMatchObject({
      field: "admissionNumber",
    });
  });

  it("validates input and needs a current term to place a student", async () => {
    const s = await school({ withTerm: false });
    await expect(createStudent(conn.app, s.head, { ...ama, sex: "x" })).rejects.toThrow();
    await expect(createStudent(conn.app, s.head, { ...ama, dateOfBirth: "2999-01-01" })).rejects.toThrow();
    await expect(createStudent(conn.app, s.head, { ...ama, classId: s.classA })).rejects.toMatchObject({
      code: "no_current_term",
    });
  });

  it("searches by name or admission number and filters by class, with pagination totals", async () => {
    const s = await school();
    await createStudent(conn.app, s.head, { ...ama, classId: s.classA });
    await createStudent(conn.app, s.head, {
      firstName: "Kwame",
      lastName: "Boateng",
      sex: "male",
      classId: s.classB,
    });
    await createStudent(conn.app, s.head, { firstName: "Efua", lastName: "Mensah", sex: "female" });
    expect((await listStudents(conn.app, s.head, { q: "mensah" })).rows.map((r) => r.fullName)).toEqual([
      "Ama Serwaa Mensah",
      "Efua Mensah",
    ]);
    expect((await listStudents(conn.app, s.head, { q: "ama mensah" })).total).toBe(1);
    expect((await listStudents(conn.app, s.head, { q: "0002" })).rows[0]!.fullName).toBe("Kwame Boateng");
    expect(
      (await listStudents(conn.app, s.head, { classId: s.classB })).rows.map((r) => r.className),
    ).toEqual(["Basic 2"]);
    expect((await listStudents(conn.app, s.head, { classId: "none" })).rows.map((r) => r.fullName)).toEqual([
      "Efua Mensah",
    ]);
    const all = await listStudents(conn.app, s.head);
    expect([all.total, all.termName]).toEqual([3, "Term 1, 2026/2027"]);
    expect((await listStudents(conn.app, s.head, { q: "100%_" })).total).toBe(0);
  });

  it("shows teachers only the students in classes they teach; accountants see everyone", async () => {
    const s = await school();
    const inA = await createStudent(conn.app, s.head, { ...ama, classId: s.classA });
    const inB = await createStudent(conn.app, s.head, {
      firstName: "Kwame",
      lastName: "Boateng",
      sex: "male",
      classId: s.classB,
    });
    expect((await listStudents(conn.app, s.teacher)).rows.map((r) => r.id)).toEqual([inA.id]);
    expect(await getStudent(conn.app, s.teacher, inB.id)).toBeNull();
    expect(await getStudent(conn.app, s.teacher, inA.id)).not.toBeNull();
    expect((await listStudents(conn.app, s.other)).total).toBe(0);
    expect((await listStudents(conn.app, s.bursar)).total).toBe(2);
    await expect(createStudent(conn.app, s.teacher, ama)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createStudent(conn.app, s.bursar, ama)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("edits details, moves classes and withdraws with an audit trail", async () => {
    const s = await school();
    const { id } = await createStudent(conn.app, s.head, { ...ama, classId: s.classA });
    await updateStudent(conn.app, s.head, id, { ...ama, lastName: "Mensah-Bonsu", admissionNumber: "" });
    await assignClass(conn.app, s.head, id, s.classB);
    let detail = await getStudent(conn.app, s.head, id);
    expect(detail).toMatchObject({
      lastName: "Mensah-Bonsu",
      admissionNumber: "0001",
      currentClass: { name: "Basic 2" },
    });
    await setStudentStatus(conn.app, s.head, id, "withdrawn");
    detail = await getStudent(conn.app, s.head, id);
    expect(detail).toMatchObject({ status: "withdrawn", currentClass: null });
    expect((await listStudents(conn.app, s.head)).total).toBe(0);
    expect((await listStudents(conn.app, s.head, { status: "withdrawn" })).total).toBe(1);
    await expect(assignClass(conn.app, s.head, id, s.classA)).rejects.toMatchObject({
      code: "student_inactive",
    });
  });

  it("cannot see or change another school's students", async () => {
    const a = await school();
    const b = await school();
    const { id } = await createStudent(conn.app, a.head, ama);
    expect(await getStudent(conn.app, b.head, id)).toBeNull();
    await expect(updateStudent(conn.app, b.head, id, ama)).rejects.toMatchObject({
      code: "student_not_found",
    });
    await expect(assignClass(conn.app, a.head, id, b.classA)).rejects.toMatchObject({
      code: "class_invalid",
    });
  });
});
