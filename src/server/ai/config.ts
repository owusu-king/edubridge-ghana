import "server-only";
import { eq, inArray } from "drizzle-orm";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  AI_TASKS,
  canApproveIdentifiable,
  type AiLimits,
  type AiProviderId,
  type AiTask,
} from "../../lib/ai-providers";
import { open } from "../auth/secret-box";
import type { Queryable } from "../db/client";
import { aiFeatureFlags, platformSecrets, platformSettings } from "../db/schema";
import { anthropicProvider } from "./providers/anthropic";
import { openAiCompatibleProvider } from "./providers/openai-compatible";
import type { AiProvider } from "./types";

/**
 * The AI gateway's platform configuration (R5-4, AIG-01, AIG-02): the global switch, the task flags, the provider
 * and its model, address and key, and the limits. Keys are sealed (`platform_secrets`); a key in the server's
 * environment is used when none is stored (`ANTHROPIC_API_KEY` for Anthropic, `AI_API_KEY` for the others).
 */

/** Where a provider's key is stored (Anthropic keeps the name it had before the gateway). */
export const aiKeyName = (provider: AiProviderId) =>
  provider === "anthropic" ? "anthropic.api_key" : `${provider}.api_key`;

const envKey = (provider: AiProviderId) =>
  (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.AI_API_KEY) || null;

/** A provider's API key: the stored one, or the server's environment. */
export async function readProviderKey(database: Queryable, provider: AiProviderId): Promise<string | null> {
  if (provider === "none") return null;
  const [secret] = await database
    .select({ sealed: platformSecrets.sealed })
    .from(platformSecrets)
    .where(eq(platformSecrets.name, aiKeyName(provider)));
  return secret ? open(secret.sealed) : envKey(provider);
}

export interface AiConfig {
  enabled: boolean;
  provider: AiProviderId;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  /** Identifiable data may be sent: a paid provider that platform staff marked approved after the review. */
  identifiableApproved: boolean;
  tasks: Record<AiTask, boolean>;
  limits: AiLimits;
}

const isProvider = (v: string): v is AiProviderId => (AI_PROVIDER_IDS as readonly string[]).includes(v);

export async function readAiConfig(database: Queryable): Promise<AiConfig> {
  const [s] = await database.select().from(platformSettings);
  const provider: AiProviderId = s && isProvider(s.aiProvider) ? s.aiProvider : "none";
  const flags = await database
    .select()
    .from(aiFeatureFlags)
    .where(inArray(aiFeatureFlags.task, [...AI_TASKS]));
  const info = AI_PROVIDERS[provider];
  return {
    enabled: s?.aiEnabled ?? false,
    provider,
    model: s?.assistantModel ?? "",
    baseUrl: info.baseUrlEditable ? (s?.aiBaseUrl ?? info.baseUrl) : info.baseUrl,
    apiKey: await readProviderKey(database, provider),
    identifiableApproved: Boolean(s?.aiIdentifiableApproved) && canApproveIdentifiable(provider),
    tasks: Object.fromEntries(
      AI_TASKS.map((t) => [t, flags.find((f) => f.task === t)?.enabled ?? false]),
    ) as Record<AiTask, boolean>,
    limits: {
      platformMonthlyTokens: s?.aiPlatformMonthlyTokens ?? 0,
      schoolMonthlyTokens: s?.aiSchoolMonthlyTokens ?? 0,
      userPerMinute: s?.aiUserPerMinute ?? 1,
      userPerHour: s?.aiUserPerHour ?? 1,
      userDailyTokens: s?.aiUserDailyTokens ?? 1_000,
      maxOutputTokens: s?.aiMaxOutputTokens ?? 1_000,
    },
  };
}

/** Whether the provider is set up enough to be called (a provider, a model, an address and a key where needed). */
export function isConfigured(config: AiConfig): boolean {
  const info = AI_PROVIDERS[config.provider];
  if (!info.adapter || !config.model) return false;
  if (info.needsKey && !config.apiKey) return false;
  if (info.adapter === "openai_compatible" && !config.baseUrl) return false;
  return true;
}

/** The provider adapter for the configuration, or null when AI is not configured. */
export function buildProvider(config: AiConfig): AiProvider | null {
  if (!isConfigured(config)) return null;
  const info = AI_PROVIDERS[config.provider];
  if (info.adapter === "anthropic") return anthropicProvider({ model: config.model, apiKey: config.apiKey! });
  return openAiCompatibleProvider({
    id: config.provider,
    baseUrl: config.baseUrl!,
    model: config.model,
    apiKey: config.apiKey,
  });
}
