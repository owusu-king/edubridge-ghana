import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses, membershipCampuses } from "@/server/db/schema";
import { cancelPaymentPlan, createPaymentPlan, getPaymentPlan } from "@/server/fees/payment-plans";
import { recordPayment, voidPayment } from "@/server/fees/payments";
import { createStudent } from "@/server/students/service";
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
  await setupDefaultLevels(conn.app, owner, { stages: ["primary"] });
  await createAcademicYear(conn.app, owner, {
    name: "2026/2027",
    terms: [{ name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" }],
  });
  const [y] = await listAcademicYears(conn.app, owner);
  await setCurrentTerm(conn.app, owner, y!.terms[0]!.id);
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
  const add = (firstName: string, classId: string) =>
    createStudent(conn.app, owner, { firstName, lastName: "Test", sex: "male", classId });
  return {
    tenant,
    owner,
    bursar: await ctx(people.bursar.id),
    head: await ctx(people.head.id),
    eastBursar: await ctx(people.eastBursar.id),
    classA,
    classB,
    add,
  };
}

type School = Awaited<ReturnType<typeof school>>;
const today = (s: School) => todayIn(s.tenant.timezone);
const later = (s: School, days: number) => {
  const d = new Date(`${today(s)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const pay = (s: School, studentId: string, amount: string) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    paidOn: today(s),
    idempotencyKey: randomUUID(),
  });

describe("payment plans", () => {
  it("splits the amount into instalments and tracks payments against them", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await pay(s, ama.id, "50"); // Before the plan: not counted.
    await createPaymentPlan(conn.app, s.bursar, ama.id, {
      total: "900",
      count: "3",
      firstDueOn: later(s, 7),
      frequency: "monthly",
    });
    let plan = (await getPaymentPlan(conn.app, s.head, ama.id))!;
    expect(plan.progress.instalments.map((i) => [i.amountPesewas, i.status])).toEqual([
      [30000, "upcoming"],
      [30000, "upcoming"],
      [30000, "upcoming"],
    ]);
    expect(plan.progress.paidPesewas).toBe(0);
    expect(plan.createdBy).toBe("Accountant");

    // Payments recorded today count (the plan starts today); voided receipts do not.
    await pay(s, ama.id, "400");
    const wrong = await pay(s, ama.id, "999");
    await voidPayment(conn.app, s.owner, wrong.paymentId, { reason: "Typed wrongly" });
    plan = (await getPaymentPlan(conn.app, s.bursar, ama.id))!;
    expect(plan.progress.instalments.map((i) => [i.status, i.paidPesewas])).toEqual([
      ["paid", 30000],
      ["partly_paid", 10000],
      ["upcoming", 0],
    ]);
    expect(plan.progress).toMatchObject({ paidPesewas: 40000, remainingPesewas: 50000, overduePesewas: 0 });
  });

  it("allows one active plan per student, and a new one after cancelling", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const input = { total: "600", count: "2", firstDueOn: later(s, 1), frequency: "fortnightly" };
    const first = await createPaymentPlan(conn.app, s.bursar, ama.id, input);
    await expect(createPaymentPlan(conn.app, s.bursar, ama.id, input)).rejects.toMatchObject({
      code: "plan_exists",
    });
    await cancelPaymentPlan(conn.app, s.bursar, first);
    expect(await getPaymentPlan(conn.app, s.bursar, ama.id)).toBeNull();
    await createPaymentPlan(conn.app, s.owner, ama.id, { ...input, count: "3" });
    expect((await getPaymentPlan(conn.app, s.bursar, ama.id))!.progress.instalments).toHaveLength(3);
  });

  it("validates plans and limits who may agree them", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const efua = await s.add("Efua", s.classB);
    const ok = { total: "600", count: "2", firstDueOn: later(s, 1), frequency: "monthly" };
    await expect(
      createPaymentPlan(conn.app, s.bursar, ama.id, { ...ok, firstDueOn: later(s, -1) }),
    ).rejects.toMatchObject({
      code: "past_date",
    });
    await expect(createPaymentPlan(conn.app, s.bursar, ama.id, { ...ok, count: "1" })).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(createPaymentPlan(conn.app, s.bursar, ama.id, { ...ok, total: "1" })).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(createPaymentPlan(conn.app, s.head, ama.id, ok)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPaymentPlan(conn.app, s.eastBursar, ama.id, ok)).rejects.toMatchObject({
      code: "student_not_found",
    });
    await createPaymentPlan(conn.app, s.eastBursar, efua.id, ok);
    expect(await getPaymentPlan(conn.app, s.eastBursar, ama.id)).toBeNull();
    const other = await school();
    const theirs = await other.add("Theirs", other.classA);
    await expect(createPaymentPlan(conn.app, s.bursar, theirs.id, ok)).rejects.toMatchObject({
      code: "student_not_found",
    });
  });
});
