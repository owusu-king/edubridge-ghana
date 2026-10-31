import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses, membershipCampuses } from "@/server/db/schema";
import { billTerm, getStudentAccount, reverseEntry } from "@/server/fees/ledger";
import {
  checkOpeningBalances,
  hasOpeningBalance,
  importOpeningBalances,
  recordAdjustment,
  setOpeningBalance,
  suggestedAsOf,
} from "@/server/fees/opening-balances";
import { listFeeItems, saveLevelFees, setupFeeItems } from "@/server/fees/structure";
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
  await setupFeeItems(conn.app, bursar, { names: ["Tuition"] });
  const [tuition] = await listFeeItems(conn.app, bursar);
  await saveLevelFees(conn.app, bursar, term1, basic4.id, {
    amounts: { [tuition!.id]: "1000" },
    classAmounts: {},
  });
  const add = (admissionNumber: string, firstName: string, classId: string) =>
    createStudent(conn.app, owner, { admissionNumber, firstName, lastName: "Test", sex: "male", classId });
  return {
    owner,
    bursar,
    head: await ctx(people.head.id),
    eastBursar: await ctx(people.eastBursar.id),
    term1,
    classA,
    classB,
    add,
  };
}

type School = Awaited<ReturnType<typeof school>>;
const balance = async (s: School, id: string) =>
  (await getStudentAccount(conn.app, s.bursar, id))!.balancePesewas;
const file = (rows: string[][]) => ({ headers: ["Admission number", "Name", "Balance"], rows });

