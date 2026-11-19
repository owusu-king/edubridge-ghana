import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears } from "@/server/academics/calendar";
import { listLevelsWithClasses } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { enrolments, payments, refunds } from "@/server/db/schema";
import { narrowToCampus } from "@/server/fees/access";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment, voidPayment } from "@/server/fees/payments";
import { closePeriod, reopenPeriod } from "@/server/fees/period-lock";
import { listFeeItems, saveLevelFees } from "@/server/fees/structure";
import { listFinanceChecks, reviewFinanceCheck } from "@/server/forecasting/checks";
import { getCollectionForecast } from "@/server/forecasting/forecast";
import { listCampuses } from "@/server/campuses/service";
import type { TenantContext } from "@/server/tenancy/service";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, fn);

const pay = (
  s: School,
  studentId: string,
  amount: string,
  paidOn: string,
  extra: Record<string, unknown> = {},
) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    reference: "",
    paidOn,
    idempotencyKey: randomUUID(),
    ...extra,
  });

/**
 * Last year's Term 3 (20 Apr to 24 Jul 2026, 96 days) billed Ama (Main) and Kofi (East) GH₵1,000 each: Ama paid
 * GH₵500 on its first day and Kofi GH₵1,000 on its last. So from any day in between, that term went on to collect
 * half its billed fees. This term billed them GH₵1,000 each again and Ama has paid GH₵400.
 */
async function setUp() {
  const s = await school();
  await createAcademicYear(conn.app, s.owner, {
    name: "2025/2026",
    terms: [{ name: "Term 3", startsOn: "2026-04-20", endsOn: "2026-07-24" }],
  });
  const previous = (await listAcademicYears(conn.app, s.owner)).find((y) => y.name === "2025/2026")!.terms[0]!
    .id;
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classB)).id;
  await asSchool(s, (tx) =>
    tx.insert(enrolments).values([
      { tenantId: s.tenant.id, studentId: ama, termId: previous, classId: s.classA },
      { tenantId: s.tenant.id, studentId: kofi, termId: previous, classId: s.classB },
    ]),
  );
  const basic4 = (await listLevelsWithClasses(conn.app, s.owner)).find((l) => l.name === "Basic 4")!;
  const [tuition] = await listFeeItems(conn.app, s.bursar);
  await saveLevelFees(conn.app, s.bursar, previous, basic4.id, {
    amounts: { [tuition!.id]: "1000" },
    classAmounts: {},
  });
  await billTerm(conn.app, s.bursar, previous);
  await billTerm(conn.app, s.bursar, s.termId);
  await pay(s, ama, "500", "2026-04-20");
  await pay(s, kofi, "1000", "2026-07-24");
  await pay(s, ama, "400", "2026-09-10");
  const campusList = await listCampuses(conn.app, s.owner);
  return { s, previous, ama, kofi, east: campusList.find((c) => c.name === "East")! };
}

