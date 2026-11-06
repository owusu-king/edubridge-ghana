import { createHmac, timingSafeEqual } from "node:crypto";
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
 * web server and the worker see the same answer. With callbacks on, it posts a signed callback to the
 * request's callback URL shortly after a prompt is answered, as a real provider would.
 */
const SCENARIOS = {
  "1111": "declined",
  "2222": "no_answer",
  "3333": "wrong_amount",
  "4444": "not_registered",
} as const;

type Scenario = (typeof SCENARIOS)[keyof typeof SCENARIOS] | "approve";

const REF = /^MOCK-(approve|declined|no_answer|wrong_amount)-(\d+)-([\w-]+)$/;

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export interface MockCallbacks {
  /** Shared secret for signing callbacks (HMAC-SHA256 of the raw body). */
  secret: string;
  /** Whether the mock posts callbacks itself. Verification works either way. */
  send: boolean;
  delayMs: number;
  fetch?: typeof fetch;
}

/** The development secret, used unless MOBILE_MONEY_MOCK_SECRET is set. Never used by a real provider. */
export const DEV_MOCK_SECRET = "edubridge-mock-callbacks-dev-only";

export function signMockCallback(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function mockProvider(
  callbacks: MockCallbacks = { secret: DEV_MOCK_SECRET, send: false, delayMs: 0 },
): MobileMoneyProvider {
  function sendCallback(url: string, reference: string, providerReference: string) {
    const body = JSON.stringify({ reference, providerReference });
    const post = callbacks.fetch ?? fetch;
    setTimeout(() => {
      post(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [MOCK_SIGNATURE_HEADER]: signMockCallback(body, callbacks.secret),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // A lost callback is fine: the worker's status checks are the backstop.
      });
    }, callbacks.delayMs).unref?.();
  }

  return {
    name: "mock",
    testMode: true,
    async requestPayment(request) {
      const scenario: Scenario = SCENARIOS[request.msisdn.slice(-4) as keyof typeof SCENARIOS] ?? "approve";
      if (scenario === "not_registered")
        throw new ProviderError("This number is not registered for Mobile Money.", true);
      const providerReference = `MOCK-${scenario}-${request.amountPesewas}-${request.reference}`;
      if (callbacks.send && request.callbackUrl && scenario !== "no_answer")
        sendCallback(request.callbackUrl, request.reference, providerReference);
      return { providerReference };
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
    verifyCallback({ headers, rawBody }) {
      const given = Buffer.from(headers.get(MOCK_SIGNATURE_HEADER) ?? "");
      const expected = Buffer.from(signMockCallback(rawBody, callbacks.secret));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const { reference, providerReference } = (parsed ?? {}) as Record<string, unknown>;
      const ref = typeof reference === "string" && reference.length <= 64 ? reference : null;
      const providerRef =
        typeof providerReference === "string" && providerReference.length <= 120 ? providerReference : null;
      return ref || providerRef ? { reference: ref, providerReference: providerRef } : null;
    },
  };
}
