import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/context";
import { billTerm } from "@/server/fees/ledger";
import { listFinanceChecks } from "@/server/forecasting/checks";
import {
  checkParentMobileMoneyRequest,
  listParentPaymentAttempts,
  requestParentFamilyPayment,
  requestParentMobileMoneyPayment,
} from "@/server/mobile-money/requests";
import { addGuardian } from "@/server/students/guardians";
import {
  APPROVES,
  balance,
  conn,
  DECLINES,
  mock,
  paymentsFor,
  school,
  WRONG_AMOUNT,
} from "../support/mobile-money";

afterAll(() => conn.close());

const PARENT = "+233245550101";

/** Three children with one mother's number, all billed GH₵1,000. */
async function family() {
  const s = await school();
  const kids = [];
  for (const name of ["Ama", "Kofi", "Yaw"]) {
    const child = await s.add(name, s.classA);
    await addGuardian(conn.app, s.owner, child.id, {
      fullName: "Akosua Mensah",
      phone: "024 555 0101",
      relationship: "mother",
    });
    kids.push(child);
  }
  await billTerm(conn.app, s.bursar, s.termId);
  const [ama, kofi, yaw] = kids as [(typeof kids)[0], (typeof kids)[0], (typeof kids)[0]];
  const payFamily = (shares: { studentId: string; amount: string }[], payer = APPROVES, key = randomUUID()) =>
    requestParentFamilyPayment(
      conn.app,
      PARENT,
      s.tenant.slug,
      { shares, phone: payer, network: "mtn", idempotencyKey: key },
      mock,
    );
  const check = (requestId: string) =>
    checkParentMobileMoneyRequest(conn.app, PARENT, s.tenant.slug, requestId, mock);
  return { s, ama, kofi, yaw, payFamily, check };
}

describe("family payments (one prompt for several children)", () => {
  it("records one receipt per child for exactly their share", async () => {
    const { s, ama, kofi, yaw, payFamily, check } = await family();
    const sent = await payFamily([
      { studentId: ama.id, amount: "1000" },
      { studentId: kofi.id, amount: "250.50" },
      { studentId: yaw.id, amount: "" },
    ]);
    expect(await check(sent.requestId)).toMatchObject({ status: "successful" });

    expect(await balance(s, ama.id)).toBe(0);
    expect(await balance(s, kofi.id)).toBe(100000 - 25050);
    expect(await balance(s, yaw.id)).toBe(100000);
    expect(await paymentsFor(s, ama.id)).toHaveLength(1);
    expect(await paymentsFor(s, kofi.id)).toHaveLength(1);
    expect(await paymentsFor(s, yaw.id)).toHaveLength(0);

    // Each child's page shows their own part and receipt, and the family total.
    const [kofiAttempt] = (await listParentPaymentAttempts(conn.app, PARENT, s.tenant.slug, kofi.id))!;
    expect(kofiAttempt).toMatchObject({
      status: "successful",
      amountPesewas: 25050,
      totalPesewas: 125050,
      family: true,
    });
    expect(kofiAttempt!.receiptNumber).toMatch(/^R\d{6}$/);

    // Checking again records nothing twice.
    await check(sent.requestId);
    expect(await paymentsFor(s, kofi.id)).toHaveLength(1);

    // The shared transaction ID is one payment, not a repeated reference for finance checks.
    const checks = await listFinanceChecks(conn.app, s.owner, s.termId);
    expect(checks!.flags.filter((f) => f.rule === "duplicate_reference")).toEqual([]);
  });

  it("refuses more than a child owes, children not linked to the number, and a second prompt while one waits", async () => {
    const { s, ama, kofi, payFamily } = await family();
    await expect(
      payFamily([
        { studentId: ama.id, amount: "500" },
        { studentId: kofi.id, amount: "1000.01" },
      ]),
    ).rejects.toMatchObject({ code: "amount_over_balance" });
    const stranger = await s.add("Esi", s.classA);
    await expect(
      payFamily([
        { studentId: ama.id, amount: "500" },
        { studentId: stranger.id, amount: "100" },
      ]),
    ).rejects.toMatchObject({ code: "student_not_found" });
    await expect(payFamily([{ studentId: ama.id, amount: "" }])).rejects.toThrow();

    // A family prompt waiting blocks a single prompt for one of its children, and the other way round.
    await payFamily(
      [
        { studentId: ama.id, amount: "100" },
        { studentId: kofi.id, amount: "100" },
      ],
      "024 555 2222",
    );
    await expect(
      requestParentMobileMoneyPayment(
        conn.app,
        PARENT,
        s.tenant.slug,
        { studentId: kofi.id, amount: "50", phone: APPROVES, network: "mtn", idempotencyKey: randomUUID() },
        mock,
      ),
    ).rejects.toMatchObject({ code: "prompt_pending" });
  });

  it("takes no money when declined, and holds a wrong amount for review", async () => {
    const { s, ama, kofi, payFamily, check } = await family();
    const shares = [
      { studentId: ama.id, amount: "100" },
      { studentId: kofi.id, amount: "100" },
    ];
    const declined = await payFamily(shares, DECLINES);
    expect(await check(declined.requestId)).toMatchObject({ status: "failed" });
    const wrong = await payFamily(shares, WRONG_AMOUNT);
    expect(await check(wrong.requestId)).toMatchObject({ status: "needs_review" });
    expect(await paymentsFor(s, ama.id)).toHaveLength(0);
    expect(await paymentsFor(s, kofi.id)).toHaveLength(0);
  });

  it("keeps shares unchangeable in the database", async () => {
    const { s, ama, kofi, payFamily, check } = await family();
    const sent = await payFamily([
      { studentId: ama.id, amount: "100" },
      { studentId: kofi.id, amount: "200" },
    ]);
    await check(sent.requestId);
    const scope = { tenantId: s.tenant.id, userId: s.owner.userId };
    await expect(
      withTenant(conn.app, scope, (tx) =>
        tx.execute(
          sql`update mobile_money_request_shares set amount_pesewas = 1 where request_id = ${sent.requestId}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(conn.app, scope, (tx) =>
        tx.execute(
          sql`update mobile_money_request_shares set payment_id = null where request_id = ${sent.requestId}`,
        ),
      ),
    ).rejects.toThrow();
  });
});
