import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { FEATURES } from "@/lib/plan";
import { updateEntitlements } from "@/server/platform/service";
import { billTerm } from "@/server/fees/ledger";
import {
  checkParentMobileMoneyRequest,
  listParentPaymentAttempts,
  parentPaymentSetup,
  requestParentMobileMoneyPayment,
} from "@/server/mobile-money/requests";
import { addGuardian } from "@/server/students/guardians";
import {
  APPROVES,
  auditActions,
  balance,
  conn,
  DECLINES,
  mock,
  paymentsFor,
  school,
} from "../support/mobile-money";
import { createUser, makePlatformAdmin } from "../support/fixtures";

afterAll(() => conn.close());

const PARENT = "+233245550101";

async function family() {
  const s = await school();
  const ama = await s.add("Ama", s.classA);
  await addGuardian(conn.app, s.owner, ama.id, {
    fullName: "Akosua Mensah",
    phone: "024 555 0101",
    relationship: "mother",
  });
  await billTerm(conn.app, s.bursar, s.termId);
  const pay = (amount: string, payer = APPROVES, studentId = ama.id, phone = PARENT, slug = s.tenant.slug) =>
    requestParentMobileMoneyPayment(
      conn.app,
      phone,
      slug,
      { studentId, amount, phone: payer, network: "mtn", idempotencyKey: randomUUID() },
      mock,
    );
  return { s, ama, pay };
}

describe("parents paying online", () => {
  it("records a confirmed payment with a receipt, in part or in full, never more than is owed", async () => {
    const { s, ama, pay } = await family();
    expect(await parentPaymentSetup(conn.app, s.tenant, mock)).toMatchObject({
      enabled: true,
      testMode: true,
    });

    await expect(pay("1000.01")).rejects.toMatchObject({ code: "amount_over_balance" });
    const sent = await pay("400");
    expect(sent).toMatchObject({ status: "pending", replayed: false });
    const checked = await checkParentMobileMoneyRequest(
      conn.app,
      PARENT,
      s.tenant.slug,
      sent.requestId,
      mock,
    );
    expect(checked).toMatchObject({ status: "successful" });
    expect(await balance(s, ama.id)).toBe(60000);
    expect(await auditActions(s, sent.requestId)).toEqual([
      "mobile_money.requested",
      "mobile_money.confirmed",
    ]);

    const [attempt] = (await listParentPaymentAttempts(conn.app, PARENT, s.tenant.slug, ama.id))!;
    expect(attempt).toMatchObject({ status: "successful", amountPesewas: 40000, receiptNumber: "R000001" });

    // The rest of the balance, then nothing is owed.
    const rest = await pay("600");
    await checkParentMobileMoneyRequest(conn.app, PARENT, s.tenant.slug, rest.requestId, mock);
    expect(await balance(s, ama.id)).toBe(0);
    await expect(pay("1")).rejects.toMatchObject({ code: "nothing_owed" });
    expect(await paymentsFor(s, ama.id)).toHaveLength(2);
  });

  it("shows a declined payment as failed and takes no money", async () => {
    const { s, ama, pay } = await family();
    const sent = await pay("100", DECLINES);
    expect(
      await checkParentMobileMoneyRequest(conn.app, PARENT, s.tenant.slug, sent.requestId, mock),
    ).toMatchObject({
      status: "failed",
    });
    expect(await balance(s, ama.id)).toBe(100000);
    const [attempt] = (await listParentPaymentAttempts(conn.app, PARENT, s.tenant.slug, ama.id))!;
    expect(attempt!.status).toBe("failed");
  });

  it("only for children linked to the parent's number, at a school that takes Mobile Money", async () => {
    const { s, ama, pay } = await family();
    const kofi = await s.add("Kofi", s.classA);
    await expect(pay("100", APPROVES, kofi.id)).rejects.toMatchObject({ code: "student_not_found" });
    await expect(pay("100", APPROVES, ama.id, "+233200000000")).rejects.toMatchObject({
      code: "student_not_found",
    });
    const other = await school();
    await expect(pay("100", APPROVES, ama.id, PARENT, other.tenant.slug)).rejects.toMatchObject({
      code: "student_not_found",
    });

    // Someone else's number cannot see or check the child's payments.
    const sent = await pay("100");
    expect(await listParentPaymentAttempts(conn.app, "+233200000000", s.tenant.slug, ama.id)).toBeNull();
    expect(
      await checkParentMobileMoneyRequest(conn.app, "+233200000000", s.tenant.slug, sent.requestId, mock),
    ).toBeNull();

    // Without Mobile Money in the plan, parents cannot pay; without a provider either.
    const admin = await createUser(conn.owner, "EduBridge Staff");
    await makePlatformAdmin(conn.owner, admin.id);
    await updateEntitlements(conn.app, admin.id, s.tenant.id, {
      planName: "No Mobile Money",
      maxCampuses: 2,
      maxStudents: null,
      maxSmsPerMonth: null,
      features: FEATURES.filter((f) => f !== "mobile_money"),
    });
    await expect(pay("100")).rejects.toMatchObject({ code: "mobile_money_off" });
    expect((await parentPaymentSetup(conn.app, s.tenant, { provider: null })).enabled).toBe(false);
    // The prompt already sent is still settled.
    expect(
      await checkParentMobileMoneyRequest(conn.app, PARENT, s.tenant.slug, sent.requestId, mock),
    ).toMatchObject({
      status: "successful",
    });
  });
});
