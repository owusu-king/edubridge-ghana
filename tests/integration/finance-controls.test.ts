import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { getOwedToday } from "@/server/dashboard/finance";
import { withTenant } from "@/server/db/context";
import { ledgerEntries, refunds, terms } from "@/server/db/schema";
import { addConcession, approveConcession, listPendingConcessions } from "@/server/fees/concessions";
import { billTerm, getStudentAccount } from "@/server/fees/ledger";
import { setOpeningBalance } from "@/server/fees/opening-balances";
import { recordPayment, voidPayment } from "@/server/fees/payments";
import { closePeriod, getPeriodLock, reopenPeriod } from "@/server/fees/period-lock";
import { cancelRefund, decideRefund, listRefunds, payRefund, requestRefund } from "@/server/fees/refunds";
import { getBalanceReport, getBilledByCategory, getCollectionReport } from "@/server/fees/reports";
import {
  createFeeItem,
  listFeeItems,
  saveLevelFees,
  setFeeItemDetails,
  setStudentFeeOption,
} from "@/server/fees/structure";
import { listLevelsWithClasses } from "@/server/academics/classes";
import { saveDiscountApprovalPolicy } from "@/server/tenancy/preferences";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { listCampuses } from "@/server/campuses/service";
import { narrowToCampus } from "@/server/fees/access";
import type { TenantContext } from "@/server/tenancy/service";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const pay = (s: School, studentId: string, amount: string, extra: Record<string, unknown> = {}) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    reference: "",
    paidOn: todayIn(s.tenant.timezone),
    idempotencyKey: randomUUID(),
    ...extra,
  });
const balance = async (s: School, id: string) =>
  (await getStudentAccount(conn.app, s.bursar, id))!.balancePesewas;

describe("closing the books", () => {
  it("refuses postings dated in a closed period, from any path, and puts corrections in an open one", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    const yesterday = addDays(today, -1);
    const ama = (await s.add("Ama", s.classA)).id;
    const early = await pay(s, ama, "100", { paidOn: addDays(today, -3) });

    await closePeriod(conn.app, s.bursar, { through: yesterday });
    expect((await getPeriodLock(conn.app, s.bursar)).lockedThrough).toBe(yesterday);
    await expect(pay(s, ama, "50", { paidOn: yesterday })).rejects.toMatchObject({ code: "period_locked" });
    await expect(
      setOpeningBalance(conn.app, s.bursar, ama, { amount: "300", asOf: yesterday }),
    ).rejects.toMatchObject({
      code: "period_locked",
    });
    // The database refuses it too, whatever writes it.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx.insert(ledgerEntries).values({
          tenantId: s.tenant.id,
          studentId: ama,
          kind: "adjustment",
          description: "Back-dated",
          amountPesewas: 100,
          effectiveOn: yesterday,
        }),
      ),
    ).rejects.toMatchObject({ code: "period_locked" });
    // Today is open; voiding an old receipt posts its reversal today.
    expect((await pay(s, ama, "50")).receiptNumber).toBeTruthy();
    await voidPayment(conn.app, s.owner, early.paymentId, { reason: "Entered twice" });

    // Billing a term that started in the closed period posts on the first open day.
    await billTerm(conn.app, s.bursar, s.termId);
    const [term] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(terms).where(eq(terms.id, s.termId)),
    );
    const charges = (await getStudentAccount(conn.app, s.bursar, ama))!.entries.filter(
      (e) => e.kind === "charge",
    );
    expect(charges[0]!.effectiveOn).toBe(term!.startsOn <= yesterday ? today : term!.startsOn);

    await expect(closePeriod(conn.app, s.bursar, { through: addDays(today, 1) })).rejects.toMatchObject({
      code: "future_date",
    });
    await expect(closePeriod(conn.app, s.bursar, { through: addDays(today, -5) })).rejects.toMatchObject({
      code: "already_closed",
    });
    await expect(reopenPeriod(conn.app, s.bursar, { through: "", reason: "Mistake" })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(closePeriod(conn.app, s.head, { through: yesterday })).rejects.toThrow(ForbiddenError);
    await reopenPeriod(conn.app, s.owner, { through: "", reason: "Receipt book found late" });
    expect((await pay(s, ama, "25", { paidOn: yesterday })).receiptNumber).toBeTruthy();
    expect((await getPeriodLock(conn.app, s.owner)).history.map((h) => h.lockedThrough)).toEqual([
      null,
      yesterday,
    ]);
  });
});

