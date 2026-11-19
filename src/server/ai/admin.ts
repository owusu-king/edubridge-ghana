import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AI_LIMIT_RANGES,
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  AI_TASKS,
  canApproveIdentifiable,
  type AiLimits,
  type AiProviderId,
} from "../../lib/ai-providers";
import { seal } from "../auth/secret-box";
import type { Database, Transaction } from "../db/client";
import { withTenant, withUser } from "../db/context";
import {
  aiFeatureFlags,
  aiPlatformMonths,
  aiSchoolLimits,
  aiUsage,
  platformEvents,
  platformSecrets,
  platformSettings,
  tenants,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { assertPlatformAdmin } from "../platform/service";
import { aiKeyName, isConfigured, readAiConfig, readProviderKey, type AiConfig } from "./config";

/**
 * Platform staff's AI settings (Admin, Integrations; R5-4, AIG-01 to AIG-04): the global switch and task flags,
 * the provider, its model, address and key, whether a paid provider is approved for identifiable data, the limits,
 * and each school's own allowance. Every change is recorded in `platform_events`; row-level security also limits
 * these writes to platform administrators.
 */

async function event(
  tx: Transaction,
  actorUserId: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.insert(platformEvents).values({ actorUserId, action, metadata });
}

const invalid = (error: z.ZodError) => {
  const issue = error.issues[0]!;
  return new DomainError("ai_settings_invalid", issue.message, String(issue.path[0] ?? ""));
};

export interface AiKeyStatus {
  source: "platform" | "environment" | null;
  hint: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface AiAdminView {
  config: Omit<AiConfig, "apiKey"> & { configured: boolean };
  key: AiKeyStatus;
  usage: {
    month: string;
    platformTokens: number;
    bySchool: { tenantId: string; name: string; tokens: number; requests: number; blocked: number }[];
  };
}

export async function getAiAdmin(database: Database, actorUserId: string): Promise<AiAdminView> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const config = await readAiConfig(tx);
    const [secret] =
      config.provider === "none"
        ? []
        : await tx
            .select({ hint: platformSecrets.hint, updatedAt: platformSecrets.updatedAt, by: users.name })
            .from(platformSecrets)
            .leftJoin(users, eq(users.id, platformSecrets.updatedByUserId))
            .where(eq(platformSecrets.name, aiKeyName(config.provider)));
    const month = `${new Date().toISOString().slice(0, 7)}-01`;
    const [platform] = await tx
      .select({ tokens: aiPlatformMonths.tokens })
      .from(aiPlatformMonths)
      .where(eq(aiPlatformMonths.month, month));
    const bySchool = await tx
      .select({
        tenantId: aiUsage.tenantId,
        name: tenants.name,
        tokens: sql<string>`sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens})::text`,
        requests: sql<number>`count(distinct ${aiUsage.requestId}) filter (where ${aiUsage.outcome} <> 'blocked')::int`,
        blocked: sql<number>`count(*) filter (where ${aiUsage.outcome} = 'blocked')::int`,
      })
      .from(aiUsage)
      .innerJoin(tenants, eq(tenants.id, aiUsage.tenantId))
      .where(sql`${aiUsage.createdAt} >= ${month}::date`)
      .groupBy(aiUsage.tenantId, tenants.name)
      .orderBy(desc(sql`sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens})`))
      .limit(20);
    const { apiKey, ...rest } = config;
    const hasEnv = config.provider !== "none" && !secret && Boolean(apiKey);
    return {
      config: { ...rest, configured: isConfigured(config) },
      key: secret
        ? { source: "platform", hint: secret.hint, updatedAt: secret.updatedAt, updatedBy: secret.by }
        : { source: hasEnv ? "environment" : null, hint: null, updatedAt: null, updatedBy: null },
      usage: {
        month,
        platformTokens: platform?.tokens ?? 0,
        bySchool: bySchool.map((s) => ({ ...s, tokens: Number(s.tokens) })),
      },
    };
  });
}

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(AI_PROVIDER_IDS, { message: "Choose a provider." }),
    model: z
      .string()
      .trim()
      .max(100, "That model name is too long.")
      .regex(/^[\w.:/-]*$/, "A model name has letters, numbers and . : / - _ only."),
    baseUrl: z
      .string()
      .trim()
      .max(300)
      .refine(
        (v) => v === "" || /^https?:\/\/[^\s]+$/.test(v),
        "Enter the provider's address, starting with http.",
      ),
    identifiableApproved: z.boolean(),
    tasks: z.record(z.string(), z.boolean()),
  })
  .superRefine((v, issue) => {
    const info = AI_PROVIDERS[v.provider];
    if (v.provider !== "none" && !v.model)
      issue.addIssue({ code: "custom", path: ["model"], message: "Choose the model to use." });
    if (info.baseUrlEditable && !v.baseUrl && !info.baseUrl)
      issue.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter the provider's address." });
    if (v.identifiableApproved && !canApproveIdentifiable(v.provider))
      issue.addIssue({
        code: "custom",
        path: ["identifiableApproved"],
        message: "Free and local providers are de-identified only; only a paid provider can be approved.",
      });
  });

