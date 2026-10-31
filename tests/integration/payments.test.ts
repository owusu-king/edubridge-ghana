import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses, ledgerEntries, membershipCampuses, payments } from "@/server/db/schema";
import { pgErrorCode } from "@/server/errors";
import { billTerm, getStudentAccount, reverseEntry } from "@/server/fees/ledger";
import { getReceipt, listAccounts, listPaymentsOn, recordPayment, voidPayment } from "@/server/fees/payments";
import { listFeeItems, saveLevelFees, setupFeeItems } from "@/server/fees/structure";
import { createStudent, setStudentStatus } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const people = {
    owner: await createUser(conn.owner, "Proprietor"),
    head: await createUser(conn.owner, "Head"),
    bursar: await createUser(conn.owner, "Akosua Accountant"),
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
  const add = (firstName: string, lastName: string, classId?: string) =>
    createStudent(conn.app, owner, { firstName, lastName, sex: "female", classId });
  return {
    tenant,
    owner,
    bursar,
    head: await ctx(people.head.id),
    teacher: await ctx(people.teacher.id),
    eastBursar: await ctx(people.eastBursar.id),
    term1,
    classA,
    classB,
    add,
  };
}

type School = Awaited<ReturnType<typeof school>>;
const today = (s: School) => todayIn(s.tenant.timezone);
const pay = (
  s: School,
  studentId: string,
  amount: string,
  extra: Record<string, unknown> = {},
  ctx = s.bursar,
) =>
  recordPayment(conn.app, ctx, {
    studentId,
    amount,
    method: "cash",
    paidOn: today(s),
    idempotencyKey: randomUUID(),
    ...extra,
  });
const balance = async (s: School, id: string) =>
  (await getStudentAccount(conn.app, s.bursar, id))!.balancePesewas;

describe("recording payments", () => {
  it("credits the account, issues sequential receipts and supports part payments and credit", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    const first = await pay(s, ama.id, "400");
    const second = await pay(s, ama.id, "350.50", {
      method: "mobile_money",
      reference: "MP261031.1234.A56789",
      payerName: "Grace Mensah",
    });
    expect([first.receiptNumber, second.receiptNumber]).toEqual(["R000001", "R000002"]);
    expect(await balance(s, ama.id)).toBe(100000 - 40000 - 35050);
    // Paying more than is owed leaves the family in credit.
    await pay(s, ama.id, "300");
    expect(await balance(s, ama.id)).toBe(-5050);

    const receipt = (await getReceipt(conn.app, s.head, second.paymentId))!;
    expect(receipt).toMatchObject({
      receiptNumber: "R000002",
      amountPesewas: 35050,
      method: "mobile_money",
      reference: "MP261031.1234.A56789",
      payerName: "Grace Mensah",
      recordedBy: "Akosua Accountant",
      student: { name: "Ama Mensah", className: "Basic 4A" },
      balanceAfterPesewas: 24950,
      voided: null,
    });
    const entries = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries;
    expect(entries.map((e) => [e.kind, e.amountPesewas, e.description])).toEqual([
      ["charge", 100000, "Tuition, Term 1 2026/2027"],
      ["payment", -40000, "Payment, receipt R000001 (Cash)"],
      ["payment", -35050, "Payment, receipt R000002 (Mobile Money)"],
      ["payment", -30000, "Payment, receipt R000003 (Cash)"],
    ]);
  });

  it("records one payment when the same form is submitted twice, even at the same moment", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    const key = randomUUID();
    const results = await Promise.all([
      pay(s, ama.id, "200", { idempotencyKey: key }),
      pay(s, ama.id, "200", { idempotencyKey: key }),
    ]);
    expect(results[0]!.paymentId).toBe(results[1]!.paymentId);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await pay(s, ama.id, "200", { idempotencyKey: key })).toMatchObject({ replayed: true });
    expect(await balance(s, ama.id)).toBe(-20000);
    await expect(pay(s, ama.id, "250", { idempotencyKey: key })).rejects.toMatchObject({
      code: "duplicate_submission",
    });
    // The next payment's receipt follows on with no gap.
    expect((await pay(s, ama.id, "1")).receiptNumber).toBe("R000002");
  });

  it("keeps receipt numbers unique and gapless under concurrent payments", async () => {
    const s = await school();
    const ids = await Promise.all(["A", "B", "C", "D", "E", "F"].map((n) => s.add(n, "Test", s.classA)));
    const results = await Promise.all(ids.map((st) => pay(s, st.id, "10")));
    expect(results.map((r) => r.receiptNumber).sort()).toEqual([
      "R000001",
      "R000002",
      "R000003",
      "R000004",
      "R000005",
      "R000006",
    ]);
  });

  it("validates amounts, dates and references", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    await expect(pay(s, ama.id, "0")).rejects.toMatchObject({ name: "ZodError" });
    await expect(pay(s, ama.id, "12.345")).rejects.toMatchObject({ name: "ZodError" });
    await expect(pay(s, ama.id, "10", { method: "bank_deposit" })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["reference"] })],
    });
    await expect(pay(s, ama.id, "10", { paidOn: "2999-01-01" })).rejects.toMatchObject({
      code: "future_date",
    });
    await expect(pay(s, randomUUID(), "10")).rejects.toMatchObject({ code: "student_not_found" });
  });

  it("accepts arrears from withdrawn students", async () => {
    const s = await school();
    const kojo = await s.add("Kojo", "Addo", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    await setStudentStatus(conn.app, s.owner, kojo.id, "withdrawn");
    await pay(s, kojo.id, "1000");
    expect(await balance(s, kojo.id)).toBe(0);
  });

  it("restricts who can record payments", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    const efua = await s.add("Efua", "Ofori", s.classB);
    await expect(pay(s, ama.id, "10", {}, s.head)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(pay(s, ama.id, "10", {}, s.teacher)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(pay(s, ama.id, "10", {}, s.eastBursar)).rejects.toMatchObject({ code: "student_not_found" });
    await pay(s, efua.id, "10", {}, s.eastBursar);
    const other = await school();
    const theirs = await other.add("Theirs", "Other", other.classA);
    await expect(pay(s, theirs.id, "10")).rejects.toMatchObject({ code: "student_not_found" });
  });
});