describe("collection forecast (FCT-01)", () => {
  it("forecasts the rest of the term from the past terms, for the school and for a campus", async () => {
    const { s, previous, east } = await setUp();
    const f = (await getCollectionForecast(conn.app, s.owner, s.termId))!;
    expect(f.term).toMatchObject({ id: s.termId, label: "Term 1, 2026/2027" });
    if (f.forecast.status !== "forecast") throw new Error(`expected a forecast, got ${f.forecast.status}`);
    expect(f.forecast.billedPesewas).toBe(200_000);
    expect(f.forecast.collectedPesewas).toBe(40_000);
    expect(f.forecast.basedOn).toEqual([{ termId: previous, label: "Term 3, 2025/2026" }]);
    // GH₵400 collected + half of GH₵2,000 still to come; one past term, so the range is that term.
    expect(f.forecast.endOfTerm).toEqual({
      likelyPesewas: 140_000,
      lowPesewas: 140_000,
      highPesewas: 140_000,
    });
    expect(f.forecast.weeks[0]).toMatchObject({
      from: "2026-09-08",
      to: "2026-09-13",
      actualPesewas: 40_000,
    });
    // Only one complete past term: last term had nothing to learn from.
    expect(f.backtest).toBeNull();

    // East: Kofi only. Last term East collected nothing until its last day, then all of it.
    const forEast = (await getCollectionForecast(conn.app, narrowToCampus(s.owner, east.id), s.termId))!;
    expect(forEast.forecast).toMatchObject({
      status: "forecast",
      billedPesewas: 100_000,
      collectedPesewas: 0,
      endOfTerm: { likelyPesewas: 100_000 },
    });
    expect((await getCollectionForecast(conn.app, s.eastBursar, s.termId))!.forecast).toEqual(
      forEast.forecast,
    );

    // The past term itself has ended: what it collected, no forecast.
    expect((await getCollectionForecast(conn.app, s.owner, previous))!.forecast).toEqual({
      status: "ended",
      collectedPesewas: 150_000,
      billedPesewas: 200_000,
    });
    expect(await getCollectionForecast(conn.app, s.owner, randomUUID())).toBeNull();
  });

  it("says when there is not enough history, and is for finance and school leads only", async () => {
    const s = await school();
    await s.add("Esi", s.classA);
    expect((await getCollectionForecast(conn.app, s.head, s.termId))!.forecast).toEqual({
      status: "not_billed",
    });
    await billTerm(conn.app, s.bursar, s.termId);
    expect((await getCollectionForecast(conn.app, s.bursar, s.termId))!.forecast).toEqual({
      status: "no_history",
    });
    await expect(getCollectionForecast(conn.app, s.teacher, s.termId)).rejects.toThrow(ForbiddenError);
  });
});

