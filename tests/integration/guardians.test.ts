import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses } from "@/server/db/schema";
import {
  addGuardian,
  listGuardians,
  setPrimaryGuardian,
  unlinkGuardian,
  updateGuardian,
} from "@/server/students/guardians";
import { createStudent, listStudents } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const admin = await createUser(conn.owner);
  const teacher = await createUser(conn.owner);
  await addMember(conn.owner, tenant.id, admin.id, ["admin"]);
  const teacherM = await addMember(conn.owner, tenant.id, teacher.id, ["teacher"]);
  const [campus] = await withTenant(conn.owner, { tenantId: tenant.id, userId: admin.id }, (tx) =>
    tx.insert(campuses).values({ tenantId: tenant.id, name: "Main" }).returning(),
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  const adminCtx = await ctx(admin.id);
  await setupDefaultLevels(conn.app, adminCtx, { stages: ["primary"] });
  const [b1, b2] = await listLevelsWithClasses(conn.app, adminCtx);
  const classA = await createClass(conn.app, adminCtx, {
    levelId: b1!.id,
    campusId: campus!.id,
    name: "Basic 1",
    classTeacherMembershipId: teacherM.id,
  });
  const classB = await createClass(conn.app, adminCtx, {
    levelId: b2!.id,
    campusId: campus!.id,
    name: "Basic 2",
  });
  await createAcademicYear(conn.app, adminCtx, {
    name: "2026/2027",
    terms: [{ name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" }],
  });
  await setCurrentTerm(conn.app, adminCtx, (await listAcademicYears(conn.app, adminCtx))[0]!.terms[0]!.id);
  const kofi = await createStudent(conn.app, adminCtx, {
    firstName: "Kofi",
    lastName: "Owusu",
    sex: "male",
    classId: classA,
  });
  const ama = await createStudent(conn.app, adminCtx, {
    firstName: "Ama",
    lastName: "Owusu",
    sex: "female",
    classId: classB,
  });
  return { admin: adminCtx, teacher: await ctx(teacher.id), kofi, ama };
}

const mother = { fullName: "Akosua Owusu", phone: "024 555 0101", relationship: "mother", isPrimary: false };

describe("guardians", () => {
  it("adds a guardian with a normalised phone; the first guardian is primary", async () => {
    const s = await school();
    await addGuardian(conn.app, s.admin, s.kofi.id, mother);
    await addGuardian(conn.app, s.admin, s.kofi.id, {
      fullName: "Kwabena Owusu",
      email: "kwabena@example.test",
      relationship: "father",
    });
    const links = await listGuardians(conn.app, s.admin, s.kofi.id);
    expect(links!.map((l) => [l.fullName, l.phone, l.isPrimary])).toEqual([
      ["Akosua Owusu", "+233245550101", true],
      ["Kwabena Owusu", null, false],
    ]);
  });

  it("links siblings through a shared phone number, keeping the existing record", async () => {
    const s = await school();
    await addGuardian(conn.app, s.admin, s.kofi.id, mother);
    const second = await addGuardian(conn.app, s.admin, s.ama.id, {
      ...mother,
      fullName: "Different Spelling",
      phone: "+233245550101",
    });
    expect(second.linkedExisting).toBe(true);
    const amaGuardians = await listGuardians(conn.app, s.admin, s.ama.id);
    expect(amaGuardians![0]).toMatchObject({
      fullName: "Akosua Owusu",
      otherStudents: [{ name: "Kofi Owusu", className: "Basic 1" }],
    });
    await expect(addGuardian(conn.app, s.admin, s.ama.id, mother)).rejects.toMatchObject({
      code: "already_linked",
    });
  });

  it("requires a phone or email and validates them", async () => {
    const s = await school();
    await expect(
      addGuardian(conn.app, s.admin, s.kofi.id, { fullName: "No Contact", relationship: "guardian" }),
    ).rejects.toThrow();
    await expect(addGuardian(conn.app, s.admin, s.kofi.id, { ...mother, phone: "12345" })).rejects.toThrow();
    await expect(
      addGuardian(conn.app, s.admin, s.kofi.id, { ...mother, relationship: "aunt" }),
    ).rejects.toThrow();
  });

  it("switches the primary contact and promotes another when the primary is removed", async () => {
    const s = await school();
    const m = await addGuardian(conn.app, s.admin, s.kofi.id, mother);
    const f = await addGuardian(conn.app, s.admin, s.kofi.id, {
      fullName: "Kwabena Owusu",
      phone: "0205550102",
      relationship: "father",
    });
    await setPrimaryGuardian(conn.app, s.admin, s.kofi.id, f.guardianId);
    let links = await listGuardians(conn.app, s.admin, s.kofi.id);
    expect(links!.filter((l) => l.isPrimary).map((l) => l.fullName)).toEqual(["Kwabena Owusu"]);
    await unlinkGuardian(conn.app, s.admin, s.kofi.id, f.guardianId);
    links = await listGuardians(conn.app, s.admin, s.kofi.id);
    expect(links!.map((l) => [l.guardianId, l.isPrimary])).toEqual([[m.guardianId, true]]);
  });

  it("updates a guardian for all their children and keeps phone numbers unique per school", async () => {
    const s = await school();
    const m = await addGuardian(conn.app, s.admin, s.kofi.id, mother);
    await addGuardian(conn.app, s.admin, s.ama.id, mother);
    await addGuardian(conn.app, s.admin, s.ama.id, {
      fullName: "Kwabena Owusu",
      phone: "0205550102",
      relationship: "father",
    });
    await updateGuardian(conn.app, s.admin, m.guardianId, {
      fullName: "Akosua Owusu-Mensah",
      phone: "0245550101",
    });
    expect((await listGuardians(conn.app, s.admin, s.ama.id))![0]!.fullName).toBe("Akosua Owusu-Mensah");
    await expect(
      updateGuardian(conn.app, s.admin, m.guardianId, { fullName: "Akosua", phone: "0205550102" }),
    ).rejects.toMatchObject({
      code: "phone_taken",
    });
  });

  it("shows guardians only to staff who can see the student; only managers can change them", async () => {
    const s = await school();
    await addGuardian(conn.app, s.admin, s.kofi.id, mother);
    await addGuardian(conn.app, s.admin, s.ama.id, mother);
    expect(await listGuardians(conn.app, s.teacher, s.kofi.id)).toHaveLength(1);
    expect(await listGuardians(conn.app, s.teacher, s.ama.id)).toBeNull();
    await expect(addGuardian(conn.app, s.teacher, s.kofi.id, mother)).rejects.toBeInstanceOf(ForbiddenError);
    const other = await school();
    expect(await listGuardians(conn.app, other.admin, s.kofi.id)).toBeNull();
  });

  it("caps the number of guardians per student", async () => {
    const s = await school();
    for (let i = 0; i < 4; i++)
      await addGuardian(conn.app, s.admin, s.kofi.id, {
        fullName: `Guardian ${i}`,
        phone: `024555020${i}`,
        relationship: "guardian",
      });
    await expect(
      addGuardian(conn.app, s.admin, s.kofi.id, {
        fullName: "Fifth",
        phone: "0245550209",
        relationship: "guardian",
      }),
    ).rejects.toMatchObject({
      code: "too_many_guardians",
    });
  });
});

describe("adding a student with a guardian", () => {
  it("saves both together, or neither", async () => {
    const s = await school();
    const created = await createStudent(conn.app, s.admin, {
      firstName: "Esi",
      lastName: "Owusu",
      sex: "female",
      guardian: { ...mother, isPrimary: "on" },
    });
    const links = await listGuardians(conn.app, s.admin, created.id);
    expect(links!.map((l) => [l.fullName, l.isPrimary])).toEqual([["Akosua Owusu", true]]);

    const before = (await listStudents(conn.app, s.admin)).total;
    await expect(
      createStudent(conn.app, s.admin, {
        firstName: "Bad",
        lastName: "Guardian",
        sex: "male",
        guardian: { ...mother, phone: "123" },
      }),
    ).rejects.toThrow();
    expect((await listStudents(conn.app, s.admin)).total).toBe(before);
  });

  it("lists each student's primary contact", async () => {
    const s = await school();
    await addGuardian(conn.app, s.admin, s.kofi.id, mother);
    const row = (await listStudents(conn.app, s.admin, { q: "Kofi" })).rows[0]!;
    expect(row.primaryContact).toEqual({ name: "Akosua Owusu", phone: "+233245550101" });
  });
});
