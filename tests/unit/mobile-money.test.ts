import { describe, expect, it } from "vitest";
import { suggestNetwork } from "@/lib/mobile-money";
import { mobileMoneyProviderFromEnv } from "@/server/mobile-money/config";
import { mockProvider } from "@/server/mobile-money/mock";
import { ProviderError } from "@/server/mobile-money/provider";

describe("suggestNetwork", () => {
  it("suggests the network a number was issued on, in any common format", () => {
    expect(suggestNetwork("024 123 4567")).toBe("mtn");
    expect(suggestNetwork("+233 59 123 4567")).toBe("mtn");
    expect(suggestNetwork("0201234567")).toBe("telecel");
    expect(suggestNetwork("233501234567")).toBe("telecel");
    expect(suggestNetwork("027-123-4567")).toBe("at");
    expect(suggestNetwork("056 123 4567")).toBe("at");
  });

  it("returns null for unknown prefixes and incomplete numbers", () => {
    expect(suggestNetwork("030 221 2345")).toBeNull();
    expect(suggestNetwork("024 123")).toBeNull();
    expect(suggestNetwork("")).toBeNull();
  });
});

describe("mock provider", () => {
  const provider = mockProvider();
  const request = (msisdn: string, amountPesewas = 5000) =>
    provider.requestPayment({
      reference: "0f6c2a8e-1111-4c1d-9a1e-2b3c4d5e6f70",
      amountPesewas,
      currency: "GHS",
      msisdn,
      network: "mtn",
      payerMessage: "School fees",
      callbackUrl: null,
    });

  it("approves by default, with a stable transaction id", async () => {
    const started = await request("+233241234567");
    const first = await provider.getStatus({ reference: "x", providerReference: started.providerReference });
    expect(first).toEqual({
      state: "successful",
      amountPesewas: 5000,
      currency: "GHS",
      transactionId: "MOCK.0F6C2A8E1111",
      completedAt: null,
    });
    expect(
      await provider.getStatus({ reference: "x", providerReference: started.providerReference }),
    ).toEqual(first);
  });

  it("simulates declines, unanswered prompts and amount mismatches by number", async () => {
    const status = async (msisdn: string) =>
      provider.getStatus({ reference: "x", providerReference: (await request(msisdn)).providerReference });
    expect(await status("+233245551111")).toEqual({
      state: "failed",
      reason: "The payer declined the prompt.",
    });
    expect(await status("+233245552222")).toEqual({ state: "pending" });
    expect(await status("+233245553333")).toMatchObject({ state: "successful", amountPesewas: 4900 });
  });

  it("refuses unregistered numbers and knows nothing of other references", async () => {
    await expect(request("+233245554444")).rejects.toEqual(
      new ProviderError("This number is not registered for Mobile Money.", true),
    );
    expect(await provider.getStatus({ reference: "x", providerReference: null })).toEqual({
      state: "not_found",
    });
    expect(await provider.getStatus({ reference: "x", providerReference: "OTHER-1" })).toEqual({
      state: "not_found",
    });
  });
});

describe("mobileMoneyProviderFromEnv", () => {
  it("uses the mock outside production and nothing in production unless asked", () => {
    expect(mobileMoneyProviderFromEnv({ NODE_ENV: "development" })?.name).toBe("mock");
    expect(mobileMoneyProviderFromEnv({ NODE_ENV: "test" })?.testMode).toBe(true);
    expect(mobileMoneyProviderFromEnv({ NODE_ENV: "production" })).toBeNull();
    expect(mobileMoneyProviderFromEnv({ NODE_ENV: "production", MOBILE_MONEY_PROVIDER: "mock" })?.name).toBe(
      "mock",
    );
    expect(mobileMoneyProviderFromEnv({ NODE_ENV: "development", MOBILE_MONEY_PROVIDER: "none" })).toBeNull();
  });

  it("rejects unknown providers instead of silently turning Mobile Money off", () => {
    expect(() =>
      mobileMoneyProviderFromEnv({ NODE_ENV: "production", MOBILE_MONEY_PROVIDER: "mtn" }),
    ).toThrow(/Unknown MOBILE_MONEY_PROVIDER/);
  });
});