describe("finance checks (FCT-02)", () => {
  it("flags repeated references, many voids, late receipts, large refunds and reopened periods", async () => {
    const { s, ama, kofi } = await setUp();
    await pay(s, ama, "100", "2026-09-15", { method: "bank_deposit", reference: "SLIP-001" });
    await pay(s, ama, "100", "2026-09-16", {
      method: "bank_deposit",
      reference: " slip-001 ",
      confirmDuplicate: true, // the person confirmed it was a different payment
    });
    // A different method with the same reference is not a repeat.
    await pay(s, kofi, "100", "2026-09-16", { method: "cheque", reference: "SLIP-001" });
    const voided: string[] = [];
    for (const n of [1, 2, 3]) {
      const p = await pay(s, kofi, "10", "2026-10-01", { reference: `V${n}` });
      await voidPayment(conn.app, s.owner, p.paymentId, { reason: "Entered against the wrong student" });
      voided.push(p.paymentId);
    }
    await asSchool(s, async (tx) => {
      await tx.insert(payments).values({
        tenantId: s.tenant.id,
        studentId: ama,
        receiptNumber: "LATE-1",
        amountPesewas: 5_000,
        method: "cash",
        paidOn: "2026-10-02",
        idempotencyKey: randomUUID(),
        recordedByUserId: s.bursar.userId,
        recordedAt: new Date("2026-10-02T22:15:00Z"),
      });
      await tx.insert(refunds).values({
        tenantId: s.tenant.id,
        studentId: kofi,
        amountPesewas: 150_000,
        reason: "Family moved abroad",
        requestedByUserId: s.bursar.userId,
      });
    });
    await closePeriod(conn.app, s.owner, { through: "2026-09-30" });
    await reopenPeriod(conn.app, s.owner, { through: "2026-09-15", reason: "Correct a receipt date" });

    const checks = (await listFinanceChecks(conn.app, s.owner, s.termId))!;
    expect(checks.term).toMatchObject({ from: "2026-09-08" });
    const byRule = (rule: string) => checks.flags.filter((f) => f.rule === rule);
    expect(byRule("duplicate_reference")).toEqual([
      expect.objectContaining({
        summary: "2 bank deposit receipts carry the reference “SLIP-001”.",
        reviewable: true,
        review: null,
      }),
    ]);
    expect(byRule("duplicate_reference")[0]!.links).toHaveLength(2);
    expect(byRule("many_voids")).toEqual([
      expect.objectContaining({ summary: "Proprietor voided 3 receipts in the term." }),
    ]);
    expect(byRule("many_voids")[0]!.links.map((l) => l.path)).toEqual(
      voided.map((id) => `fees/receipts/${id}`),
    );
    // Receipts taken through recordPayment carry the time the test runs (the database's clock), so after
    // 20:00 they are rightly flagged too. Only the planted late receipt, dated 2 Oct, is pinned down here.
    const plantedLate = (flags: { rule: string; on: string }[]) =>
      flags.filter((f) => f.rule !== "out_of_hours" || f.on === "2026-10-02");
    expect(byRule("out_of_hours").filter((f) => f.on === "2026-10-02")).toEqual([
      expect.objectContaining({
        summary: "Receipt LATE-1 was recorded at 22:15 on 2 Oct 2026 by Akosua Accountant.",
      }),
    ]);
    expect(
      byRule("out_of_hours")
        .filter((f) => f.on !== "2026-10-02")
        .every((f) => /^Receipt R\d+ was recorded at (2[0-3]|0[0-5]):\d\d /.test(f.summary)),
    ).toBe(true);
    expect(byRule("large_refund")).toHaveLength(1);
    expect(byRule("period_reopened")).toEqual([
      expect.objectContaining({
        summary: expect.stringMatching(
          /^Proprietor reopened the accounts from 30 Sept 2026 back to 15 Sept 2026 on .+: “Correct a receipt date”$/,
        ),
      }),
    ]);

    // An accountant limited to East sees East's records only, and no school-wide reopening.
    const east = (await listFinanceChecks(conn.app, s.eastBursar, s.termId))!;
    expect(
      plantedLate(east.flags)
        .map((f) => f.rule)
        .sort(),
    ).toEqual(["large_refund", "many_voids"]);

    await expect(listFinanceChecks(conn.app, s.head, s.termId)).rejects.toThrow(ForbiddenError);
  });

  it("reviews a flag once with a note, kept; changed facts raise a new flag", async () => {
    const { s, kofi } = await setUp();
    for (const n of [1, 2, 3]) {
      const p = await pay(s, kofi, "10", "2026-10-01", { reference: `V${n}` });
      await voidPayment(conn.app, s.owner, p.paymentId, { reason: "Entered against the wrong student" });
    }
    // By rule: after 20:00 the receipts above are also flagged as recorded out of hours.
    const voids = async (as: TenantContext) =>
      (await listFinanceChecks(conn.app, as, s.termId))!.flags.find((f) => f.rule === "many_voids");
    const flag = await voids(s.bursar);
    const review = (note: string) =>
      reviewFinanceCheck(conn.app, s.bursar, { termId: s.termId, key: flag!.key, note });
    await expect(review("ok")).rejects.toMatchObject({ code: "review_invalid" });
    await review("Checked with the Proprietor: wrong student each time.");
    const after = await voids(s.owner);
    expect(after!.review).toMatchObject({
      note: "Checked with the Proprietor: wrong student each time.",
      by: "Akosua Accountant",
    });
    await expect(review("Again")).rejects.toMatchObject({ code: "check_already_reviewed" });
    await expect(
      reviewFinanceCheck(conn.app, s.bursar, { termId: s.termId, key: "many_voids:nobody", note: "Fine." }),
    ).rejects.toMatchObject({ code: "check_not_found" });
    await expect(
      reviewFinanceCheck(conn.app, s.head, { termId: s.termId, key: flag!.key, note: "Fine." }),
    ).rejects.toThrow(ForbiddenError);

    // Reviews cannot be changed or removed, by any role.
    await expect(
      asSchool(s, (tx) => tx.execute(sql`update finance_check_reviews set note = 'changed'`)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/insert-only/) } });
    await expect(
      asSchool(s, (tx) => tx.execute(sql`delete from finance_check_reviews`)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/insert-only/) },
    });

    // A fourth void is a new flag, waiting for a review.
    const p = await pay(s, kofi, "10", "2026-10-02", { reference: "V4" });
    await voidPayment(conn.app, s.owner, p.paymentId, { reason: "Entered against the wrong student" });
    const next = await voids(s.owner);
    expect(next).toMatchObject({ summary: "Proprietor voided 4 receipts in the term.", review: null });
  });
});
