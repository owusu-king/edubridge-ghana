import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses, ledgerEntries, membershipCampuses } from "@/server/db/schema";
import { pgErrorCode } from "@/server/errors";
import { billTerm, getBillingStatus, getStudentAccount, reverseEntry } from "@/server/fees/ledger";
import { listFeeItems, saveLevelFees, setupFeeItems } from "@/server/fees/structure";
import { assignClass, createStudent, setStudentStatus } from "@/server/students/service";
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
    teacher: await createUser(conn.owner, "Teacher"),
    eastBursar: await createUser(conn.owner, "East Accountant"),
  };
  await addMember(conn.owner, tenant.id, people.owner.id, ["owner"]);
  await addMember(conn.owner, tenant.id, people.head.id, ["headteacher"]);
  await addMember(conn.owner, tenant.id, people.bursar.id, ["bursar"]);
  await addMember(conn.owner, tenant.id, people.teacher.id, ["teacher"]);
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
    terms: [
      { name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" },
      { name: "Term 2", startsOn: "2027-01-11", endsOn: "2027-04-09" },
    ],
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
    classAmounts: { [classB]: { [tuition]: "900" } },
  });
  const add = (firstName: string, classId?: string) =>
    createStudent(conn.app, owner, { firstName, lastName: "Test", sex: "female", classId });
  return {
    tenant,
    owner,
    bursar,
    head: await ctx(people.head.id),
    teacher: await ctx(people.teacher.id),
    eastBursar: await ctx(people.eastBursar.id),
    term1,
    term2: y!.terms[1]!.id,
    basic4,
    classA,
    classB,
    tuition,
    pta,
    add,
  };
}

const balance = async (s: Awaited<ReturnType<typeof school>>, studentId: string) =>
  (await getStudentAccount(conn.app, s.bursar, studentId))!.balancePesewas;