describe("refunds", () => {
  it("only refund credit, need a second person to approve, and post a numbered refund", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    await pay(s, ama, "300");
    expect(await balance(s, ama)).toBe(-30_000);

    await expect(
      requestRefund(conn.app, s.bursar, ama, { amount: "400", reason: "Left the school" }),
    ).rejects.toMatchObject({
      code: "refund_exceeds_credit",
    });
    const id = await requestRefund(conn.app, s.bursar, ama, { amount: "200", reason: "Left the school" });
    // Credit already promised cannot be requested twice.
    await expect(
      requestRefund(conn.app, s.bursar, ama, { amount: "150", reason: "Again" }),
    ).rejects.toMatchObject({
      code: "refund_exceeds_credit",
    });
    await expect(decideRefund(conn.app, s.bursar, id, { approve: true })).rejects.toMatchObject({
      code: "two_person_rule",
    });
    await expect(
      payRefund(conn.app, s.owner, id, { method: "cash", paidOn: todayIn(s.tenant.timezone) }),
    ).rejects.toMatchObject({
      code: "refund_not_approved",
    });
    await expect(decideRefund(conn.app, s.head, id, { approve: true })).rejects.toThrow(ForbiddenError);
    await decideRefund(conn.app, s.owner, id, { approve: true, note: "Agreed with the family" });
    const paid = await payRefund(conn.app, s.bursar, id, {
      method: "mobile_money",
      reference: "MM-1",
      paidOn: todayIn(s.tenant.timezone),
    });
    expect(paid.refundNumber).toBe("RF000001");
    expect(await balance(s, ama)).toBe(-10_000);
    expect((await listRefunds(conn.app, s.bursar, { studentId: ama }))[0]).toMatchObject({
      status: "paid",
      refundNumber: "RF000001",
    });
    // Paid refunds never change.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx.update(refunds).set({ status: "cancelled" }).where(eq(refunds.id, id)),
      ),
    ).rejects.toThrow();
    const other = await requestRefund(conn.app, s.bursar, ama, {
      amount: "100",
      reason: "Rest of the credit",
    });
    await cancelRefund(conn.app, s.bursar, other);
  });
});

describe("duplicate payment references", () => {
  it("are flagged with where they were used, and can be confirmed as a different payment", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const kofi = (await s.add("Kofi", s.classA)).id;
    const first = await pay(s, ama, "100", { method: "bank_deposit", reference: "SLIP-77" });
    await expect(
      pay(s, kofi, "100", { method: "bank_deposit", reference: " slip-77 " }),
    ).rejects.toMatchObject({
      code: "duplicate_reference",
      message: expect.stringContaining(first.receiptNumber),
    });
    expect(
      (await pay(s, kofi, "100", { method: "bank_deposit", reference: "SLIP-77", confirmDuplicate: true }))
        .receiptNumber,
    ).toBeTruthy();
    // A different method is not a duplicate; a voided receipt frees its reference.
    expect((await pay(s, kofi, "10", { method: "cheque", reference: "SLIP-77" })).receiptNumber).toBeTruthy();
    const voided = await pay(s, ama, "10", { method: "bank_transfer", reference: "TRF-1" });
    await voidPayment(conn.app, s.owner, voided.paymentId, { reason: "Wrong student" });
    expect(
      (await pay(s, kofi, "10", { method: "bank_transfer", reference: "TRF-1" })).receiptNumber,
    ).toBeTruthy();
  });
});

describe("finance reports", () => {
  it("total by class and campus and reconcile with what is owed", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    await s.add("Esi", s.classB);
    await billTerm(conn.app, s.bursar, s.termId);
    await pay(s, ama, "400");
    const owed = await getOwedToday(conn.app, s.bursar);
    const byClass = await getBalanceReport(conn.app, s.bursar, "class");
    expect(byClass.total.owedPesewas).toBe(owed.totalPesewas);
    expect(byClass.total.buckets).toEqual(owed.buckets);
    expect(byClass.groups.map((g) => [g.label, g.owedPesewas])).toEqual([
      ["Basic 4A", 60_000],
      ["Basic 4B", 100_000],
    ]);
    const byCampus = await getBalanceReport(conn.app, s.bursar, "campus");
    expect(byCampus.groups.map((g) => g.label).sort()).toEqual(["East", "Main"]);
    const today = todayIn(s.tenant.timezone);
    const collections = await getCollectionReport(conn.app, s.bursar, "campus", {
      from: addDays(today, -30),
      to: today,
    });
    expect(collections.groups).toEqual([
      expect.objectContaining({ label: "Main", totalPesewas: 40_000, byMethod: { cash: 40_000 } }),
    ]);
    // An accountant limited to East sees only East.
    expect((await getBalanceReport(conn.app, s.eastBursar, "class")).groups.map((g) => g.label)).toEqual([
      "Basic 4B",
    ]);
    expect(
      (await getCollectionReport(conn.app, s.eastBursar, "campus", { from: addDays(today, -30), to: today }))
        .groups,
    ).toEqual([]);
    const items = await listFeeItems(conn.app, s.bursar);
    await setFeeItemDetails(conn.app, s.bursar, items[0]!.id, { category: "tuition", optional: false });
    expect(await getBilledByCategory(conn.app, s.bursar, s.termId)).toEqual([
      { category: "tuition", chargedPesewas: 200_000, discountedPesewas: 0, netPesewas: 200_000 },
    ]);
  });
});

