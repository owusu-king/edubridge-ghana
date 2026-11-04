import { ProviderError, type MobileMoneyProvider } from "./provider";

/**
 * A stand-in provider for development and tests. No money moves and nothing is sent. The payer
 * "approves" every prompt, except for numbers ending in:
 *
 *   1111  declined by the payer
 *   2222  never answered (stays pending)
 *   3333  approved, but the network reports GH₵1.00 less than requested
 *   4444  not registered for Mobile Money (refused straight away)
 *
 * It keeps no state: the outcome and amount are carried in the provider reference it issues, so the
 * web server and the worker see the same answer.
 */
const SCENARIOS = {
  "1111": "declined",
  "2222": "no_answer",
  "3333": "wrong_amount",
  "4444": "not_registered",
} as const;

type Scenario = (typeof SCENARIOS)[keyof typeof SCENARIOS] | "approve";

export const MOCK_TEST_NUMBERS = SCENARIOS;

const REF = /^MOCK-(approve|declined|no_answer|wrong_amount)-(\d+)-([\w-]+)$/;

export function mockProvider(): MobileMoneyProvider {
  return {
    name: "mock",
    testMode: true,
    async requestPayment(request) {
      const scenario: Scenario = SCENARIOS[request.msisdn.slice(-4) as keyof typeof SCENARIOS] ?? "approve";
      if (scenario === "not_registered")
        throw new ProviderError("This number is not registered for Mobile Money.", true);
      return { providerReference: `MOCK-${scenario}-${request.amountPesewas}-${request.reference}` };
    },
    async getStatus({ providerReference }) {
      const match = providerReference ? REF.exec(providerReference) : null;
      if (!match) return { state: "not_found" };
      const [, scenario, amount, reference] = match;
      const transactionId = `MOCK.${reference!.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
      switch (scenario as Exclude<Scenario, "not_registered">) {
        case "declined":
          return { state: "failed", reason: "The payer declined the prompt." };
        case "no_answer":
          return { state: "pending" };
        case "wrong_amount":
          return {
            state: "successful",
            amountPesewas: Number(amount) - 100,
            currency: "GHS",
            transactionId,
            completedAt: null,
          };
        case "approve":
          return {
            state: "successful",
            amountPesewas: Number(amount),
            currency: "GHS",
            transactionId,
            completedAt: null,
          };
      }
    },
  };
}