describe("importing opening balances", () => {
  it("checks a file, imports balances once, and places them before this term's charges", async () => {
    const s = await school();
    const ama = await s.add("A001", "Ama", s.classA);
    const kofi = await s.add("A002", "Kofi", s.classA);
    const yaw = await s.add("A003", "Yaw", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    const parsed = file([
      ["A001", "Ama", "450.50"],
      ["a002", "Kofi", "(120)"],
      ["A003", "Yaw", "0"],
      ["A999", "Nobody", "10"],
      ["A001", "Ama again", "5"],
      ["", "", ""],
    ]);
    const check = await checkOpeningBalances(conn.app, s.bursar, parsed);
    expect(check.ready.map((r) => [r.row, r.admissionNumber, r.amountPesewas])).toEqual([
      [2, "A001", 45050],
      [3, "A002", -12000],
    ]);
    expect(check.problems).toEqual([
      { row: 5, field: "Admission number", message: "No student with admission number A999." },
      { row: 6, field: "Admission number", message: "A001 appears more than once." },
    ]);
    expect(check).toMatchObject({ zero: 1, alreadySet: 0, owedPesewas: 45050, creditPesewas: 12000 });

    expect(await suggestedAsOf(conn.app, s.bursar)).toBe("2026-09-07");
    const result = await importOpeningBalances(conn.app, s.bursar, parsed, { asOf: "2026-09-07" });
    expect(result.imported).toBe(2);
    expect(await balance(s, ama.id)).toBe(100000 + 45050);
    expect(await balance(s, kofi.id)).toBe(100000 - 12000);
    expect(await balance(s, yaw.id)).toBe(100000);
    const entries = (await getStudentAccount(conn.app, s.head, kofi.id))!.entries;
    expect(entries.map((e) => [e.kind, e.description, e.effectiveOn])).toEqual([
      ["opening_balance", "Credit brought forward from previous records", "2026-09-07"],
      ["charge", "Tuition, Term 1 2026/2027", "2026-09-08"],
    ]);

    // Importing the same file again changes nothing.
    expect(await checkOpeningBalances(conn.app, s.bursar, parsed)).toMatchObject({
      alreadySet: 2,
      ready: [],
    });
    await expect(
      importOpeningBalances(conn.app, s.bursar, parsed, { asOf: "2026-09-07" }),
    ).rejects.toMatchObject({
      code: "nothing_to_import",
    });
    expect(await balance(s, ama.id)).toBe(145050);
  });

  it("explains unreadable amounts and missing columns, and refuses future dates", async () => {
    const s = await school();
    await s.add("A001", "Ama", s.classA);
    const check = await checkOpeningBalances(conn.app, s.bursar, file([["A001", "Ama", "four hundred"]]));
    expect(check.problems[0]).toMatchObject({ row: 2, field: "Balance" });
    await expect(
      checkOpeningBalances(conn.app, s.bursar, { headers: ["Name", "Owes"], rows: [["x", "1"]] }),
    ).rejects.toMatchObject({ code: "columns_missing" });
    await expect(
      importOpeningBalances(conn.app, s.bursar, file([["A001", "Ama", "5"]]), { asOf: "2999-01-01" }),
    ).rejects.toMatchObject({ code: "future_date" });
  });

  it("is limited to finance staff with whole-school access", async () => {
    const s = await school();
    const parsed = file([["A001", "Ama", "5"]]);
    await expect(checkOpeningBalances(conn.app, s.head, parsed)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(checkOpeningBalances(conn.app, s.eastBursar, parsed)).rejects.toMatchObject({
      code: "campus_restricted",
    });
  });
});

describe("one student's opening balance and adjustments", () => {
  it("sets one opening balance, and allows a corrected one after reversing it", async () => {
    const s = await school();
    const ama = await s.add("A001", "Ama", s.classA);
    expect(await hasOpeningBalance(conn.app, s.bursar, ama.id)).toBe(false);
    await setOpeningBalance(conn.app, s.bursar, ama.id, { amount: "300", asOf: "2026-09-07" });
    expect(await hasOpeningBalance(conn.app, s.bursar, ama.id)).toBe(true);
    await expect(
      setOpeningBalance(conn.app, s.bursar, ama.id, { amount: "350", asOf: "2026-09-07" }),
    ).rejects.toMatchObject({ code: "opening_exists" });
    const [opening] = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries;
    await reverseEntry(conn.app, s.bursar, opening!.id, { reason: "Wrong amount" });
    expect(await hasOpeningBalance(conn.app, s.bursar, ama.id)).toBe(false);
    await setOpeningBalance(conn.app, s.bursar, ama.id, { amount: "350 CR", asOf: "2026-09-07" });
    expect(await balance(s, ama.id)).toBe(-35000);
    // A file import also respects the corrected balance.
    expect(await checkOpeningBalances(conn.app, s.bursar, file([["A001", "Ama", "10"]]))).toMatchObject({
      alreadySet: 1,
    });
    await expect(
      setOpeningBalance(conn.app, s.bursar, ama.id, { amount: "0", asOf: "2026-09-07" }),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("records one-off charges and credits with a reason", async () => {
    const s = await school();
    const ama = await s.add("A001", "Ama", s.classA);
    await recordAdjustment(conn.app, s.bursar, ama.id, {
      direction: "charge",
      amount: "45",
      description: "Lost reader",
    });
    await recordAdjustment(conn.app, s.owner, ama.id, {
      direction: "credit",
      amount: "20",
      description: "Sports day refund",
    });
    const entries = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries;
    expect(entries.map((e) => [e.kind, e.description, e.amountPesewas])).toEqual([
      ["adjustment", "Lost reader", 4500],
      ["adjustment", "Sports day refund", -2000],
    ]);
    await expect(
      recordAdjustment(conn.app, s.bursar, ama.id, { direction: "charge", amount: "5", description: "x" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      recordAdjustment(conn.app, s.head, ama.id, {
        direction: "charge",
        amount: "5",
        description: "Not allowed",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("limits campus accountants to their own campus's students", async () => {
    const s = await school();
    const ama = await s.add("A001", "Ama", s.classA);
    const efua = await s.add("B001", "Efua", s.classB);
    await expect(
      recordAdjustment(conn.app, s.eastBursar, ama.id, {
        direction: "charge",
        amount: "5",
        description: "Other campus",
      }),
    ).rejects.toMatchObject({ code: "student_not_found" });
    await setOpeningBalance(conn.app, s.eastBursar, efua.id, { amount: "80", asOf: "2026-09-07" });
    expect(await balance(s, efua.id)).toBe(8000);
  });
});