/** The global switch, task flags, provider, model and address; switching on needs a configured provider. */
export async function updateAiSettings(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const data = parsed.data;
  await withUser(database, actorUserId, async (tx) => {
    const before = await readAiConfig(tx);
    const info = AI_PROVIDERS[data.provider];
    // Stored only where it can be changed (Ollama, other providers); otherwise the provider's own address.
    const storedUrl = info.baseUrlEditable ? data.baseUrl || info.baseUrl : null;
    const baseUrl = storedUrl ?? info.baseUrl;
    // Approval belongs to the provider it was given for: changing provider withdraws it.
    const approved = data.provider === before.provider ? data.identifiableApproved : false;
    if (data.enabled) {
      const next = {
        ...before,
        provider: data.provider,
        model: data.model,
        baseUrl,
        apiKey: await readProviderKey(tx, data.provider),
      };
      if (!isConfigured(next))
        throw new DomainError(
          "ai_not_configured",
          info.needsKey && !next.apiKey
            ? "Save the provider's API key before switching AI on."
            : "Choose a provider and model before switching AI on.",
          "enabled",
        );
    }
    await tx.update(platformSettings).set({
      aiEnabled: data.enabled,
      aiProvider: data.provider,
      assistantModel: data.model || before.model,
      aiBaseUrl: storedUrl,
      aiIdentifiableApproved: approved,
      updatedAt: new Date(),
      updatedByUserId: actorUserId,
    });
    for (const task of AI_TASKS) {
      const enabled = data.tasks[task] ?? false;
      await tx
        .insert(aiFeatureFlags)
        .values({ task, enabled, updatedByUserId: actorUserId })
        .onConflictDoUpdate({
          target: aiFeatureFlags.task,
          set: { enabled, updatedAt: new Date(), updatedByUserId: actorUserId },
        });
    }
    await event(tx, actorUserId, "ai.settings_updated", {
      enabled: data.enabled,
      provider: data.provider,
      model: data.model,
      identifiableApproved: data.identifiableApproved,
      tasks: data.tasks,
    });
  });
}

const limitsSchema = z.object(
  Object.fromEntries(
    (Object.keys(AI_LIMIT_RANGES) as (keyof AiLimits)[]).map((k) => [
      k,
      z.coerce
        .number({ message: "Enter a whole number." })
        .int("Enter a whole number.")
        .min(AI_LIMIT_RANGES[k].min, `At least ${AI_LIMIT_RANGES[k].min.toLocaleString("en-GH")}.`)
        .max(AI_LIMIT_RANGES[k].max, `At most ${AI_LIMIT_RANGES[k].max.toLocaleString("en-GH")}.`),
    ]),
  ) as Record<keyof AiLimits, z.ZodNumber>,
);

/** The platform's limits (AIG-03). */
export async function updateAiLimits(database: Database, actorUserId: string, input: unknown): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const parsed = limitsSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const l = parsed.data;
  await withUser(database, actorUserId, async (tx) => {
    await tx.update(platformSettings).set({
      aiPlatformMonthlyTokens: l.platformMonthlyTokens,
      aiSchoolMonthlyTokens: l.schoolMonthlyTokens,
      aiUserPerMinute: l.userPerMinute,
      aiUserPerHour: l.userPerHour,
      aiUserDailyTokens: l.userDailyTokens,
      aiMaxOutputTokens: l.maxOutputTokens,
      updatedAt: new Date(),
      updatedByUserId: actorUserId,
    });
    await event(tx, actorUserId, "ai.limits_updated", l);
  });
}

const keySchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  apiKey: z
    .string()
    .trim()
    .min(20, "Paste the whole API key.")
    .max(400, "That is too long for an API key.")
    .regex(/^\S+$/, "An API key has no spaces."),
});

/** Saves (or replaces) a provider's API key, sealed; only its last four characters stay readable. */
export async function setAiApiKey(database: Database, actorUserId: string, input: unknown): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const parsed = keySchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const { provider, apiKey } = parsed.data;
  if (!AI_PROVIDERS[provider].needsKey)
    throw new DomainError("ai_settings_invalid", "This provider does not use an API key.", "apiKey");
  const values = {
    sealed: seal(apiKey),
    hint: apiKey.slice(-4),
    updatedAt: new Date(),
    updatedByUserId: actorUserId,
  };
  await withUser(database, actorUserId, async (tx) => {
    await tx
      .insert(platformSecrets)
      .values({ name: aiKeyName(provider), ...values })
      .onConflictDoUpdate({ target: platformSecrets.name, set: values });
    await event(tx, actorUserId, "ai.key_saved", { provider, hint: values.hint });
  });
}

/** Removes a provider's stored key; if it is the chosen provider, AI is switched off with it. */
export async function removeAiApiKey(
  database: Database,
  actorUserId: string,
  provider: AiProviderId,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  await withUser(database, actorUserId, async (tx) => {
    await tx.delete(platformSecrets).where(eq(platformSecrets.name, aiKeyName(provider)));
    const config = await readAiConfig(tx);
    if (config.provider === provider && !isConfigured(config))
      await tx
        .update(platformSettings)
        .set({ aiEnabled: false, updatedAt: new Date(), updatedByUserId: actorUserId });
    await event(tx, actorUserId, "ai.key_removed", { provider });
  });
}

export interface SchoolAiLimits {
  monthlyTokens: number | null;
  userPerHour: number | null;
  userDailyTokens: number | null;
}

export async function getSchoolAiLimits(
  database: Database,
  actorUserId: string,
  tenantId: string,
): Promise<SchoolAiLimits> {
  await assertPlatformAdmin(database, actorUserId);
  const [row] = await withTenant(database, { tenantId, userId: actorUserId }, (tx) =>
    tx.select().from(aiSchoolLimits).where(eq(aiSchoolLimits.tenantId, tenantId)),
  );
  return {
    monthlyTokens: row?.monthlyTokens ?? null,
    userPerHour: row?.userPerHour ?? null,
    userDailyTokens: row?.userDailyTokens ?? null,
  };
}

const optional = (k: keyof AiLimits) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : v),
    z.coerce
      .number({ message: "Enter a whole number, or leave it empty for the platform default." })
      .int("Enter a whole number.")
      .min(AI_LIMIT_RANGES[k].min, `At least ${AI_LIMIT_RANGES[k].min.toLocaleString("en-GH")}.`)
      .max(AI_LIMIT_RANGES[k].max, `At most ${AI_LIMIT_RANGES[k].max.toLocaleString("en-GH")}.`)
      .nullable(),
  );
const schoolLimitsSchema = z.object({
  monthlyTokens: optional("schoolMonthlyTokens"),
  userPerHour: optional("userPerHour"),
  userDailyTokens: optional("userDailyTokens"),
});

/** A school's own AI allowance (e.g. matching its plan); empty fields keep the platform default. */
export async function setSchoolAiLimits(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const parsed = schoolLimitsSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const values = { ...parsed.data, updatedAt: new Date(), updatedByUserId: actorUserId };
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    await tx
      .insert(aiSchoolLimits)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: aiSchoolLimits.tenantId, set: values });
    await event(tx, actorUserId, "ai.school_limits_updated", { tenantId, ...parsed.data });
  });
}
