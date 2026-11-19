import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/context";
import { mobileMoneyRequests, notificationOutbox, smsUsage, tenants } from "@/server/db/schema";
import { billTerm, getStudentAccount } from "@/server/fees/ledger";
import { getReceipt, recordPayment } from "@/server/fees/payments";
import { mockProvider } from "@/server/mobile-money/mock";
import { reconcileSchool } from "@/server/mobile-money/reconciliation";
import {
  checkParentMobileMoneyRequest,
  mobileMoneySetup,
  parentPaymentSetup,
  requestMobileMoneyPayment,
  requestParentMobileMoneyPayment,
} from "@/server/mobile-money/requests";
import { TEMPLATES } from "@/server/notifications/templates";
import { requestParentCode } from "@/server/parents/sign-in";
import { listParentChildren } from "@/server/parents/portal";
import { addGuardian, listGuardians } from "@/server/students/guardians";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { saveMessageSettings } from "@/server/tenancy/preferences";
import { formatMoney } from "@/lib/money";
import { todayIn } from "@/lib/format";
import { renderReceiptPdf } from "@/web/pdf/receipt";
import { conn, scripted, school } from "../support/mobile-money";

afterAll(() => conn.close());

/** The mock provider collects in any currency; a real provider here (Paystack) is set up for GHS only. */
const mock = { provider: mockProvider() };
const plain = (text: string) => text.replace(/[  ]/g, " ");
const MOTHER_TYPED = "0712 345 678";
const MOTHER = "+254712345678";

/**
 * A Kenyan school end to end: billed in Kenya shillings, a guardian entered with a Kenyan number in
 * national form, a payment at the office, a parent paying by M-Pesa from the parent view, the receipt SMS
 * and PDF in shillings, and the next morning's reconciliation.
 */
async function kenyanSchool() {
  const s = await school();
  await conn.owner
    .update(tenants)
    .set({ countryCode: "KE", currencyCode: "KES", timezone: "Africa/Nairobi" })
    .where(eq(tenants.id, s.tenant.id));
  const fresh = (c: TenantContext) =>
    resolveTenantContext(conn.app, s.tenant.slug, c.userId) as Promise<TenantContext>;
  return { s, owner: await fresh(s.owner), bursar: await fresh(s.bursar) };
}

