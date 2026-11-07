import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mobileMoneyProviderFromEnv } from "@/server/mobile-money/config";
import { parsePaystackReference, paystackProvider, paystackReference } from "@/server/mobile-money/paystack";
import { ProviderError, type CollectionRequest } from "@/server/mobile-money/provider";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const TEST_KEY = "sk_test_unitkey";

/** A fake Paystack: records each call and answers with the given status and body. */
function fakePaystack(answer: (path: string, body: unknown) => { status: number; body: unknown } | Error) {
  const calls: { path: string; body: unknown; auth: string | null }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.paystack.co", "");
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, auth: new Headers(init.headers).get("authorization") });
    const reply = answer(path, body);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const request = (extra: Partial<CollectionRequest> = {}): CollectionRequest => ({
  tenantId: SCHOOL,
  reference: REQUEST,
  amountPesewas: 45_050,
  currency: "GHS",
  msisdn: "+233201234567",
  network: "telecel",
  payerMessage: "School fees for Ama Mensah, Kpone Ridge",
  callbackUrl: null,
  settlementAccount: null,
  ...extra,
});

describe("Paystack payments", () => {
  it("sends the amount in pesewas, the network's code, a reference naming the school, and the subaccount", async () => {
    const paystack = fakePaystack(() => ({
      status: 200,
      body: { status: true, data: { status: "pay_offline", reference: `${SCHOOL}.${REQUEST}` } },
    }));
    const provider = paystackProvider({
      secretKey: TEST_KEY,
      customerEmailDomain: "example.com",
      fetch: paystack.fetch,
    });
    expect(await provider.requestPayment(request({ settlementAccount: "ACCT_school1" }))).toEqual({
      providerReference: `${SCHOOL}.${REQUEST}`,
    });
    expect(paystack.calls[0]).toMatchObject({
      path: "/charge",
      auth: `Bearer ${TEST_KEY}`,
      body: {
        email: "payer.233201234567@example.com",
        amount: 45_050,
        currency: "GHS",
        reference: `${SCHOOL}.${REQUEST}`,
        mobile_money: { phone: "0201234567", provider: "vod" },
        subaccount: "ACCT_school1",
      },
    });
    expect(provider.testMode).toBe(true);
    expect(provider.testHint).toContain("055 123 4987");
  });

  it("refuses clearly when Paystack declines, or asks for a code EduBridge cannot take", async () => {
    const declined = paystackProvider({
      secretKey: TEST_KEY,
      customerEmailDomain: "example.com",
      fetch: fakePaystack(() => ({
        status: 200,
        body: {
          status: true,
          data: { status: "failed", message: "Declined. Please use the test mobile money number." },
        },
      })).fetch,
    });
    await expect(declined.requestPayment(request())).rejects.toMatchObject({
      rejected: true,
      message: "Declined. Please use the test mobile money number.",
    });
    const otp = paystackProvider({
      secretKey: TEST_KEY,
      customerEmailDomain: "example.com",
      fetch: fakePaystack(() => ({ status: 200, body: { status: true, data: { status: "send_otp" } } }))
        .fetch,
    });
    await expect(otp.requestPayment(request())).rejects.toMatchObject({ rejected: true });
    const invalid = paystackProvider({
      secretKey: TEST_KEY,
      customerEmailDomain: "example.com",
      fetch: fakePaystack(() => ({ status: 400, body: { status: false, message: "Invalid phone number" } }))
        .fetch,
    });
    await expect(invalid.requestPayment(request())).rejects.toMatchObject({
      rejected: true,
      message: "Invalid phone number",
    });
  });

  it("keeps a payment pending when Paystack's answer is unknown (it may still go through)", async () => {
    for (const reply of [new Error("socket hang up"), { status: 502, body: {} }]) {
      const provider = paystackProvider({
        secretKey: TEST_KEY,
        customerEmailDomain: "example.com",
        fetch: fakePaystack(() => reply).fetch,
      });
      const error = await provider.requestPayment(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).rejected).toBe(false);
    }
  });

  it("never takes live payments for a school without its own subaccount", async () => {
    const paystack = fakePaystack(() => ({
      status: 200,
      body: { status: true, data: { status: "pay_offline" } },
    }));
    const live = paystackProvider({
      secretKey: "sk_live_x",
      customerEmailDomain: "pay.example",
      fetch: paystack.fetch,
    });
    await expect(live.requestPayment(request())).rejects.toMatchObject({ rejected: true });
    expect(paystack.calls).toHaveLength(0);
  });

  it("reads the outcome from transaction/verify", async () => {
    const answers: Record<string, { status: number; body: unknown }> = {
      [`/transaction/verify/${SCHOOL}.${REQUEST}`]: {
        status: 200,
        body: {
          status: true,
          data: {
            status: "success",
            amount: 45_050,
            currency: "GHS",
            id: 6737972637,
            paid_at: "2026-11-06T21:45:27.000Z",
          },
        },
      },
      "/transaction/verify/pending-ref": { status: 200, body: { status: true, data: { status: "ongoing" } } },
      "/transaction/verify/abandoned-ref": {
        status: 200,
        body: { status: true, data: { status: "abandoned", gateway_response: "Payer did not approve" } },
      },
      "/transaction/verify/missing-ref": {
        status: 400,
        body: { status: false, code: "transaction_not_found" },
      },
    };
    const provider = paystackProvider({
      secretKey: TEST_KEY,
      customerEmailDomain: "example.com",
      fetch: fakePaystack((path) => answers[path] ?? { status: 500, body: {} }).fetch,
    });
    expect(
      await provider.getStatus({ tenantId: SCHOOL, reference: REQUEST, providerReference: null }),
    ).toEqual({
      state: "successful",
      amountPesewas: 45_050,
      currency: "GHS",
      transactionId: "PSK-6737972637",
      completedAt: new Date("2026-11-06T21:45:27.000Z"),
    });
    const by = (providerReference: string) =>
      provider.getStatus({ tenantId: SCHOOL, reference: REQUEST, providerReference });
    expect(await by("pending-ref")).toEqual({ state: "pending" });
    expect(await by("abandoned-ref")).toEqual({ state: "failed", reason: "Payer did not approve" });
    expect(await by("missing-ref")).toEqual({ state: "not_found" });
  });

  it("accepts only webhooks signed with the secret key, and finds the school in the reference", () => {
    const provider = paystackProvider({ secretKey: TEST_KEY, customerEmailDomain: "example.com" });
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: paystackReference(SCHOOL, REQUEST) },
    });
    const sign = (text: string, key = TEST_KEY) => createHmac("sha512", key).update(text).digest("hex");
    const headers = (signature: string) => new Headers({ "x-paystack-signature": signature });
    expect(provider.verifyCallback({ headers: headers(sign(body)), rawBody: body })).toEqual({
      reference: REQUEST,
      providerReference: `${SCHOOL}.${REQUEST}`,
      tenantId: SCHOOL,
    });
    expect(
      provider.verifyCallback({ headers: headers(sign(body, "sk_test_other")), rawBody: body }),
    ).toBeNull();
    expect(provider.verifyCallback({ headers: headers(sign(body)), rawBody: `${body} ` })).toBeNull();
    // Genuine, but not one of ours: no school.
    const other = JSON.stringify({ event: "charge.success", data: { reference: "T123456" } });
    expect(provider.verifyCallback({ headers: headers(sign(other)), rawBody: other })).toEqual({
      reference: null,
      providerReference: "T123456",
      tenantId: null,
    });
    expect(parsePaystackReference(`${SCHOOL}.${REQUEST}.extra`)).toBeNull();
  });
});

