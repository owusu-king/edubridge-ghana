import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import {
  createClass,
  createLevel,
  listLevelsWithClasses,
  listTeacherOptions,
  renameLevel,
  setClassStatus,
  setupDefaultLevels,
  updateClass,
} from "@/server/academics/classes";
import { withTenant } from "@/server/db/context";
import { campuses, membershipCampuses } from "@/server/db/schema";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const head = await createUser(conn.owner, "Head");
  const teacher = await createUser(conn.owner, "Ama Teacher");
  const parent = await createUser(conn.owner, "A Parent");
  await addMember(conn.owner, tenant.id, head.id, ["headteacher"]);
  const teacherM = await addMember(conn.owner, tenant.id, teacher.id, ["teacher"]);
  const parentM = await addMember(conn.owner, tenant.id, parent.id, ["parent"]);
  const [main, east] = await withTenant(conn.owner, { tenantId: tenant.id, userId: head.id }, (tx) =>
    tx
      .insert(campuses)
      .values([
        { tenantId: tenant.id, name: "Main" },
        { tenantId: tenant.id, name: "East" },
      ])
      .returning(),
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  return {
    tenant,
    head: await ctx(head.id),
    teacher: await ctx(teacher.id),
    teacherM,
    parentM,
    main: main!,
    east: east!,
    ctx,
    ids: { head, teacher },
  };
}

describe("levels", () => {
  it("sets up Ghanaian default levels in promotion order, once", async () => {
    const s = await school();
    expect(await setupDefaultLevels(conn.app, s.head, { stages: ["kindergarten", "primary", "jhs"] })).toBe(
      11,
    );
    const names = (await listLevelsWithClasses(conn.app, s.head)).map((l) => l.name);
    expect(names).toEqual([
      "KG 1",
      "KG 2",
      "Basic 1",
      "Basic 2",
      "Basic 3",
      "Basic 4",
      "Basic 5",
      "Basic 6",
      "JHS 1",
      "JHS 2",
      "JHS 3",
    ]);
    await expect(setupDefaultLevels(conn.app, s.head, { stages: ["creche"] })).rejects.toMatchObject({
      code: "levels_exist",
    });
  });

  it("adds a level after its stage and renames with unique names", async () => {
    const s = await school();
    await setupDefaultLevels(conn.app, s.head, { stages: ["nursery", "primary"] });
    await createLevel(conn.app, s.head, { name: "Nursery 3", stage: "nursery" });
    const names = (await listLevelsWithClasses(conn.app, s.head)).map((l) => l.name);
    expect(names.slice(0, 4)).toEqual(["Nursery 1", "Nursery 2", "Nursery 3", "Basic 1"]);
    const basic1 = (await listLevelsWithClasses(conn.app, s.head)).find((l) => l.name === "Basic 1")!;
    await renameLevel(conn.app, s.head, basic1.id, { name: "Primary 1" });
    await expect(renameLevel(conn.app, s.head, basic1.id, { name: "basic 2" })).rejects.toMatchObject({
      field: "name",
    });
  });
});

describe("classes", () => {
  it("creates classes with a class teacher and lists them under their level", async () => {
    const s = await school();
    await setupDefaultLevels(conn.app, s.head, { stages: ["primary"] });
    const [basic1] = await listLevelsWithClasses(conn.app, s.head);
    const options = await listTeacherOptions(conn.app, s.head);
    expect(options.map((o) => o.name)).toEqual(["Ama Teacher", "Head"]);
    await createClass(conn.app, s.head, {
      levelId: basic1!.id,
      campusId: s.main.id,
      name: "Basic 1A",
      classTeacherMembershipId: s.teacherM.id,
    });
    await createClass(conn.app, s.head, {
      levelId: basic1!.id,
      campusId: s.main.id,
      name: "Basic 1B",
      classTeacherMembershipId: "",
    });
    const [level] = await listLevelsWithClasses(conn.app, s.head);
    expect(level!.classes.map((c) => [c.name, c.classTeacher?.name ?? null])).toEqual([
      ["Basic 1A", "Ama Teacher"],
      ["Basic 1B", null],
    ]);
    await expect(
      createClass(conn.app, s.head, { levelId: basic1!.id, campusId: s.main.id, name: "basic 1a" }),
    ).rejects.toMatchObject({ field: "name" });
    // The same name at another campus is fine.
    await expect(
      createClass(conn.app, s.head, { levelId: basic1!.id, campusId: s.east.id, name: "Basic 1A" }),
    ).resolves.toBeTruthy();
  });

  it("refuses non-staff class teachers and levels or campuses of other schools", async () => {
    const s = await school();
    const other = await school();
    await setupDefaultLevels(conn.app, s.head, { stages: ["primary"] });
    await setupDefaultLevels(conn.app, other.head, { stages: ["primary"] });
    const [level] = await listLevelsWithClasses(conn.app, s.head);
    const [foreignLevel] = await listLevelsWithClasses(conn.app, other.head);
    await expect(
      createClass(conn.app, s.head, {
        levelId: level!.id,
        campusId: s.main.id,
        name: "X",
        classTeacherMembershipId: s.parentM.id,
      }),
    ).rejects.toMatchObject({ code: "teacher_invalid" });
    await expect(
      createClass(conn.app, s.head, { levelId: foreignLevel!.id, campusId: s.main.id, name: "X" }),
    ).rejects.toMatchObject({ code: "level_invalid" });
    await expect(
      createClass(conn.app, s.head, { levelId: level!.id, campusId: other.main.id, name: "X" }),
    ).rejects.toMatchObject({ code: "campus_invalid" });
  });

  it("renames, changes teacher, archives and restores", async () => {
    const s = await school();
    await setupDefaultLevels(conn.app, s.head, { stages: ["jhs"] });
    const [jhs1] = await listLevelsWithClasses(conn.app, s.head);
    const id = await createClass(conn.app, s.head, { levelId: jhs1!.id, campusId: s.main.id, name: "JHS 1" });
    await updateClass(conn.app, s.head, id, { name: "JHS 1 Gold", classTeacherMembershipId: s.teacherM.id });
    await setClassStatus(conn.app, s.head, id, "archived");
    let [level] = await listLevelsWithClasses(conn.app, s.head);
    expect(level!.classes[0]).toMatchObject({
      name: "JHS 1 Gold",
      status: "archived",
      classTeacher: { name: "Ama Teacher" },
    });
    await setClassStatus(conn.app, s.head, id, "active");
    [level] = await listLevelsWithClasses(conn.app, s.head);
    expect(level!.classes[0]!.status).toBe("active");
  });

  it("lets teachers view but not manage; campus-scoped staff see only their campuses", async () => {
    const s = await school();
    await setupDefaultLevels(conn.app, s.head, { stages: ["primary"] });
    const [b1] = await listLevelsWithClasses(conn.app, s.head);
    await createClass(conn.app, s.head, { levelId: b1!.id, campusId: s.main.id, name: "Main 1" });
    await createClass(conn.app, s.head, { levelId: b1!.id, campusId: s.east.id, name: "East 1" });
    await expect(
      createClass(conn.app, s.teacher, { levelId: b1!.id, campusId: s.main.id, name: "T" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.ids.head.id }, (tx) =>
      tx
        .insert(membershipCampuses)
        .values({ tenantId: s.tenant.id, membershipId: s.teacherM.id, campusId: s.east.id }),
    );
    const scoped = await s.ctx(s.ids.teacher.id);
    const [level] = await listLevelsWithClasses(conn.app, scoped);
    expect(level!.classes.map((c) => c.name)).toEqual(["East 1"]);
  });
});
