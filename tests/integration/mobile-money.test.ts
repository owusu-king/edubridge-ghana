import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { mobileMoneyRequests } from "@/server/db/schema";
import { pgErrorCode } from "@/server/errors";
import { billTerm } from "@/server/fees/ledger";
import { getReceipt, recordPayment } from "@/server/fees/payments";
import { ProviderError } from "@/server/mobile-money/provider";
import {
  checkMobileMoneyRequest,
  listMobileMoneyRequests,
  PROMPT_EXPIRY_MS,
} from "@/server/mobile-money/requests";
import { todayIn } from "@/lib/format";
import {
  APPROVES,
  ask,
  auditActions,
  balance,
  conn,
  DECLINES,
  mock,
  NO_ANSWER,
  NOT_REGISTERED,
  paymentsFor,
  school,
  scripted,
  WRONG_AMOUNT,
  type School,
} from "../support/mobile-money";

afterAll(() => conn.close());

describe("Mobile Money prompts", () => {
  it("records the confirmed payment with a receipt, once", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);

    const sent = await ask(s, ama.id, APPROVES, "400.50");
    expect(sent).toMatchObject({ status: "pending", replayed: false, unconfirmed: false });
    expect(await balance(s, ama.id)).toBe(100000);

    const checked = await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, mock);
    expect(checked).toMatchObject({ status: "successful", statusReason: null });
    const receipt = (await getReceipt(conn.app, s.head, checked.paymentId!))!;
    expect(receipt).toMatchObject({
      receiptNumber: "R000001",
      amountPesewas: 40050,
      method: "mobile_money",
      recordedBy: "Akosua Accountant",
      student: { name: "Ama Mensah" },
      balanceAfterPesewas: 100000 - 40050,
    });
    expect(receipt.reference).toMatch(/^MOCK\.[0-9A-F]{12}$/);
    expect(receipt.paidOn).toBe(todayIn(s.tenant.timezone));

    // Checking again changes nothing.
    expect(await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, mock)).toEqual(checked);
    expect(await paymentsFor(s, ama.id)).toHaveLength(1);
    expect(await auditActions(s, sent.requestId)).toEqual([
      "mobile_money.requested",
      "mobile_money.confirmed",
    ]);

    const [row] = await listMobileMoneyRequests(conn.app, s.head, ama.id);
    expect(row).toMatchObject({
      status: "successful",
      msisdn: "+233241234567",
      network: "mtn",
      amountPesewas: 40050,
      receiptNumber: "R000001",
      requestedBy: "Akosua Accountant",
      testMode: true,
    });
  });

  it("records one payment when the same request is checked several times at once", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, APPROVES);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, mock)),
    );
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(await paymentsFor(s, ama.id)).toHaveLength(1);
    expect(await balance(s, ama.id)).toBe(-40000);
  });

  it("sends one prompt per form, and one waiting prompt per student", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const key = randomUUID();
    const results = await Promise.all([
      ask(s, ama.id, APPROVES, "400", { idempotencyKey: key }),
      ask(s, ama.id, APPROVES, "400", { idempotencyKey: key }),
    ]);
    expect(results[0]!.requestId).toBe(results[1]!.requestId);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    await expect(ask(s, ama.id, APPROVES, "500", { idempotencyKey: key })).rejects.toMatchObject({
      code: "duplicate_submission",
    });
    await expect(ask(s, ama.id, APPROVES, "100")).rejects.toMatchObject({ code: "prompt_pending" });

    // Once the first is settled, another prompt can go out.
    await checkMobileMoneyRequest(conn.app, s.bursar, results[0]!.requestId, mock);
    expect(await ask(s, ama.id, APPROVES, "100")).toMatchObject({ status: "pending" });
  });

  it("records nothing when the payer declines or the number is not registered", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const declined = await ask(s, ama.id, DECLINES);
    expect(await checkMobileMoneyRequest(conn.app, s.bursar, declined.requestId, mock)).toMatchObject({
      status: "failed",
      statusReason: "The payer declined the prompt.",
      paymentId: null,
    });

    await expect(ask(s, ama.id, NOT_REGISTERED)).rejects.toMatchObject({
      code: "provider_rejected",
      field: "phone",
      message: "This number is not registered for Mobile Money.",
    });
    const rows = await listMobileMoneyRequests(conn.app, s.bursar, ama.id);
    expect(rows.map((r) => [r.status, r.statusReason])).toEqual([
      ["failed", "This number is not registered for Mobile Money."],
      ["failed", "The payer declined the prompt."],
    ]);
    expect(await paymentsFor(s, ama.id)).toHaveLength(0);
  });

  it("holds a payment for review when the network reports a different amount", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, WRONG_AMOUNT, "400");
    const checked = await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, mock);
    expect(checked).toMatchObject({
      status: "needs_review",
      statusReason: "The network reported GH₵399.00, not the GH₵400.00 requested.",
      paymentId: null,
    });
    expect(await paymentsFor(s, ama.id)).toHaveLength(0);
    // Reviewed requests are final; the accountant records what actually arrived by hand.
    expect(await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, mock)).toEqual(checked);
    expect(await auditActions(s, sent.requestId)).toContain("mobile_money.needs_review");
  });

  it("expires an unanswered prompt, and still records a late confirmation", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const { state, deps } = scripted();
    const sent = await ask(s, ama.id, NO_ANSWER, "250", {}, deps);
    expect(await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, deps)).toMatchObject({
      status: "pending",
    });
    const later = new Date(Date.now() + PROMPT_EXPIRY_MS + 60_000);
    expect(
      await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, { ...deps, now: later }),
    ).toMatchObject({ status: "expired" });
    // The student is free for a new prompt.
    const second = await ask(s, ama.id, APPROVES, "100", {}, deps);

    state.status = {
      state: "successful",
      amountPesewas: 25000,
      currency: "GHS",
      transactionId: "TX-LATE-1",
      completedAt: null,
    };
    expect(await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, deps)).toMatchObject({
      status: "successful",
    });
    expect((await paymentsFor(s, ama.id)).map((p) => [p.amountPesewas, p.reference])).toEqual([
      [25000, "TX-LATE-1"],
    ]);
    expect((await listMobileMoneyRequests(conn.app, s.bursar, ama.id))[0]!.id).toBe(second.requestId);
  });

  it("keeps a prompt pending when sending is unconfirmed, and fails it if the network never got it", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const { state, deps } = scripted({ state: "not_found" });
    state.fail = new ProviderError("The network did not respond.");
    const sent = await ask(s, ama.id, APPROVES, "100", {}, deps);
    expect(sent).toMatchObject({ status: "pending", unconfirmed: true });
    // Too soon to conclude anything.
    expect(await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, deps)).toMatchObject({
      status: "pending",
    });
    const later = new Date(Date.now() + 6 * 60_000);
    expect(
      await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, { ...deps, now: later }),
    ).toMatchObject({
      status: "failed",
      statusReason: "The network has no record of this prompt, so it was not sent.",
    });
  });

  it("refuses to check a request with a different provider than the one that sent it", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, APPROVES);
    await expect(
      checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, scripted().deps),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(
      checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, { provider: null }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(ask(s, ama.id, APPROVES, "1", {}, { provider: null })).rejects.toMatchObject({
      code: "mobile_money_off",
    });
  });

  it("validates the amount and phone number", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    for (const [amount, phone, field] of [
      ["0", APPROVES, "amount"],
      ["12.345", APPROVES, "amount"],
      ["100", "+44 7700 900123", "phone"],
      ["100", "030 221 2345", "phone"],
    ] as const) {
      const error = await ask(s, ama.id, phone, amount).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues[0]!.path).toEqual([field]);
    }
    await expect(ask(s, ama.id, APPROVES, "100", { network: "glo" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("Mobile Money permissions", () => {
  it("lets only finance staff with access to the student send and check prompts", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const esi = await s.add("Esi", s.classB);
    await expect(ask(s, ama.id, APPROVES, "100", {}, mock, s.head)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ask(s, ama.id, APPROVES, "100", {}, mock, s.teacher)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMobileMoneyRequests(conn.app, s.teacher, ama.id)).rejects.toBeInstanceOf(ForbiddenError);

    // The East campus accountant cannot reach a Main campus student or their prompts.
    await expect(ask(s, ama.id, APPROVES, "100", {}, mock, s.eastBursar)).rejects.toMatchObject({
      code: "student_not_found",
    });
    const sent = await ask(s, ama.id, APPROVES, "100", {}, mock, s.owner);
    await expect(checkMobileMoneyRequest(conn.app, s.eastBursar, sent.requestId, mock)).rejects.toMatchObject(
      { code: "request_not_found" },
    );
    expect(await listMobileMoneyRequests(conn.app, s.eastBursar, ama.id)).toEqual([]);
    await expect(checkMobileMoneyRequest(conn.app, s.head, sent.requestId, mock)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await ask(s, esi.id, APPROVES, "100", {}, mock, s.eastBursar)).toMatchObject({
      status: "pending",
    });

    // Another school cannot see the request at all.
    const other = await school();
    await expect(checkMobileMoneyRequest(conn.app, other.bursar, sent.requestId, mock)).rejects.toMatchObject(
      { code: "request_not_found" },
    );
  });
});

describe("Mobile Money database guards", () => {
  const asApp = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(conn.app, { tenantId: s.tenant.id, userId: s.bursar.userId }, fn);
  const failure = (promise: Promise<unknown>) => promise.then(() => null, pgErrorCode);

  it("never changes what was asked for, never reopens an outcome, and never deletes", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, APPROVES);
    const byId = eq(mobileMoneyRequests.id, sent.requestId);

    expect(
      await failure(asApp(s, (tx) => tx.update(mobileMoneyRequests).set({ amountPesewas: 1 }).where(byId))),
    ).toBe("23001");
    expect(
      await failure(
        asApp(s, (tx) => tx.update(mobileMoneyRequests).set({ msisdn: "+233200000000" }).where(byId)),
      ),
    ).toBe("23001");
    expect(await failure(asApp(s, (tx) => tx.delete(mobileMoneyRequests).where(byId)))).not.toBeNull();

    await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, mock);
    expect(
      await failure(
        asApp(s, (tx) =>
          tx
            .update(mobileMoneyRequests)
            .set({ status: "failed", paymentId: null, statusReason: "x", transactionId: null })
            .where(byId),
        ),
      ),
    ).toBe("23001");
  });

  it("only links a request to a matching Mobile Money payment", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const esi = await s.add("Esi", s.classA);
    const sent = await ask(s, ama.id, APPROVES, "400");
    const pay = (studentId: string, amount: string, method: string) =>
      recordPayment(conn.app, s.bursar, {
        studentId,
        amount,
        method,
        reference: method === "cash" ? undefined : "REF-1",
        paidOn: todayIn(s.tenant.timezone),
        idempotencyKey: randomUUID(),
      });
    const settle = (paymentId: string) =>
      asApp(s, (tx) =>
        tx
          .update(mobileMoneyRequests)
          .set({ status: "successful", paymentId, transactionId: "REF-1", completedAt: new Date() })
          .where(eq(mobileMoneyRequests.id, sent.requestId)),
      );
    expect(await failure(settle((await pay(esi.id, "400", "mobile_money")).paymentId))).toBe("23514");
    expect(await failure(settle((await pay(ama.id, "300", "mobile_money")).paymentId))).toBe("23514");
    expect(await failure(settle((await pay(ama.id, "400", "cash")).paymentId))).toBe("23514");
  });
});
