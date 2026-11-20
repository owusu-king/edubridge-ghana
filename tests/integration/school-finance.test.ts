import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { closePeriod } from "@/server/fees/period-lock";
import { voidPayment } from "@/server/fees/payments";
import {
  getReconciliation,
  importStatement,
  matchStatementLine,
  unmatchStatementLine,
} from "@/server/finance/bank";
import {
  cancelDeposit,
  createDeposit,
  decideExpense,
  getIncomeAndSpending,
  listDeposits,
  listUndepositedReceipts,
  recordExpense,
  saveFinanceAccount,
  voidExpense,
} from "@/server/finance/service";
import { listFinanceChecks } from "@/server/forecasting/checks";
import { connect } from "../support/fixtures";
import { billedSchool } from "../support/school";

const conn = connect();
afterAll(() => conn.close());

/** A school with an Accountant, a bank account and a cash box, and three children billed GH₵1,000. */
async function school() {
  const s = await billedSchool(conn, { roles: ["bursar", "headteacher"] });
  const bursar = await s.ctx("bursar");
  const bank = await saveFinanceAccount(conn.app, bursar, {
    name: "GCB current account",
    kind: "bank",
    institution: "GCB Bank",
    accountEnding: "4821",
  });
  const cashBox = await saveFinanceAccount(conn.app, bursar, { name: "Office cash box", kind: "cash" });
  const kids = [
    await s.addStudent("Ama", "Mensah"),
    await s.addStudent("Kofi", "Asante"),
    await s.addStudent("Esi", "Boateng"),
  ];
  await s.bill();
  return { s, bursar, bank, cashBox, kids };
}

const expense = (accountId: string, amount: string, extra: Record<string, unknown> = {}) => ({
  spentOn: "2026-11-05",
  category: "Utilities",
  payee: "ECG",
  amount,
  accountId,
  method: "bank_transfer",
  ...extra,
});

describe("cash and cheques to the bank", () => {
  it("follows each receipt into one deposit, and frees them when the Proprietor cancels it", async () => {
    const { s, bursar, bank, kids } = await school();
    const a = await s.pay(kids[0]!.id, "300", { paidOn: "2026-11-03" });
    const b = await s.pay(kids[1]!.id, "200", {
      method: "cheque",
      reference: "CHQ 556",
      paidOn: "2026-11-03",
    });
    const momo = await s.pay(kids[2]!.id, "100", {
      method: "mobile_money",
      reference: "MP1",
      paidOn: "2026-11-03",
    });
    expect((await listUndepositedReceipts(conn.app, bursar)).map((r) => r.paymentId).sort()).toEqual(
      [a.paymentId, b.paymentId].sort(),
    );

    const deposit = await createDeposit(conn.app, bursar, {
      accountId: bank,
      depositedOn: "2026-11-04",
      slipReference: "SLIP 0042",
      paymentIds: [a.paymentId, b.paymentId],
    });
    expect(deposit).toMatchObject({ depositNumber: "D000001", amountPesewas: 50000 });
    expect(await listUndepositedReceipts(conn.app, bursar)).toEqual([]);

    // A receipt goes into one deposit only; Mobile Money never goes to the bank by hand; dates must make sense.
    await expect(
      createDeposit(conn.app, bursar, {
        accountId: bank,
        depositedOn: "2026-11-04",
        paymentIds: [a.paymentId],
      }),
    ).rejects.toMatchObject({ code: "already_deposited" });
    await expect(
      createDeposit(conn.app, bursar, {
        accountId: bank,
        depositedOn: "2026-11-04",
        paymentIds: [momo.paymentId],
      }),
    ).rejects.toMatchObject({ code: "not_depositable" });
    const late = await s.pay(kids[2]!.id, "50", { paidOn: "2026-11-06" });
    await expect(
      createDeposit(conn.app, bursar, {
        accountId: bank,
        depositedOn: "2026-11-05",
        paymentIds: [late.paymentId],
      }),
    ).rejects.toMatchObject({ code: "deposit_before_receipt" });

    await expect(
      cancelDeposit(conn.app, bursar, deposit.depositId, { reason: "Wrong account" }),
    ).rejects.toThrow(ForbiddenError);
    await cancelDeposit(conn.app, s.owner, deposit.depositId, { reason: "Wrong account" });
    expect(await listUndepositedReceipts(conn.app, bursar)).toHaveLength(3);
    const [listed] = await listDeposits(conn.app, bursar);
    expect(listed!.cancelled?.reason).toBe("Wrong account");
    // The same receipts can then go into a new deposit.
    await createDeposit(conn.app, bursar, {
      accountId: bank,
      depositedOn: "2026-11-06",
      paymentIds: [a.paymentId, b.paymentId, late.paymentId],
    });
  });

  it("never deposits a voided receipt, and flags cash held too long", async () => {
    const { s, bursar, bank, kids } = await school();
    const voided = await s.pay(kids[0]!.id, "100", { paidOn: "2026-11-02" });
    await voidPayment(conn.app, s.owner, voided.paymentId, { reason: "Entered twice" });
    await expect(
      createDeposit(conn.app, bursar, {
        accountId: bank,
        depositedOn: "2026-11-04",
        paymentIds: [voided.paymentId],
      }),
    ).rejects.toMatchObject({ code: "not_depositable" });

    await s.pay(kids[1]!.id, "250", { paidOn: "2026-11-02" });
    const checks = await listFinanceChecks(conn.app, s.owner, s.termId);
    const flag = checks!.flags.find((f) => f.rule === "cash_not_banked");
    expect(flag?.summary).toMatch(/1 cash or cheque receipt for GH₵250\.00/);
  });
});

