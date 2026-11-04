import { mockProvider } from "./mock";
import type { MobileMoneyProvider } from "./provider";

/**
 * The Mobile Money provider for this deployment, from MOBILE_MONEY_PROVIDER:
 *   unset   the mock outside production; none in production
 *   "mock"  the mock (explicit, e.g. for end-to-end tests of a production build)
 *   "none"  Mobile Money is off
 * Real providers are added here once approved. Returns null when Mobile Money is off.
 */
export function mobileMoneyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): MobileMoneyProvider | null {
  const name = env.MOBILE_MONEY_PROVIDER?.trim() || (env.NODE_ENV === "production" ? "none" : "mock");
  switch (name) {
    case "none":
      return null;
    case "mock":
      return mockProvider();
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
