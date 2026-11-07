import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { processMobileMoneyCallbacks, receiveMobileMoneyCallback } from "@/server/mobile-money/callbacks";
import { paystackProvider, paystackReference, PAYSTACK_TEST_NUMBER } from "@/server/mobile-money/paystack";
import { checkMobileMoneyRequest, type MobileMoneyDeps } from "@/server/mobile-money/requests";
import { ask, conn, paymentsFor, school } from "../support/mobile-money";

afterAll(() => conn.close());

/**
 * Against Paystack's real test mode (no money moves). Runs only when PAYSTACK_TEST_SECRET_KEY is in the
 * environment, e.g. exported from .env.local; skipped otherwise (CI has no key).
 */
const key = process.env.PAYSTACK_TEST_SECRET_KEY?.trim();
const describeSandbox = key?.startsWith("sk_test_") ? describe : describe.skip;

describeSandbox("Paystack test mode", () => {
  const deps: MobileMoneyDeps = {
    provider: paystackProvider({ secretKey: key ?? "", customerEmailDomain: "example.com" }),
  };

  it("collects from Paystack's MTN test number and issues a receipt once verified", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const sent = await ask(s, ama, PAYSTACK_TEST_NUMBER, "1.50", {}, deps);
    expect(sent.status).toBe("pending");
    const checked = await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, deps);
    expect(checked.status).toBe("successful");
    const [payment] = await paymentsFor(s, ama);
    expect(payment).toMatchObject({ amountPesewas: 150, method: "mobile_money" });
    expect(payment!.reference).toMatch(/^PSK-\d+$/);
  }, 60_000);

  it("settles a payment from a signed webhook, finding the school in the reference", async () => {
    const s = await school();
    const kofi = (await s.add("Kofi", s.classA)).id;
    const sent = await ask(s, kofi, PAYSTACK_TEST_NUMBER, "2", {}, deps);
    const rawBody = JSON.stringify({
      event: "charge.success",
      data: { reference: paystackReference(s.tenant.id, sent.requestId) },
    });
    const headers = new Headers({
      "x-paystack-signature": createHmac("sha512", key!).update(rawBody).digest("hex"),
    });
    const receipt = await receiveMobileMoneyCallback(
      conn.app,
      { providerName: "paystack", tenantId: null, headers, rawBody },
      deps,
    );
    expect(receipt.kind).toBe("accepted");
    if (receipt.kind !== "accepted") return;
    await processMobileMoneyCallbacks(conn.app, receipt.school, deps);
    expect((await paymentsFor(s, kofi)).map((p) => p.amountPesewas)).toEqual([200]);
    // A forged webhook is refused before anything is stored.
    const forged = await receiveMobileMoneyCallback(
      conn.app,
      {
        providerName: "paystack",
        tenantId: null,
        headers: new Headers({ "x-paystack-signature": "0" }),
        rawBody,
      },
      deps,
    );
    expect(forged.kind).toBe("invalid_signature");
  }, 60_000);

  it("passes on Paystack's refusal for numbers other than the test number", async () => {
    const s = await school();
    const esi = (await s.add("Esi", s.classA)).id;
    await expect(ask(s, esi, "024 123 4567", "1", {}, deps)).rejects.toMatchObject({
      code: "provider_rejected",
    });
  }, 60_000);
});
