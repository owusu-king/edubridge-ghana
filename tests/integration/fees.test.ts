import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears } from "@/server/academics/calendar";
import {
  createClass,
  listLevelsWithClasses,
  setClassStatus,
  setupDefaultLevels,
} from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, campuses, membershipCampuses } from "@/server/db/schema";
import {
  copyFeeStructure,
  createFeeItem,
  getFeeStructure,
  listFeeItems,
  listFeeTerms,
  renameFeeItem,
  saveLevelFees,
  setFeeItemStatus,
  setupFeeItems,
} from "@/server/fees/structure";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { eq } from "drizzle-orm";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const people = {
    owner: await createUser(conn.owner, "Proprietor"),
    head: await createUser(conn.owner, "Head"),
    bursar: await createUser(conn.owner, "Accountant"),
    teacher: await createUser(conn.owner, "Teacher"),
    campusBursar: await createUser(conn.owner, "Campus Accountant"),
  };
  await addMember(conn.owner, tenant.id, people.owner.id, ["owner"]);
  await addMember(conn.owner, tenant.id, people.head.id, ["headteacher"]);
  await addMember(conn.owner, tenant.id, people.bursar.id, ["bursar"]);
  await addMember(conn.owner, tenant.id, people.teacher.id, ["teacher"]);
  const campusM = await addMember(conn.owner, tenant.id, people.campusBursar.id, ["bursar"]);
  const [campus] = await withTenant(
    conn.owner,
    { tenantId: tenant.id, userId: people.owner.id },
    async (tx) => {
      const rows = await tx.insert(campuses).values({ tenantId: tenant.id, name: "Main" }).returning();
      await tx
        .insert(membershipCampuses)
        .values({ tenantId: tenant.id, membershipId: campusM.id, campusId: rows[0]!.id });
      return rows;
    },
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  const owner = await ctx(people.owner.id);
  await setupDefaultLevels(conn.app, owner, { stages: ["primary"] });
  await createAcademicYear(conn.app, owner, {
    name: "2026/2027",
    terms: [
      { name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" },
      { name: "Term 2", startsOn: "2027-01-11", endsOn: "2027-04-09" },
    ],
  });
  const levels = await listLevelsWithClasses(conn.app, owner);
  const basic4 = levels.find((l) => l.name === "Basic 4")!;
  const classA = await createClass(conn.app, owner, {
    levelId: basic4.id,
    campusId: campus!.id,
    name: "Basic 4A",
  });
  const classB = await createClass(conn.app, owner, {
    levelId: basic4.id,
    campusId: campus!.id,
    name: "Basic 4B",
  });
  const [y] = await listAcademicYears(conn.app, owner);
  return {
    tenant,
    owner,
    head: await ctx(people.head.id),
    bursar: await ctx(people.bursar.id),
    teacher: await ctx(people.teacher.id),
    campusBursar: await ctx(people.campusBursar.id),
    basic4,
    basic1: levels.find((l) => l.name === "Basic 1")!,
    classA,
    classB,
    term1: y!.terms[0]!.id,
    term2: y!.terms[1]!.id,
  };
}

async function itemIds(s: Awaited<ReturnType<typeof school>>) {
  await setupFeeItems(conn.app, s.bursar, { names: ["Tuition", "PTA dues", "ICT"] });
  const items = await listFeeItems(conn.app, s.bursar);
  const id = (name: string) => items.find((i) => i.name === name)!.id;
  return { tuition: id("Tuition"), pta: id("PTA dues"), ict: id("ICT") };
}

describe("fee items", () => {
  it("sets up suggested items once, then adds, renames and archives", async () => {
    const s = await school();
    expect(await setupFeeItems(conn.app, s.bursar, { names: ["Tuition", "PTA dues"] })).toBe(2);
    await expect(setupFeeItems(conn.app, s.bursar, { names: ["ICT"] })).rejects.toMatchObject({
      code: "items_exist",
    });
    const transport = await createFeeItem(conn.app, s.owner, { name: "Transport" });
    await expect(createFeeItem(conn.app, s.owner, { name: "tuition" })).rejects.toMatchObject({
      code: "duplicate",
      field: "name",
    });
    await renameFeeItem(conn.app, s.bursar, transport, { name: "School bus" });
    await setFeeItemStatus(conn.app, s.bursar, transport, "archived");
    expect(await listFeeItems(conn.app, s.head)).toEqual([
      expect.objectContaining({ name: "Tuition", status: "active" }),
      expect.objectContaining({ name: "PTA dues", status: "active" }),
      expect.objectContaining({ name: "School bus", status: "archived" }),
    ]);
  });

  it("lets the head teacher look but not change, and keeps teachers out", async () => {
    const s = await school();
    await expect(createFeeItem(conn.app, s.head, { name: "Tuition" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listFeeItems(conn.app, s.teacher)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getFeeStructure(conn.app, s.teacher, s.term1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses changes from an accountant limited to one campus", async () => {
    const s = await school();
    await expect(createFeeItem(conn.app, s.campusBursar, { name: "Tuition" })).rejects.toMatchObject({
      code: "campus_restricted",
    });
    expect(await listFeeItems(conn.app, s.campusBursar)).toEqual([]);
  });
});

describe("fee structure", () => {
  it("saves a level's amounts with class overrides and resolves class totals", async () => {
    const s = await school();
    const ids = await itemIds(s);
    await saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
      amounts: { [ids.tuition]: "850", [ids.pta]: "50.00", [ids.ict]: "" },
      classAmounts: {
        [s.classA]: { [ids.tuition]: "", [ids.pta]: "", [ids.ict]: "" },
        [s.classB]: { [ids.tuition]: "900.50", [ids.pta]: "0", [ids.ict]: "60" },
      },
    });
    const structure = await getFeeStructure(conn.app, s.head, s.term1);
    const level = structure.levels.find((l) => l.id === s.basic4.id)!;
    expect(level.amounts).toEqual({ [ids.tuition]: 85000, [ids.pta]: 5000 });
    expect(level.total).toBe(90000);
    expect(level.classAmounts[s.classB]).toEqual({ [ids.tuition]: 90050, [ids.pta]: 0, [ids.ict]: 6000 });
    expect(level.classes).toEqual([
      { id: s.classA, name: "Basic 4A", total: null },
      { id: s.classB, name: "Basic 4B", total: 96050 },
    ]);
    // Term 2 is untouched.
    const term2 = await getFeeStructure(conn.app, s.head, s.term2);
    expect(term2.levels.every((l) => Object.keys(l.amounts).length === 0)).toBe(true);
  });

  it("replaces amounts on save and records an audit event in cedis", async () => {
    const s = await school();
    const ids = await itemIds(s);
    const save = (tuition: string) =>
      saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
        amounts: { [ids.tuition]: tuition },
        classAmounts: {},
      });
    await save("850");
    await save("875.25");
    const level = (await getFeeStructure(conn.app, s.owner, s.term1)).levels.find(
      (l) => l.id === s.basic4.id,
    )!;
    expect(level.amounts).toEqual({ [ids.tuition]: 87525 });
    const events = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "fees.structure_updated")),
    );
    expect(events.filter((e) => e.tenantId === s.tenant.id).map((e) => e.metadata.totalPesewas)).toEqual(
      expect.arrayContaining([85000, 87525]),
    );
  });

  it("rejects invalid amounts on the exact field, and foreign items or classes", async () => {
    const s = await school();
    const ids = await itemIds(s);
    await expect(
      saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
        amounts: { [ids.tuition]: "85O" },
        classAmounts: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_amount", field: `amount:${ids.tuition}` });
    await expect(
      saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
        amounts: {},
        classAmounts: { [s.classB]: { [ids.pta]: "-5" } },
      }),
    ).rejects.toMatchObject({ code: "invalid_amount", field: `class:${s.classB}:${ids.pta}` });
    // A class from another level.
    await expect(
      saveLevelFees(conn.app, s.bursar, s.term1, s.basic1.id, {
        amounts: {},
        classAmounts: { [s.classA]: { [ids.pta]: "5" } },
      }),
    ).rejects.toMatchObject({ code: "unknown_class" });
    // An item from another school.
    const other = await school();
    const otherIds = await itemIds(other);
    await expect(
      saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
        amounts: { [otherIds.tuition]: "5" },
        classAmounts: {},
      }),
    ).rejects.toMatchObject({ code: "unknown_item" });
    // Another school's term or level is invisible.
    await expect(
      saveLevelFees(conn.app, s.bursar, other.term1, s.basic4.id, { amounts: {}, classAmounts: {} }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps amounts for archived items and classes when a level is saved", async () => {
    const s = await school();
    const ids = await itemIds(s);
    await saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
      amounts: { [ids.tuition]: "850", [ids.ict]: "60" },
      classAmounts: { [s.classB]: { [ids.tuition]: "900" } },
    });
    await setFeeItemStatus(conn.app, s.bursar, ids.ict, "archived");
    await setClassStatus(conn.app, s.owner, s.classB, "archived");
    await saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
      amounts: { [ids.tuition]: "800" },
      classAmounts: {},
    });
    const structure = await getFeeStructure(conn.app, s.bursar, s.term1);
    const level = structure.levels.find((l) => l.id === s.basic4.id)!;
    expect(level.amounts).toEqual({ [ids.tuition]: 80000, [ids.ict]: 6000 });
    expect(level.classAmounts[s.classB]).toEqual({ [ids.tuition]: 90000 });
    // The archived item still shows because this term uses it.
    expect(structure.items.map((i) => i.id)).toContain(ids.ict);
    expect((await getFeeStructure(conn.app, s.bursar, s.term2)).items.map((i) => i.id)).not.toContain(
      ids.ict,
    );
  });

  it("copies a structure into an empty term only, skipping archived items", async () => {
    const s = await school();
    const ids = await itemIds(s);
    await saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
      amounts: { [ids.tuition]: "850", [ids.pta]: "50", [ids.ict]: "60" },
      classAmounts: { [s.classB]: { [ids.tuition]: "900" } },
    });
    await setFeeItemStatus(conn.app, s.bursar, ids.ict, "archived");
    await expect(
      copyFeeStructure(conn.app, s.bursar, { fromTermId: s.term2, toTermId: s.term1 }),
    ).rejects.toMatchObject({ code: "structure_exists" });
    expect(await copyFeeStructure(conn.app, s.bursar, { fromTermId: s.term1, toTermId: s.term2 })).toBe(3);
    const level = (await getFeeStructure(conn.app, s.bursar, s.term2)).levels.find(
      (l) => l.id === s.basic4.id,
    )!;
    expect(level.amounts).toEqual({ [ids.tuition]: 85000, [ids.pta]: 5000 });
    expect(level.classAmounts[s.classB]).toEqual({ [ids.tuition]: 90000 });
    await expect(
      copyFeeStructure(conn.app, s.bursar, { fromTermId: s.term1, toTermId: s.term2 }),
    ).rejects.toMatchObject({ code: "structure_exists" });
    const terms = await listFeeTerms(conn.app, s.head);
    expect(terms.map((t) => [t.name, t.lineCount])).toEqual([
      ["Term 2", 3],
      ["Term 1", 4],
    ]);
  });

  it("refuses to copy from an empty term", async () => {
    const s = await school();
    await itemIds(s);
    await expect(
      copyFeeStructure(conn.app, s.bursar, { fromTermId: s.term2, toTermId: s.term1 }),
    ).rejects.toMatchObject({ code: "structure_empty", field: "fromTermId" });
  });

  it("rejects amounts above GH₵10,000,000", async () => {
    const s = await school();
    const ids = await itemIds(s);
    await expect(
      saveLevelFees(conn.app, s.bursar, s.term1, s.basic4.id, {
        amounts: { [ids.tuition]: "10000000.01" },
        classAmounts: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });
});