describe("expenses", () => {
  it("waits for the Proprietor at or above the school's amount, and keeps every record", async () => {
    const { s, bursar, bank, cashBox } = await school();
    const small = await recordExpense(conn.app, bursar, expense(cashBox, "450", { method: "cash" }));
    expect(small).toMatchObject({ expenseNumber: "E000001", status: "approved" });
    const big = await recordExpense(conn.app, bursar, expense(bank, "1000"));
    expect(big.status).toBe("pending");
    const own = await recordExpense(conn.app, s.owner, expense(bank, "5000"));
    expect(own.status).toBe("approved");

    await expect(decideExpense(conn.app, bursar, big.expenseId, { approve: true })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(decideExpense(conn.app, s.owner, big.expenseId, { approve: false })).rejects.toMatchObject({
      code: "note_required",
    });
    await decideExpense(conn.app, s.owner, big.expenseId, { approve: true });
    await expect(decideExpense(conn.app, s.owner, big.expenseId, { approve: true })).rejects.toMatchObject({
      code: "not_pending",
    });
    await voidExpense(conn.app, s.owner, own.expenseId, { reason: "Recorded twice" });

    // The database refuses changes to what was spent, and deletions.
    const scope = { tenantId: s.tenant.id, userId: s.userId() };
    await expect(
      withTenant(conn.app, scope, (tx) =>
        tx.execute(sql`update expenses set amount_pesewas = 1 where id = ${small.expenseId}`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(conn.app, scope, (tx) =>
        tx.execute(sql`delete from expenses where id = ${small.expenseId}`),
      ),
    ).rejects.toThrow();

    // Income against spending: approved expenses only.
    await s.pay((await s.addStudent("Yaw", "Darko")).id, "800", { paidOn: "2026-11-05" });
    const report = await getIncomeAndSpending(conn.app, await s.ctx("headteacher"), {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(report.totals).toEqual({
      incomePesewas: 80000,
      refundsPesewas: 0,
      spendingPesewas: 145000,
      netPesewas: -65000,
    });
    expect(report.spendingByCategory).toEqual([{ category: "Utilities", amountPesewas: 145000 }]);
    expect(report.undepositedPesewas).toBe(80000);
  });

  it("refuses dates in a closed period and needs every campus", async () => {
    const { s, bursar, bank } = await school();
    await closePeriod(conn.app, s.owner, { through: "2026-11-10" });
    await expect(recordExpense(conn.app, bursar, expense(bank, "100"))).rejects.toMatchObject({
      code: "period_locked",
    });
    await expect(recordExpense(conn.app, await s.ctx("headteacher"), expense(bank, "100"))).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe("bank statements", () => {
  it("imports a statement, matches deposits and expenses, and skips lines already imported", async () => {
    const { s, bursar, bank, kids } = await school();
    const a = await s.pay(kids[0]!.id, "300", { paidOn: "2026-11-03" });
    const b = await s.pay(kids[1]!.id, "200", { paidOn: "2026-11-03" });
    await createDeposit(conn.app, bursar, {
      accountId: bank,
      depositedOn: "2026-11-04",
      slipReference: "SLIP 0042",
      paymentIds: [a.paymentId, b.paymentId],
    });
    await recordExpense(conn.app, bursar, expense(bank, "450", { reference: "TRF 991" }));
    const transfer = await s.pay(kids[2]!.id, "1000", {
      method: "bank_transfer",
      reference: "FT2611ABCD",
      paidOn: "2026-11-06",
    });

    const csv = [
      "Date,Description,Reference,Debit,Credit,Balance",
      "04/11/2026,Cash deposit,SLIP 0042,,500.00,500.00",
      "05/11/2026,ECG prepaid,TRF 991,450.00,,50.00",
      "06/11/2026,Inward transfer FT2611ABCD,,,1000.00,1050.00",
      "07/11/2026,SMS alert charge,,1.50,,1048.50",
    ].join("\n");
    const first = await importStatement(conn.app, bursar, {
      accountId: bank,
      fileName: "nov.csv",
      text: csv,
    });
    expect(first).toMatchObject({ added: 4, skipped: 0, matched: 3 });
    const again = await importStatement(conn.app, bursar, {
      accountId: bank,
      fileName: "nov.csv",
      text: csv,
    });
    expect(again).toMatchObject({ added: 0, skipped: 4, matched: 0 });

    let rec = await getReconciliation(conn.app, bursar, bank, "2026-11");
    expect(rec.summary).toMatchObject({ inPesewas: 150000, outPesewas: 45150, unmatchedLines: 1 });
    expect(rec.depositsNotOnStatement).toEqual([]);
    expect(rec.lines.find((l) => l.reference === null && l.amountPesewas === 100000)?.match?.label).toMatch(
      /^Receipt R/,
    );
    const charge = rec.lines.find((l) => !l.match)!;
    await matchStatementLine(conn.app, bursar, charge.id, { kind: "other", note: "Bank SMS charge" });
    rec = await getReconciliation(conn.app, bursar, bank, "2026-11");
    expect(rec.summary.unmatchedLines).toBe(0);

    // Unmatching frees the record for another line; a record matches one line only.
    const transferLine = rec.lines.find((l) => l.match?.kind === "payment")!;
    await unmatchStatementLine(conn.app, bursar, transferLine.id);
    await matchStatementLine(conn.app, bursar, transferLine.id, { kind: "payment", id: transfer.paymentId });
    await expect(
      matchStatementLine(conn.app, bursar, charge.id, { kind: "payment", id: transfer.paymentId }),
    ).rejects.toMatchObject({ code: "already_matched" });
  });

  it("refuses a file without a statement in it", async () => {
    const { bursar, bank } = await school();
    await expect(
      importStatement(conn.app, bursar, { accountId: bank, fileName: "x.csv", text: "name,phone\nAma,024" }),
    ).rejects.toMatchObject({ code: "statement_empty" });
  });
});
