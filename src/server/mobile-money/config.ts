import { DEV_MOCK_SECRET, mockProvider } from "./mock";
import { paystackProvider } from "./paystack";
import type { MobileMoneyProvider } from "./provider";

/**
 * Mobile Money providers (PAY-06): which ones this deployment can use, which one is the default, and which
 * one each school uses. A school's choice is set by platform staff (`tenant_entitlements.
 * mobile_money_provider`; null: the deployment's default). A prompt is always checked, and its callbacks
 * verified, with the provider that sent it, so changing a school's provider never strands money in flight.
 *
 * MOBILE_MONEY_PROVIDER sets the default:
 *   unset       outside production: Paystack in test mode when PAYSTACK_TEST_SECRET_KEY is set, else the
 *               mock; in production: none
 *   "paystack"  Paystack, with PAYSTACK_SECRET_KEY (or PAYSTACK_TEST_SECRET_KEY). A live key (sk_live_)
 *               also needs PAYSTACK_ALLOW_LIVE=true, set only once the founder approves real payments,
 *               and PAYSTACK_CUSTOMER_EMAIL_DOMAIN (a domain EduBridge controls)
 *   "mock"      the mock (explicit, e.g. for end-to-end tests of a production build)
 *   "none"      no default (schools can still be given a provider that is available)
 * Available: Paystack whenever a Paystack key is set; the mock outside production, or in production only
 * when MOBILE_MONEY_PROVIDER is "mock" or MOBILE_MONEY_MOCK_SECRET is set (for demo schools). The mock posts
 * its own signed callbacks unless MOBILE_MONEY_MOCK_CALLBACKS is "false" (delay
 * MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS, secret MOBILE_MONEY_MOCK_SECRET).
 */

export const PROVIDER_CHOICES = ["paystack", "mock", "none"] as const;
export type ProviderChoice = (typeof PROVIDER_CHOICES)[number];

export const PROVIDER_LABELS: Record<ProviderChoice, string> = {
  paystack: "Paystack",
  mock: "Test provider (no real money)",
  none: "Off",
};

export interface MobileMoneyRegistry {
  providers: ReadonlyMap<string, MobileMoneyProvider>;
  /** The provider schools use unless platform staff choose another; null: none. */
  defaultName: string | null;
  production: boolean;
}

function paystackFromEnv(env: NodeJS.ProcessEnv): MobileMoneyProvider {
  const secretKey = (env.PAYSTACK_SECRET_KEY || env.PAYSTACK_TEST_SECRET_KEY || "").trim();
  if (!/^sk_(test|live)_\w+$/.test(secretKey))
    throw new Error(
      "Paystack is configured, but PAYSTACK_SECRET_KEY is missing or not a Paystack secret key.",
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

export function mobileMoneyRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): MobileMoneyRegistry {
  const production = env.NODE_ENV === "production";
  const fallback = production ? "none" : env.PAYSTACK_TEST_SECRET_KEY?.trim() ? "paystack" : "mock";
  const defaultChoice = env.MOBILE_MONEY_PROVIDER?.trim() || fallback;
  if (!(PROVIDER_CHOICES as readonly string[]).includes(defaultChoice))
    throw new Error(`Unknown MOBILE_MONEY_PROVIDER "${defaultChoice}". Use "paystack", "mock" or "none".`);
  const providers = new Map<string, MobileMoneyProvider>();
  const hasPaystackKey = Boolean((env.PAYSTACK_SECRET_KEY || env.PAYSTACK_TEST_SECRET_KEY || "").trim());
  if (defaultChoice === "paystack" || hasPaystackKey) {
    const paystack = paystackFromEnv(env);
    providers.set(paystack.name, paystack);
  }
  if (!production || defaultChoice === "mock" || env.MOBILE_MONEY_MOCK_SECRET) {
    const mock = mockProvider({
      secret: env.MOBILE_MONEY_MOCK_SECRET || DEV_MOCK_SECRET,
      send: env.MOBILE_MONEY_MOCK_CALLBACKS !== "false",
      delayMs: Math.max(0, Number(env.MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS ?? 3000) || 0),
    });
    providers.set(mock.name, mock);
  }
  return { providers, defaultName: defaultChoice === "none" ? null : defaultChoice, production };
}

/** The deployment's default provider (null when Mobile Money is off by default). */
export function mobileMoneyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): MobileMoneyProvider | null {
  const registry = mobileMoneyRegistryFromEnv(env);
  return registry.defaultName ? (registry.providers.get(registry.defaultName) ?? null) : null;
}

let cached: MobileMoneyRegistry | undefined;

/** The registry, built once per process. */
export function mobileMoneyRegistry(): MobileMoneyRegistry {
  cached ??= mobileMoneyRegistryFromEnv();
  return cached;
}

/** A provider by the name stored on a request or a callback URL, if this deployment has it. */
export function providerNamed(name: string): MobileMoneyProvider | null {
  return mobileMoneyRegistry().providers.get(name) ?? null;
}

/**
 * The provider a school uses: demo schools always use the mock (their families and numbers are made up),
 * never a real provider; otherwise the school's choice, else the default. The mock is never used for a real
 * school in production.
 */
export function providerForSchool(
  school: { choice: string | null; isDemo: boolean },
  registry: MobileMoneyRegistry = mobileMoneyRegistry(),
): MobileMoneyProvider | null {
  if (school.isDemo) return registry.providers.get("mock") ?? null;
  const name = school.choice ?? registry.defaultName;
  if (!name || name === "none") return null;
  if (name === "mock" && registry.production && registry.defaultName !== "mock") return null;
  return registry.providers.get(name) ?? null;
}

/**
 * What platform staff can choose for a school: the deployment's default, each provider this deployment has
 * (the test provider only where it may be used for real schools), and Off. A current choice that is no
 * longer available stays listed, marked, so saving the form never changes it silently.
 */
export function providerChoicesForAdmin(
  current: string | null,
  registry: MobileMoneyRegistry = mobileMoneyRegistry(),
): { value: string; label: string }[] {
  const usable = (name: string) =>
    registry.providers.has(name) &&
    !(name === "mock" && registry.production && registry.defaultName !== "mock");
  const defaultLabel = registry.defaultName
    ? PROVIDER_LABELS[registry.defaultName as ProviderChoice]
    : PROVIDER_LABELS.none;
  const options = [{ value: "", label: `Deployment default (${defaultLabel})` }];
  for (const name of ["paystack", "mock"] as const)
    if (usable(name) || current === name)
      options.push({
        value: name,
        label: usable(name)
          ? PROVIDER_LABELS[name]
          : `${PROVIDER_LABELS[name]} (not available on this deployment)`,
      });
  options.push({ value: "none", label: PROVIDER_LABELS.none });
  return options;
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