describe("discount approval and optional items", () => {
  it("hold large discounts for the Proprietor, and bill optional items only to those who take them", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const kofi = (await s.add("Kofi", s.classA)).id;
    await expect(
      saveDiscountApprovalPolicy(conn.app, s.bursar, { percent: "50", amount: "" }),
    ).rejects.toThrow(ForbiddenError);
    await saveDiscountApprovalPolicy(conn.app, s.owner, { percent: "50", amount: "" });
    await addConcession(conn.app, s.bursar, ama, {
      label: "Staff child",
      kind: "percent",
      value: "60",
      feeItemId: "",
    });
    await addConcession(conn.app, s.bursar, kofi, {
      label: "Sports",
      kind: "percent",
      value: "30",
      feeItemId: "",
    });
    const pending = await listPendingConcessions(conn.app, s.owner);
    expect(pending.map((p) => p.studentName)).toEqual(["Ama Mensah"]);

    // Transport is optional: only Kofi takes it.
    const transport = await createFeeItem(conn.app, s.bursar, { name: "Transport" });
    await setFeeItemDetails(conn.app, s.bursar, transport, { category: "transport", optional: true });
    const basic4 = (await listLevelsWithClasses(conn.app, s.owner)).find((l) => l.name === "Basic 4")!;
    const tuition = (await listFeeItems(conn.app, s.bursar)).find((i) => i.name === "Tuition")!.id;
    await saveLevelFees(conn.app, s.bursar, s.termId, basic4.id, {
      amounts: { [tuition]: "1000", [transport]: "200" },
      classAmounts: {},
    });
    await setStudentFeeOption(conn.app, s.bursar, kofi, { feeItemId: transport, takes: true });

    await billTerm(conn.app, s.bursar, s.termId);
    expect(await balance(s, ama)).toBe(100_000); // pending discount not billed, no transport
    expect(await balance(s, kofi)).toBe(70_000 + 20_000 - 6_000); // 30% of tuition and transport

    await approveConcession(conn.app, s.owner, pending[0]!.id);
    await billTerm(conn.app, s.bursar, s.termId).catch(() => undefined);
    expect(await balance(s, ama)).toBe(40_000);
    await expect(approveConcession(conn.app, s.owner, pending[0]!.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("overview by campus", () => {
  it("narrows to one campus with exactly a campus member's scope, and never widens", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id; // Main
    const esi = (await s.add("Esi", s.classB)).id; // East
    await billTerm(conn.app, s.bursar, s.termId);
    await pay(s, ama, "300");
    await pay(s, esi, "100");
    const east = s.eastBursar.campusIds![0]!;
    const main = (await listCampuses(conn.app, s.owner)).find((c) => c.name === "Main")!.id;

    const owed = async (ctx: TenantContext) => (await getOwedToday(conn.app, ctx)).totalPesewas;
    const all = await owed(s.owner);
    const onlyEast = await owed(narrowToCampus(s.owner, east));
    const onlyMain = await owed(narrowToCampus(s.owner, main));
    expect(onlyEast + onlyMain).toBe(all);
    expect(onlyEast).toBe(await owed(s.eastBursar));
    expect(onlyEast).toBe(90000);

    // The East accountant cannot see Main by asking for it; nonsense is ignored.
    expect(narrowToCampus(s.eastBursar, main)).toBe(s.eastBursar);
    expect(narrowToCampus(s.owner, "x' or 1=1")).toBe(s.owner);
    const report = await getBalanceReport(conn.app, narrowToCampus(s.owner, east), "class");
    expect(report.total.owedPesewas).toBe(onlyEast);
  });
});