describe("billing", () => {
  it("charges each active student their class's fees, idempotently", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const efua = await s.add("Efua", s.classB);
    const kojo = await s.add("Kojo", s.classA);
    await setStudentStatus(conn.app, s.owner, kojo.id, "withdrawn");
    await s.add("Unplaced");

    expect(await getBillingStatus(conn.app, s.head, s.term1)).toMatchObject({
      enrolled: 2,
      billedStudents: 0,
      studentsToBill: 2,
      chargesToCreate: 4,
      amountToBillPesewas: 85000 + 5000 + 90000 + 5000,
      differenceCount: 0,
    });
    const result = await billTerm(conn.app, s.bursar, s.term1);
    expect(result).toMatchObject({ studentsToBill: 2, chargesToCreate: 4, amountToBillPesewas: 185000 });
    expect(await balance(s, ama.id)).toBe(90000);
    expect(await balance(s, efua.id)).toBe(95000);
    expect(await balance(s, kojo.id)).toBe(0);

    const account = (await getStudentAccount(conn.app, s.head, efua.id))!;
    expect(account.entries.map((e) => [e.description, e.amountPesewas, e.balancePesewas])).toEqual([
      ["Tuition, Term 1 2026/2027", 90000, 90000],
      ["PTA dues, Term 1 2026/2027", 5000, 95000],
    ]);
    expect(account.entries[0]).toMatchObject({
      kind: "charge",
      effectiveOn: "2026-09-08",
      recordedBy: "Accountant",
    });

    await expect(billTerm(conn.app, s.bursar, s.term1)).rejects.toMatchObject({ code: "nothing_to_bill" });
    expect(await getBillingStatus(conn.app, s.bursar, s.term1)).toMatchObject({
      billedStudents: 2,
      studentsToBill: 0,
    });

    // A student who joins later is billed on the next run; nobody else is charged twice.
    const late = await s.add("Late", s.classA);
    expect(await billTerm(conn.app, s.owner, s.term1)).toMatchObject({
      studentsToBill: 1,
      chargesToCreate: 2,
    });
    expect(await balance(s, late.id)).toBe(90000);
    expect(await balance(s, ama.id)).toBe(90000);
  });

  it("reports differences, and re-bills the current amount after a reversal", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    // Ama moves to Basic 4B, which pays 900 tuition.
    await assignClass(conn.app, s.owner, ama.id, s.classB);
    const status = (await getBillingStatus(conn.app, s.bursar, s.term1))!;
    expect(status.differenceCount).toBe(1);
    expect(status.differences[0]).toMatchObject({
      studentName: "Ama Test",
      itemName: "Tuition",
      billedPesewas: 85000,
      structurePesewas: 90000,
    });
    await expect(billTerm(conn.app, s.bursar, s.term1)).rejects.toMatchObject({ code: "nothing_to_bill" });

    const tuitionCharge = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries.find((e) =>
      e.description.startsWith("Tuition"),
    )!;
    await reverseEntry(conn.app, s.bursar, tuitionCharge.id, { reason: "Moved to Basic 4B" });
    expect(await balance(s, ama.id)).toBe(5000);
    expect(await billTerm(conn.app, s.bursar, s.term1)).toMatchObject({
      chargesToCreate: 1,
      amountToBillPesewas: 90000,
    });
    expect(await balance(s, ama.id)).toBe(95000);
    expect((await getBillingStatus(conn.app, s.bursar, s.term1))!.differenceCount).toBe(0);

    const entries = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries;
    expect(entries.map((e) => [e.kind, e.amountPesewas, e.reversed])).toEqual([
      ["charge", 85000, true],
      ["charge", 5000, false],
      ["charge", 90000, false],
      ["reversal", -85000, false],
    ]);
    expect(entries[3]!.description).toBe("Reversed: Tuition, Term 1 2026/2027 (Moved to Basic 4B)");
  });

  it("bills safely when two people bill at the same time", async () => {
    const s = await school();
    for (const name of ["A", "B", "C", "D", "E"]) await s.add(name, s.classA);
    const results = await Promise.allSettled([
      billTerm(conn.app, s.bursar, s.term1),
      billTerm(conn.app, s.owner, s.term1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const count = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.tenantId, s.tenant.id)),
    );
    expect(count[0]!.n).toBe(10);
  });

  it("is limited to finance staff with whole-school access", async () => {
    const s = await school();
    await s.add("Ama", s.classA);
    await expect(billTerm(conn.app, s.head, s.term1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(billTerm(conn.app, s.eastBursar, s.term1)).rejects.toMatchObject({
      code: "campus_restricted",
    });
    await expect(getBillingStatus(conn.app, s.teacher, s.term1)).rejects.toBeInstanceOf(ForbiddenError);
    const other = await school();
    expect(await getBillingStatus(conn.app, s.bursar, other.term1)).toBeNull();
    await expect(billTerm(conn.app, s.bursar, other.term1)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("student accounts and reversals", () => {
  it("reverses an entry exactly once and never a reversal", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    const [charge] = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries;
    await expect(reverseEntry(conn.app, s.bursar, charge!.id, { reason: "x" })).rejects.toMatchObject({
      name: "ZodError",
    });
    const reversalId = await reverseEntry(conn.app, s.bursar, charge!.id, { reason: "Billed in error" });
    await expect(reverseEntry(conn.app, s.owner, charge!.id, { reason: "Again" })).rejects.toMatchObject({
      code: "already_reversed",
    });
    await expect(reverseEntry(conn.app, s.owner, reversalId, { reason: "Undo" })).rejects.toMatchObject({
      code: "not_reversible",
    });
    expect(await balance(s, ama.id)).toBe(5000);
  });

  it("lets the head teacher read accounts but not reverse, and keeps teachers out", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    const account = (await getStudentAccount(conn.app, s.head, ama.id))!;
    expect(account.balancePesewas).toBe(90000);
    await expect(
      reverseEntry(conn.app, s.head, account.entries[0]!.id, { reason: "Not allowed" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getStudentAccount(conn.app, s.teacher, ama.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("limits campus accountants to students at their campus", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const efua = await s.add("Efua", s.classB);
    await billTerm(conn.app, s.bursar, s.term1);
    expect(await getStudentAccount(conn.app, s.eastBursar, ama.id)).toBeNull();
    const efuaAccount = (await getStudentAccount(conn.app, s.eastBursar, efua.id))!;
    expect(efuaAccount.balancePesewas).toBe(95000);
    const amaCharge = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries[0]!;
    await expect(
      reverseEntry(conn.app, s.eastBursar, amaCharge.id, { reason: "Other campus" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await reverseEntry(conn.app, s.eastBursar, efuaAccount.entries[1]!.id, { reason: "PTA waived" });
    expect(await balance(s, efua.id)).toBe(90000);
  });

  it("hides other schools' students and entries", async () => {
    const s = await school();
    const other = await school();
    const theirs = await other.add("Theirs", other.classA);
    await billTerm(conn.app, other.bursar, other.term1);
    expect(await getStudentAccount(conn.app, s.bursar, theirs.id)).toBeNull();
    const entry = (await getStudentAccount(conn.app, other.bursar, theirs.id))!.entries[0]!;
    await expect(reverseEntry(conn.app, s.bursar, entry.id, { reason: "Not mine" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("ledger integrity in the database", () => {
  async function billed() {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    const entry = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries[0]!;
    return { s, ama, entry, scope: { tenantId: s.tenant.id, userId: s.bursar.userId } };
  }

  it("refuses updates and deletes, even for the owner role", async () => {
    const { entry, scope } = await billed();
    for (const database of [conn.app, conn.owner]) {
      const update = withTenant(database, scope, (tx) =>
        tx.update(ledgerEntries).set({ amountPesewas: 1 }).where(eq(ledgerEntries.id, entry.id)),
      );
      await expect(update).rejects.toSatisfy((e: unknown) =>
        ["42501", "23001"].includes(pgErrorCode(e) ?? ""),
      );
      const remove = withTenant(database, scope, (tx) =>
        tx.delete(ledgerEntries).where(eq(ledgerEntries.id, entry.id)),
      );
      await expect(remove).rejects.toSatisfy((e: unknown) =>
        ["42501", "23001"].includes(pgErrorCode(e) ?? ""),
      );
    }
    const owner = withTenant(conn.owner, scope, (tx) =>
      tx.update(ledgerEntries).set({ description: "Edited" }).where(eq(ledgerEntries.id, entry.id)),
    );
    await expect(owner).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === "23001");
  });

  it("only accepts reversals that exactly negate an entry for the same student", async () => {
    const { s, ama, entry, scope } = await billed();
    const other = await s.add("Other", s.classA);
    const insert = (values: Partial<typeof ledgerEntries.$inferInsert>) =>
      withTenant(conn.app, scope, (tx) =>
        tx.insert(ledgerEntries).values({
          tenantId: s.tenant.id,
          studentId: ama.id,
          kind: "reversal",
          description: "Manual",
          amountPesewas: -entry.amountPesewas,
          reversesEntryId: entry.id,
          effectiveOn: "2026-10-01",
          ...values,
        }),
      );
    await expect(insert({ amountPesewas: -1 })).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === "23514");
    await expect(insert({ studentId: other.id })).rejects.toSatisfy(
      (e: unknown) => pgErrorCode(e) === "23514",
    );
    await expect(insert({ reversesEntryId: null })).rejects.toSatisfy(
      (e: unknown) => pgErrorCode(e) === "23514",
    );
    // Charges must be positive.
    await expect(insert({ kind: "charge", reversesEntryId: null, amountPesewas: -5 })).rejects.toSatisfy(
      (e: unknown) => pgErrorCode(e) === "23514",
    );
    await insert({});
    await expect(insert({})).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === "23505");
    const rows = await withTenant(conn.app, scope, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.studentId, ama.id))),
    );
    expect(rows.reduce((sum, r) => sum + r.amountPesewas, 0)).toBe(5000);
  });
});
