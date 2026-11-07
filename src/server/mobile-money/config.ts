import { DEV_MOCK_SECRET, mockProvider } from "./mock";
import { paystackProvider } from "./paystack";
import type { MobileMoneyProvider } from "./provider";

/**
 * The Mobile Money provider for this deployment, from MOBILE_MONEY_PROVIDER:
 *   unset       outside production: Paystack in test mode when PAYSTACK_TEST_SECRET_KEY is set, else the
 *               mock; in production: none
 *   "paystack"  Paystack, with PAYSTACK_SECRET_KEY (or PAYSTACK_TEST_SECRET_KEY). A live key (sk_live_)
 *               also needs PAYSTACK_ALLOW_LIVE=true, set only once the founder approves real payments,
 *               and PAYSTACK_CUSTOMER_EMAIL_DOMAIN (a domain EduBridge controls)
 *   "mock"      the mock (explicit, e.g. for end-to-end tests of a production build)
 *   "none"      Mobile Money is off
 * The mock posts its own signed callbacks unless MOBILE_MONEY_MOCK_CALLBACKS is "false"
 * (delay MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS, secret MOBILE_MONEY_MOCK_SECRET).
 * Returns null when Mobile Money is off.
 */
export function mobileMoneyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): MobileMoneyProvider | null {
  const fallback =
    env.NODE_ENV === "production" ? "none" : env.PAYSTACK_TEST_SECRET_KEY?.trim() ? "paystack" : "mock";
  const name = env.MOBILE_MONEY_PROVIDER?.trim() || fallback;
  switch (name) {
    case "none":
      return null;
    case "paystack": {
      const secretKey = (env.PAYSTACK_SECRET_KEY || env.PAYSTACK_TEST_SECRET_KEY || "").trim();
      if (!/^sk_(test|live)_\w+$/.test(secretKey))
        throw new Error(
          "MOBILE_MONEY_PROVIDER is paystack, but PAYSTACK_SECRET_KEY is missing or not a Paystack secret key.",
        );
      const live = secretKey.startsWith("sk_live_");
      if (live && env.PAYSTACK_ALLOW_LIVE !== "true")
        throw new Error(
          "A live Paystack key needs PAYSTACK_ALLOW_LIVE=true: real payments wait for the founder's approval.",
        );
      const domain = env.PAYSTACK_CUSTOMER_EMAIL_DOMAIN?.trim();
      if (live && !domain)
        throw new Error(
          "Live Paystack payments need PAYSTACK_CUSTOMER_EMAIL_DOMAIN, a domain EduBridge controls.",
        );
      return paystackProvider({ secretKey, customerEmailDomain: domain || "example.com" });
    }
    case "mock":
      return mockProvider({
        secret: env.MOBILE_MONEY_MOCK_SECRET || DEV_MOCK_SECRET,
        send: env.MOBILE_MONEY_MOCK_CALLBACKS !== "false",
        delayMs: Math.max(0, Number(env.MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS ?? 3000) || 0),
      });
    default:
      throw new Error(`Unknown MOBILE_MONEY_PROVIDER "${name}". Use "paystack", "mock" or "none".`);
  }
}

let cached: { provider: MobileMoneyProvider | null } | undefined;

/** The configured provider, read once per process. */
export function mobileMoneyProvider(): MobileMoneyProvider | null {
  cached ??= { provider: mobileMoneyProviderFromEnv() };
  return cached.provider;
}

/** Where providers send callbacks for a school, or null when APP_URL is not set. */
export function callbackUrlFor(
  providerName: string,
  tenantId: string,
  baseUrl: string | undefined = process.env.APP_URL,
): string | null {
  if (!baseUrl) return null;
  return new URL(`/api/v1/mobile-money/callbacks/${providerName}/${tenantId}`, baseUrl).toString();
}