describe("a school in Kenya", () => {
  it("bills, receipts and collects M-Pesa in shillings, with Kenyan numbers, from office to parent view", async () => {
    const { s, owner, bursar } = await kenyanSchool();
    expect(bursar.tenant.currencyCode).toBe("KES");
    const wanjiru = await s.add("Wanjiru", s.classA);
    // Staff type the mother's number as Kenyans write it.
    await addGuardian(conn.app, owner, wanjiru.id, {
      fullName: "Grace Wanjiru",
      phone: MOTHER_TYPED,
      relationship: "mother",
    });
    expect((await listGuardians(conn.app, owner, wanjiru.id))![0]!.phone).toBe(MOTHER);
    await saveMessageSettings(conn.app, bursar, {
      paymentReceiptSms: true,
      autoRemindersEnabled: false,
      autoReminderIntervalDays: "14",
      autoReminderMin: "1,000",
    });

    // Fees: KES 1,000 a term (the fixture's fee structure), billed and told to the family in shillings.
    await billTerm(conn.app, bursar, s.termId, { notify: true });
    const billed = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select({ payload: notificationOutbox.payload })
        .from(smsUsage)
        .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
        .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, "fees_billed"))),
    );
    expect(TEMPLATES.fees_billed(billed[0]!.payload as never).text).toContain("Balance KES 1,000.00.");

    // At the office: KES 250.50, typed with a thousands separator style the school uses.
    const paid = await recordPayment(conn.app, bursar, {
      studentId: wanjiru.id,
      amount: "250.50",
      method: "cash",
      reference: "",
      paidOn: todayIn(bursar.tenant.timezone),
      idempotencyKey: randomUUID(),
    });
    const receipt = (await getReceipt(conn.app, bursar, paid.paymentId))!;
    expect(plain(formatMoney(receipt.amountPesewas, "KES"))).toBe("Ksh 250.50");
    const sms = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select({ payload: notificationOutbox.payload, recipient: notificationOutbox.recipient })
        .from(smsUsage)
        .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
        .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, "payment_receipt"))),
    );
    expect(sms[0]!.recipient).toBe(MOTHER);
    expect(TEMPLATES.payment_receipt(sms[0]!.payload as never).text).toContain(
      "KES 250.50 received for Wanjiru",
    );
    const pdf = await renderReceiptPdf({
      receipt,
      schoolName: s.tenant.name,
      timeZone: "Africa/Nairobi",
      currency: "KES",
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    // The parent signs in with her local number, sees the balance and pays the rest by M-Pesa.
    const { phone } = await requestParentCode(conn.app, "+254 712 345 678");
    expect(phone).toBe(MOTHER);
    const [family] = await listParentChildren(conn.app, MOTHER);
    expect(family).toMatchObject({ currency: "KES" });
    expect(family!.children[0]!.balancePesewas).toBe(100000 - 25050);
    const setup = await parentPaymentSetup(
      conn.app,
      { id: s.tenant.id, countryCode: "KE", currencyCode: "KES" },
      mock,
    );
    expect(setup.networks.map((n) => n.id)).toEqual(["mpesa", "airtel"]);
    // A Ghanaian network is not offered, and a Ghanaian number is not a Kenyan payer.
    const pay = (input: Record<string, unknown>) =>
      requestParentMobileMoneyPayment(
        conn.app,
        MOTHER,
        s.tenant.slug,
        {
          studentId: wanjiru.id,
          amount: "749.50",
          phone: MOTHER_TYPED,
          network: "mpesa",
          idempotencyKey: randomUUID(),
          ...input,
        },
        mock,
      );
    await expect(pay({ network: "mtn" })).rejects.toThrow("payer's network");
    await expect(pay({ phone: "024 123 4567" })).rejects.toThrow("mobile number in Kenya");
    const sent = await pay({});
    const settled = await checkParentMobileMoneyRequest(
      conn.app,
      MOTHER,
      s.tenant.slug,
      sent.requestId,
      mock,
    );
    expect(settled).toMatchObject({ status: "successful" });
    expect((await getStudentAccount(conn.app, bursar, wanjiru.id))!.balancePesewas).toBe(0);
    const [request] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(mobileMoneyRequests).where(eq(mobileMoneyRequests.id, sent.requestId)),
    );
    expect(request).toMatchObject({
      currency: "KES",
      network: "mpesa",
      msisdn: MOTHER,
      amountPesewas: 74950,
    });

    // The next morning's check agrees with the provider.
    expect(
      await reconcileSchool(
        conn.app,
        { id: s.tenant.id, timezone: "Africa/Nairobi" },
        todayIn("Africa/Nairobi"),
        mock,
      ),
    ).toEqual({
      checked: 1,
      matched: 1,
      differences: 0,
      errors: 0,
    });
  });

  it("does not offer Mobile Money through a provider that cannot collect shillings", async () => {
    const { s, bursar } = await kenyanSchool();
    const wanjiru = await s.add("Wanjiru", s.classA);
    const ghsOnly = scripted(); // no currencies declared: Ghana cedis only, like Paystack here
    expect(mobileMoneySetup(bursar, ghsOnly.deps).enabled).toBe(false);
    expect(
      (
        await parentPaymentSetup(
          conn.app,
          { id: s.tenant.id, countryCode: "KE", currencyCode: "KES" },
          ghsOnly.deps,
        )
      ).enabled,
    ).toBe(false);
    await expect(
      requestMobileMoneyPayment(
        conn.app,
        bursar,
        {
          studentId: wanjiru.id,
          amount: "100",
          phone: MOTHER_TYPED,
          network: "mpesa",
          idempotencyKey: randomUUID(),
        },
        ghsOnly.deps,
      ),
    ).rejects.toMatchObject({ code: "mobile_money_off" });
  });
});