describe("voiding receipts", () => {
  it("lets the Proprietor void a receipt once, reversing its credit and keeping the number", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    await billTerm(conn.app, s.bursar, s.term1);
    const paid = await pay(s, ama.id, "400");
    await expect(
      voidPayment(conn.app, s.bursar, paid.paymentId, { reason: "Wrong student" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await voidPayment(conn.app, s.owner, paid.paymentId, { reason: "Wrong student" });
    await expect(voidPayment(conn.app, s.owner, paid.paymentId, { reason: "Again" })).rejects.toMatchObject({
      code: "already_voided",
    });
    expect(await balance(s, ama.id)).toBe(100000);
    const receipt = (await getReceipt(conn.app, s.bursar, paid.paymentId))!;
    expect(receipt.voided).toMatchObject({ reason: "Wrong student", by: "Proprietor" });
    const entries = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries;
    expect(entries.map((e) => [e.kind, e.amountPesewas, e.reversed])).toEqual([
      ["charge", 100000, false],
      ["payment", -40000, true],
      ["reversal", 40000, false],
    ]);
    expect(entries[2]!.description).toBe("Receipt R000001 voided (Wrong student)");
    expect(entries[2]!.paymentId).toBe(paid.paymentId);
    // Payments are only cancelled by voiding their receipt.
    const fresh = await pay(s, ama.id, "50");
    const entry = (await getStudentAccount(conn.app, s.bursar, ama.id))!.entries.find(
      (e) => e.paymentId === fresh.paymentId,
    )!;
    await expect(
      reverseEntry(conn.app, s.owner, entry.id, { reason: "Not like this" }),
    ).rejects.toMatchObject({
      code: "use_void",
    });
  });

  it("refuses edits to payments and voids, and mismatched payment entries, in the database", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    const paid = await pay(s, ama.id, "400");
    const scope = { tenantId: s.tenant.id, userId: s.bursar.userId };
    for (const database of [conn.app, conn.owner]) {
      await expect(
        withTenant(database, scope, (tx) =>
          tx.update(payments).set({ amountPesewas: 1 }).where(eq(payments.id, paid.paymentId)),
        ),
      ).rejects.toSatisfy((e: unknown) => ["42501", "23001"].includes(pgErrorCode(e) ?? ""));
      await expect(
        withTenant(database, scope, (tx) => tx.delete(payments).where(eq(payments.id, paid.paymentId))),
      ).rejects.toSatisfy((e: unknown) => ["42501", "23001"].includes(pgErrorCode(e) ?? ""));
    }
    // A second ledger credit for the same payment, or one for the wrong amount, is refused.
    const insert = (amountPesewas: number) =>
      withTenant(conn.app, scope, (tx) =>
        tx.insert(ledgerEntries).values({
          tenantId: s.tenant.id,
          studentId: ama.id,
          kind: "payment",
          description: "Manual",
          amountPesewas,
          paymentId: paid.paymentId,
          effectiveOn: today(s),
        }),
      );
    await expect(insert(-1)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === "23514");
    await expect(insert(-40000)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === "23505");
    const [count] = await withTenant(conn.app, scope, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.paymentId, paid.paymentId)),
    );
    expect(count!.n).toBe(1);
  });
});

