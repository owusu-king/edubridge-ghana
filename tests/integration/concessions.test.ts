import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses, membershipCampuses } from "@/server/db/schema";
import {
  addConcession,
  endConcession,
  formatPercent,
  listConcessions,
  listFamilies,
  parsePercent,
} from "@/server/fees/concessions";
import { billTerm, getBillingStatus, getStudentAccount, reverseEntry } from "@/server/fees/ledger";
import { listFeeItems, saveLevelFees, setupFeeItems } from "@/server/fees/structure";
import { addGuardian } from "@/server/students/guardians";
import { createStudent } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const people = {
    owner: await createUser(conn.owner, "Proprietor"),
    head: await createUser(conn.owner, "Head"),
    bursar: await createUser(conn.owner, "Accountant"),
    eastBursar: await createUser(conn.owner, "East Accountant"),
  };
  await addMember(conn.owner, tenant.id, people.owner.id, ["owner"]);
  await addMember(conn.owner, tenant.id, people.head.id, ["headteacher"]);
  await addMember(conn.owner, tenant.id, people.bursar.id, ["bursar"]);
  const eastM = await addMember(conn.owner, tenant.id, people.eastBursar.id, ["bursar"]);
  const [main, east] = await withTenant(
    conn.owner,
    { tenantId: tenant.id, userId: people.owner.id },
    async (tx) => {
      const rows = await tx
        .insert(campuses)
        .values([
          { tenantId: tenant.id, name: "Main" },
          { tenantId: tenant.id, name: "East" },
        ])
        .returning();
      await tx
        .insert(membershipCampuses)
        .values({ tenantId: tenant.id, membershipId: eastM.id, campusId: rows[1]!.id });
      return rows;
    },
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  const owner = await ctx(people.owner.id);
  const bursar = await ctx(people.bursar.id);
  await setupDefaultLevels(conn.app, owner, { stages: ["primary"] });
  await createAcademicYear(conn.app, owner, {
    name: "2026/2027",
    terms: [{ name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" }],
  });
  const [y] = await listAcademicYears(conn.app, owner);
  const term1 = y!.terms[0]!.id;
  await setCurrentTerm(conn.app, owner, term1);
  const basic4 = (await listLevelsWithClasses(conn.app, owner)).find((l) => l.name === "Basic 4")!;
  const classA = await createClass(conn.app, owner, {
    levelId: basic4.id,
    campusId: main!.id,
    name: "Basic 4A",
  });
  const classB = await createClass(conn.app, owner, {
    levelId: basic4.id,
    campusId: east!.id,
    name: "Basic 4B",
  });
  await setupFeeItems(conn.app, bursar, { names: ["Tuition", "PTA dues"] });
  const items = await listFeeItems(conn.app, bursar);
  const tuition = items.find((i) => i.name === "Tuition")!.id;
  const pta = items.find((i) => i.name === "PTA dues")!.id;
  await saveLevelFees(conn.app, bursar, term1, basic4.id, {
    amounts: { [tuition]: "850", [pta]: "50" },
    classAmounts: {},
  });
  const add = (firstName: string, classId: string) =>
    createStudent(conn.app, owner, { firstName, lastName: "Mensah", sex: "female", classId });
  return {
    owner,
    bursar,
    head: await ctx(people.head.id),
    eastBursar: await ctx(people.eastBursar.id),
    term1,
    classA,
    classB,
    tuition,
    pta,
    add,
  };
}

type School = Awaited<ReturnType<typeof school>>;
const account = async (s: School, id: string) => (await getStudentAccount(conn.app, s.bursar, id))!;

describe("percent helpers", () => {
  it("parses and formats percentages as basis points", () => {
    expect(parsePercent("10")).toBe(1000);
    expect(parsePercent("12.5%")).toBe(1250);
    expect(parsePercent("0.05")).toBe(5);
    expect(parsePercent("100")).toBe(10000);
    for (const bad of ["0", "100.01", "abc", "-5", "1.234"]) expect(parsePercent(bad)).toBeNull();
    expect([1000, 1250, 1205, 5, 10000].map(formatPercent)).toEqual([
      "10%",
      "12.5%",
      "12.05%",
      "0.05%",
      "100%",
    ]);
  });
});

describe("concessions at billing", () => {
  it("applies scholarships as separate discount entries when the term is billed", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const kofi = await s.add("Kofi", s.classA);
    await addConcession(conn.app, s.bursar, ama.id, {
      label: "Academic scholarship",
      feeItemId: s.tuition,
      kind: "percent",
      value: "50",
    });
    await addConcession(conn.app, s.owner, kofi.id, {
      label: "Staff child",
      feeItemId: "",
      kind: "percent",
      value: "10",
    });

    expect(await getBillingStatus(conn.app, s.head, s.term1)).toMatchObject({
      chargesToCreate: 4,
      discountsToCreate: 3,
      discountsPesewas: 42500 + 8500 + 500,
      amountToBillPesewas: 180000 - 51500,
    });
    await billTerm(conn.app, s.bursar, s.term1);
    const amaAccount = await account(s, ama.id);
    expect(amaAccount.entries.map((e) => [e.kind, e.description, e.amountPesewas])).toEqual([
      ["charge", "Tuition, Term 1 2026/2027", 85000],
      ["charge", "PTA dues, Term 1 2026/2027", 5000],
      ["discount", "Academic scholarship on Tuition, Term 1 2026/2027", -42500],
    ]);
    expect(amaAccount.balancePesewas).toBe(47500);
    expect((await account(s, kofi.id)).balancePesewas).toBe(90000 - 9000);
  });

  it("applies a concession added after billing on the next run, once", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    await addConcession(conn.app, s.bursar, ama.id, {
      label: "Bursary",
      feeItemId: s.tuition,
      kind: "amount",
      value: "200",
    });
    expect(await getBillingStatus(conn.app, s.bursar, s.term1)).toMatchObject({
      chargesToCreate: 0,
      discountsToCreate: 1,
      studentsToBill: 1,
      amountToBillPesewas: -20000,
    });
    await billTerm(conn.app, s.bursar, s.term1);
    expect((await account(s, ama.id)).balancePesewas).toBe(70000);
    await expect(billTerm(conn.app, s.bursar, s.term1)).rejects.toMatchObject({ code: "nothing_to_bill" });
  });

  it("never discounts more than the charge, and keeps billed discounts when a concession ends", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const full = await addConcession(conn.app, s.bursar, ama.id, {
      label: "Full scholarship",
      feeItemId: "",
      kind: "percent",
      value: "100",
    });
    await addConcession(conn.app, s.bursar, ama.id, {
      label: "Bursary",
      feeItemId: s.pta,
      kind: "amount",
      value: "30",
    });
    await billTerm(conn.app, s.bursar, s.term1);
    expect((await account(s, ama.id)).balancePesewas).toBe(0);
    await endConcession(conn.app, s.bursar, full);
    expect((await account(s, ama.id)).balancePesewas).toBe(0);
    expect((await listConcessions(conn.app, s.head, ama.id)).map((c) => [c.label, c.status])).toEqual([
      ["Bursary", "active"],
      ["Full scholarship", "ended"],
    ]);
    // A discount reversed on purpose is not re-applied by billing.
    const discount = (await account(s, ama.id)).entries.find((e) =>
      e.description.startsWith("Full scholarship on Tuition"),
    )!;
    await reverseEntry(conn.app, s.bursar, discount.id, { reason: "Scholarship withdrawn" });
    await expect(billTerm(conn.app, s.bursar, s.term1)).rejects.toMatchObject({ code: "nothing_to_bill" });
    expect((await account(s, ama.id)).balancePesewas).toBe(85000);
  });

  it("validates concessions and limits who may add them", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const efua = await s.add("Efua", s.classB);
    await expect(
      addConcession(conn.app, s.bursar, ama.id, {
        label: "Bursary",
        feeItemId: "",
        kind: "amount",
        value: "50",
      }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ["feeItemId"] })] });
    await expect(
      addConcession(conn.app, s.bursar, ama.id, {
        label: "Too much",
        feeItemId: "",
        kind: "percent",
        value: "120",
      }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ["value"] })] });
    await expect(
      addConcession(conn.app, s.head, ama.id, {
        label: "Head says",
        feeItemId: "",
        kind: "percent",
        value: "5",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addConcession(conn.app, s.eastBursar, ama.id, {
        label: "Other campus",
        feeItemId: "",
        kind: "percent",
        value: "5",
      }),
    ).rejects.toMatchObject({ code: "student_not_found" });
    await addConcession(conn.app, s.eastBursar, efua.id, {
      label: "Sibling discount",
      feeItemId: s.tuition,
      kind: "percent",
      value: "10",
    });
    const other = await school();
    await expect(
      addConcession(conn.app, s.bursar, ama.id, {
        label: "Foreign item",
        feeItemId: other.tuition,
        kind: "percent",
        value: "5",
      }),
    ).rejects.toMatchObject({ code: "unknown_item" });
  });
});