describe("choosing the provider", () => {
  it("uses Paystack in test mode locally when its test key is set, and refuses live keys without approval", () => {
    expect(
      mobileMoneyProviderFromEnv({ NODE_ENV: "development", PAYSTACK_TEST_SECRET_KEY: TEST_KEY })?.name,
    ).toBe("paystack");
    expect(mobileMoneyProviderFromEnv({ NODE_ENV: "development" })?.name).toBe("mock");
    expect(
      mobileMoneyProviderFromEnv({ NODE_ENV: "production", PAYSTACK_TEST_SECRET_KEY: TEST_KEY }),
    ).toBeNull();
    expect(() =>
      mobileMoneyProviderFromEnv({
        NODE_ENV: "production",
        MOBILE_MONEY_PROVIDER: "paystack",
        PAYSTACK_SECRET_KEY: "sk_live_abc",
      }),
    ).toThrow("PAYSTACK_ALLOW_LIVE");
    expect(() =>
      mobileMoneyProviderFromEnv({
        NODE_ENV: "production",
        MOBILE_MONEY_PROVIDER: "paystack",
        PAYSTACK_SECRET_KEY: "sk_live_abc",
        PAYSTACK_ALLOW_LIVE: "true",
      }),
    ).toThrow("PAYSTACK_CUSTOMER_EMAIL_DOMAIN");
    expect(() =>
      mobileMoneyProviderFromEnv({ NODE_ENV: "development", MOBILE_MONEY_PROVIDER: "paystack" }),
    ).toThrow("PAYSTACK_SECRET_KEY");
  });
});
