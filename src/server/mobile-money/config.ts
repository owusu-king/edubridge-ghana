import { DEV_MOCK_SECRET, mockProvider } from "./mock";
import type { MobileMoneyProvider } from "./provider";

/**
 * The Mobile Money provider for this deployment, from MOBILE_MONEY_PROVIDER:
 *   unset   the mock outside production; none in production
 *   "mock"  the mock (explicit, e.g. for end-to-end tests of a production build)
 *   "none"  Mobile Money is off
 * The mock posts its own signed callbacks unless MOBILE_MONEY_MOCK_CALLBACKS is "false"
 * (delay MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS, secret MOBILE_MONEY_MOCK_SECRET).
 * Real providers are added here once approved. Returns null when Mobile Money is off.
 */
export function mobileMoneyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): MobileMoneyProvider | null {
  const name = env.MOBILE_MONEY_PROVIDER?.trim() || (env.NODE_ENV === "production" ? "none" : "mock");
  switch (name) {
    case "none":
      return null;
    case "mock":
      return mockProvider({
        secret: env.MOBILE_MONEY_MOCK_SECRET || DEV_MOCK_SECRET,
        send: env.MOBILE_MONEY_MOCK_CALLBACKS !== "false",
        delayMs: Math.max(0, Number(env.MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS ?? 3000) || 0),
      });
    default:
      throw new Error(`Unknown MOBILE_MONEY_PROVIDER "${name}". Use "mock" or "none".`);
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