describe("families", () => {
  it("lists guardians with two or more active children and their concessions", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const kofi = await s.add("Kofi", s.classA);
    const efua = await s.add("Efua", s.classB);
    const only = await s.add("Only", s.classA);
    const grace = { fullName: "Grace Mensah", phone: "0245550111", relationship: "mother" };
    for (const child of [ama, kofi, efua]) await addGuardian(conn.app, s.owner, child.id, grace);
    await addGuardian(conn.app, s.owner, only.id, {
      fullName: "Single Parent",
      phone: "0245550999",
      relationship: "father",
    });
    await addConcession(conn.app, s.bursar, kofi.id, {
      label: "Sibling discount",
      feeItemId: s.tuition,
      kind: "percent",
      value: "10",
    });

    const families = await listFamilies(conn.app, s.head);
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ guardianName: "Grace Mensah", phone: "+233245550111" });
    expect(families[0]!.children.map((c) => [c.name, c.className, c.concessions])).toEqual([
      ["Ama Mensah", "Basic 4A", []],
      ["Efua Mensah", "Basic 4B", []],
      ["Kofi Mensah", "Basic 4A", ["Sibling discount"]],
    ]);
    // A campus accountant only sees the children at their campus, so no family of two.
    expect(await listFamilies(conn.app, s.eastBursar)).toEqual([]);
  });
});