describe("payments by day and account balances", () => {
  it("totals a day's payments by method, leaving out voided receipts", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    const efua = await s.add("Efua", "Ofori", s.classB);
    await pay(s, ama.id, "100");
    await pay(s, efua.id, "250", { method: "mobile_money", reference: "MM-1" });
    const wrong = await pay(s, efua.id, "999");
    await pay(s, ama.id, "70", { paidOn: "2026-09-10" });
    await voidPayment(conn.app, s.owner, wrong.paymentId, { reason: "Typed wrongly" });
    const day = await listPaymentsOn(conn.app, s.head, today(s));
    expect(day.payments.map((p) => [p.receiptNumber, p.studentName, p.voided])).toEqual([
      ["R000001", "Ama Mensah", false],
      ["R000002", "Efua Ofori", false],
      ["R000003", "Efua Ofori", true],
    ]);
    expect(day.byMethod).toEqual([
      { method: "cash", count: 1, totalPesewas: 10000 },
      { method: "mobile_money", count: 1, totalPesewas: 25000 },
    ]);
    expect(day.totalPesewas).toBe(35000);
    expect((await listPaymentsOn(conn.app, s.bursar, "2026-09-10")).totalPesewas).toBe(7000);
    // A campus accountant sees only their campus's payments.
    const east = await listPaymentsOn(conn.app, s.eastBursar, today(s));
    expect(east.payments.map((p) => p.studentName)).toEqual(["Efua Ofori", "Efua Ofori"]);
    await expect(listPaymentsOn(conn.app, s.teacher, today(s))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lists balances, largest first, with filters and totals", async () => {
    const s = await school();
    const ama = await s.add("Ama", "Mensah", s.classA);
    await s.add("Efua", "Ofori", s.classB);
    const kojo = await s.add("Kojo", "Addo", s.classA);
    const left = await s.add("Left", "Early", s.classA);
    await s.add("Unplaced", "Student");
    await billTerm(conn.app, s.bursar, s.term1);
    await pay(s, ama.id, "600");
    await pay(s, kojo.id, "1200");
    await pay(s, left.id, "1000");
    await setStudentStatus(conn.app, s.owner, left.id, "withdrawn");

    const all = await listAccounts(conn.app, s.head, {});
    expect(all.rows.map((r) => [r.name, r.className, r.balancePesewas])).toEqual([
      ["Efua Ofori", "Basic 4B", 100000],
      ["Ama Mensah", "Basic 4A", 40000],
      ["Unplaced Student", null, 0],
      ["Kojo Addo", "Basic 4A", -20000],
    ]);
    expect(all).toMatchObject({ total: 4, owedPesewas: 140000, creditPesewas: 20000 });
    expect((await listAccounts(conn.app, s.bursar, { owing: true })).rows.map((r) => r.name)).toEqual([
      "Efua Ofori",
      "Ama Mensah",
    ]);
    expect(
      (await listAccounts(conn.app, s.bursar, { classId: s.classA, q: "men" })).rows.map((r) => r.name),
    ).toEqual(["Ama Mensah"]);
    expect((await listAccounts(conn.app, s.eastBursar, {})).rows.map((r) => r.name)).toEqual(["Efua Ofori"]);
    expect(await listAccounts(conn.app, s.bursar, { q: "%" })).toMatchObject({ total: 0 });
  });
});
