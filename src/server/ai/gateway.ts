import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { estimateCostMicros, type AiLimits, type AiTask } from "../../lib/ai-providers";
import { addDays } from "../../lib/attendance";
import { formatCalendarDate, todayIn } from "../../lib/format";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { aiPlatformMonths, aiSchoolLimits, aiUsage } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { buildProvider, isConfigured, readAiConfig, type AiConfig } from "./config";
import { ProviderError, type AiProvider, type AiRequest, type AiResponse } from "./types";

/**
 * The AI gateway (R5-4, ADR 0004 §3 revision): every AI call goes through `openAiSession`. It checks the feature
 * flags, then the limits (platform, school and person), calls the configured provider with a timeout and an output
 * cap, records every call and every blocked attempt in `ai_usage`, and turns any failure into a plain message.
 * Features never see a provider's own format, so switching provider changes no feature code.
 */

/** A provider call that takes longer than this is abandoned. */
const TIMEOUT_MS = 45_000;

export type AiErrorCode =
  | "ai_off"
  | "ai_task_off"
  | "ai_not_configured"
  | "ai_limit_platform"
  | "ai_limit_school"
  | "ai_limit_minute"
  | "ai_limit_hour"
  | "ai_limit_day"
  | "ai_provider_quota"
  | "ai_unavailable"
  | "ai_demo";

/** AI cannot be used for this request, with a message to show (AIG-03); the rest of the system is unaffected. */
export class AiUnavailableError extends DomainError<AiErrorCode> {}

/** Visitors trying the demo school never reach the AI provider: every call costs money. */
const demoBlocked = (ctx: TenantContext) =>
  ctx.demoVisitor
    ? new AiUnavailableError("ai_demo", "AI features are switched off for visitors to the demo school.")
    : null;

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const nextMonth = (iso: string) => {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

/** The school's own limits, where platform staff set them, over the platform defaults. */
async function effectiveLimits(database: Database, ctx: TenantContext, limits: AiLimits): Promise<AiLimits> {
  const [own] = await withTenant(database, scope(ctx), (tx) =>
    tx.select().from(aiSchoolLimits).where(eq(aiSchoolLimits.tenantId, ctx.tenant.id)),
  );
  return {
    ...limits,
    schoolMonthlyTokens: own?.monthlyTokens ?? limits.schoolMonthlyTokens,
    userPerHour: own?.userPerHour ?? limits.userPerHour,
    userDailyTokens: own?.userDailyTokens ?? limits.userDailyTokens,
  };
}

interface Counts {
  platformTokens: number;
  schoolTokens: number;
  userTokensToday: number;
  userRequestsMinute: number;
  userRequestsHour: number;
}

async function counts(database: Database, ctx: TenantContext): Promise<Counts> {
  const today = todayIn(ctx.tenant.timezone);
  const utcToday = new Date().toISOString().slice(0, 10);
  return withTenant(database, scope(ctx), async (tx) => {
    const [platform] = await tx
      .select({ tokens: aiPlatformMonths.tokens })
      .from(aiPlatformMonths)
      .where(eq(aiPlatformMonths.month, monthStart(utcToday)));
    const tz = ctx.tenant.timezone;
    const [row] = (
      await tx.execute<{ school: string; user_today: string; minute: number; hour: number }>(sql`
        select
          coalesce(sum(input_tokens + output_tokens) filter (
            where (created_at at time zone ${tz})::date >= ${monthStart(today)}::date), 0)::text as school,
          coalesce(sum(input_tokens + output_tokens) filter (
            where user_id = ${ctx.userId} and (created_at at time zone ${tz})::date = ${today}::date), 0)::text as user_today,
          count(distinct request_id) filter (
            where user_id = ${ctx.userId} and outcome <> 'blocked' and created_at > now() - interval '1 minute')::int as minute,
          count(distinct request_id) filter (
            where user_id = ${ctx.userId} and outcome <> 'blocked' and created_at > now() - interval '1 hour')::int as hour
        from ai_usage
        where tenant_id = ${ctx.tenant.id} and created_at >= ${addDays(monthStart(today), -1)}::date`)
    ).rows;
    return {
      platformTokens: platform?.tokens ?? 0,
      schoolTokens: Number(row?.school ?? 0),
      userTokensToday: Number(row?.user_today ?? 0),
      userRequestsMinute: row?.minute ?? 0,
      userRequestsHour: row?.hour ?? 0,
    };
  });
}

/** The first limit the counts reach, as the error to show; null when within every limit. */
export function limitReached(
  c: Counts,
  limits: AiLimits,
  today: string,
  newRequest: boolean,
): AiUnavailableError | null {
  const resets = formatCalendarDate(nextMonth(today));
  if (c.platformTokens >= limits.platformMonthlyTokens)
    return new AiUnavailableError(
      "ai_limit_platform",
      `EduBridge's AI allowance for this month is used up. It starts again on ${resets}.`,
    );
  if (c.schoolTokens >= limits.schoolMonthlyTokens)
    return new AiUnavailableError(
      "ai_limit_school",
      `This school's AI allowance for this month is used up. It starts again on ${resets}.`,
    );
  if (c.userTokensToday >= limits.userDailyTokens)
    return new AiUnavailableError(
      "ai_limit_day",
      "You have reached today's AI limit. It starts again tomorrow.",
    );
  if (newRequest && c.userRequestsMinute >= limits.userPerMinute)
    return new AiUnavailableError("ai_limit_minute", "You are asking quickly. Wait a minute and try again.");
  if (newRequest && c.userRequestsHour >= limits.userPerHour)
    return new AiUnavailableError(
      "ai_limit_hour",
      "You have reached the hourly limit for AI requests. Try again within the hour.",
    );
  return null;
}

async function record(
  database: Database,
  ctx: TenantContext,
  row: {
    requestId: string;
    task: AiTask;
    provider: string;
    model: string;
    outcome: (typeof aiUsage.$inferInsert)["outcome"];
    detail?: string | null;
    usage?: AiResponse["usage"];
    costMicros?: number | null;
    latencyMs?: number;
  },
) {
  const tokens = (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0);
  await withTenant(database, scope(ctx), async (tx) => {
    await tx.insert(aiUsage).values({
      tenantId: ctx.tenant.id,
      userId: ctx.userId || null,
      requestId: row.requestId,
      task: row.task,
      provider: row.provider,
      model: row.model,
      inputTokens: row.usage?.inputTokens ?? 0,
      outputTokens: row.usage?.outputTokens ?? 0,
      cachedInputTokens: row.usage?.cachedInputTokens ?? 0,
      costMicros: row.costMicros ?? (row.usage ? 0 : null),
      outcome: row.outcome,
      detail: row.detail ?? null,
      latencyMs: row.latencyMs ?? null,
    });
    if (tokens > 0)
      await tx
        .insert(aiPlatformMonths)
        .values({ month: monthStart(new Date().toISOString().slice(0, 10)), tokens })
        .onConflictDoUpdate({
          target: aiPlatformMonths.month,
          set: { tokens: sql`${aiPlatformMonths.tokens} + ${tokens}` },
        });
  });
}

/** Whether the platform side lets a task run: the global switch, the task's flag and a configured provider. */
function platformCheck(config: AiConfig, task: AiTask, injected: boolean): AiUnavailableError | null {
  if (!config.enabled) return new AiUnavailableError("ai_off", "AI is not switched on for EduBridge yet.");
  if (!config.tasks[task])
    return new AiUnavailableError("ai_task_off", "This AI feature is switched off for now.");
  if (!injected && !isConfigured(config))
    return new AiUnavailableError("ai_not_configured", "AI is not switched on for EduBridge yet.");
  return null;
}

export interface AiSession {
  provider: string;
  model: string;
  /**
   * Identifiable data may be sent: only a paid provider approved after the data-protection review (AIG-05). With a
   * free or local provider this is always false, whatever the school's own setting.
   */
  identifiableApproved: boolean;
  /** One call, within the limits; throws AiUnavailableError with a message to show. */
  respond(request: Omit<AiRequest, "maxOutputTokens">): Promise<AiResponse>;
}

/**
 * Opens a request for one AI task (e.g. one question). Throws AiUnavailableError when AI is off, not configured or
 * over a limit; each call through the session is checked again and recorded. `provider` replaces the configured
 * one (tests use a scripted provider; nothing else should).
 */
export async function openAiSession(
  database: Database,
  ctx: TenantContext,
  task: AiTask,
  options: { provider?: AiProvider; config?: AiConfig } = {},
): Promise<AiSession> {
  const demo = demoBlocked(ctx);
  if (demo) throw demo;
  const config = options.config ?? (await readAiConfig(database));
  const blocked = platformCheck(config, task, Boolean(options.provider));
  if (blocked) throw blocked;
  const provider = options.provider ?? buildProvider(config)!;
  const limits = await effectiveLimits(database, ctx, config.limits);
  const requestId = randomUUID();
  const today = todayIn(ctx.tenant.timezone);
  const base = { requestId, task, provider: provider.id, model: provider.model };

  const check = async (newRequest: boolean) => {
    const reached = limitReached(await counts(database, ctx), limits, today, newRequest);
    if (reached) {
      await record(database, ctx, { ...base, outcome: "blocked", detail: reached.code });
      throw reached;
    }
  };
  await check(true);

  return {
    provider: provider.id,
    model: provider.model,
    identifiableApproved: config.identifiableApproved,
    async respond(request) {
      await check(false);
      const started = Date.now();
      try {
        const response = await provider.respond(
          { ...request, maxOutputTokens: limits.maxOutputTokens },
          AbortSignal.timeout(TIMEOUT_MS),
        );
        await record(database, ctx, {
          ...base,
          outcome: response.stop === "refusal" ? "refused" : response.stop === "length" ? "length" : "ok",
          usage: response.usage,
          costMicros: estimateCostMicros(config.provider, provider.model, response.usage),
          latencyMs: Date.now() - started,
        });
        return response;
      } catch (error) {
        const kind = error instanceof ProviderError ? error.kind : "unavailable";
        await record(database, ctx, {
          ...base,
          outcome: kind === "quota" ? "provider_quota" : kind === "unavailable" ? "unavailable" : "failed",
          detail: error instanceof Error ? error.message.slice(0, 300) : null,
          latencyMs: Date.now() - started,
        });
        if (kind === "auth" || kind === "bad_request")
          console.error("AI provider error", provider.id, error instanceof Error ? error.message : error);
        if (kind === "quota") {
          const wait = error instanceof ProviderError ? error.retryAfterSeconds : null;
          throw new AiUnavailableError(
            "ai_provider_quota",
            wait && wait < 3600
              ? `The AI service's free allowance is used up for now. Try again in ${Math.max(1, Math.ceil(wait / 60))} minutes.`
              : "The AI service's free allowance is used up for now. Try again later.",
          );
        }
        throw new AiUnavailableError("ai_unavailable", "The AI service is not available right now.");
      }
    },
  };
}

/** Whether a task can run for this person now, without calling the provider (for pages to explain themselves). */
export async function aiAvailability(
  database: Database,
  ctx: TenantContext,
  task: AiTask,
): Promise<{ available: boolean; message: string | null; identifiableApproved: boolean }> {
  const demo = demoBlocked(ctx);
  if (demo) return { available: false, message: demo.message, identifiableApproved: false };
  const config = await readAiConfig(database);
  const blocked = platformCheck(config, task, false);
  if (blocked) return { available: false, message: blocked.message, identifiableApproved: false };
  const limits = await effectiveLimits(database, ctx, config.limits);
  const reached = limitReached(await counts(database, ctx), limits, todayIn(ctx.tenant.timezone), true);
  return {
    available: !reached,
    message: reached?.message ?? null,
    identifiableApproved: config.identifiableApproved,
  };
}

export interface SchoolAiUsage {
  /** This month, in the school's time zone. */
  tokens: number;
  requests: number;
  blocked: number;
  allowance: number;
  /** Estimated cost in millionths of a US dollar (zero with free and local providers); null if not known. */
  costMicros: number | null;
}

/** This month's AI use for the school (AIG-04), for the Proprietor's settings page. */
export async function getSchoolAiUsage(database: Database, ctx: TenantContext): Promise<SchoolAiUsage> {
  const config = await readAiConfig(database);
  const limits = await effectiveLimits(database, ctx, config.limits);
  const from = monthStart(todayIn(ctx.tenant.timezone));
  const [row] = await withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        tokens: sql<string>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::text`,
        requests: sql<number>`count(distinct ${aiUsage.requestId}) filter (where ${aiUsage.outcome} <> 'blocked')::int`,
        blocked: sql<number>`count(*) filter (where ${aiUsage.outcome} = 'blocked')::int`,
        cost: sql<string | null>`sum(${aiUsage.costMicros})::text`,
        unknownCost: sql<number>`count(*) filter (where ${aiUsage.costMicros} is null and ${aiUsage.outcome} <> 'blocked')::int`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.tenantId, ctx.tenant.id),
          gte(sql`(${aiUsage.createdAt} at time zone ${ctx.tenant.timezone})::date`, sql`${from}::date`),
        ),
      ),
  );
  return {
    tokens: Number(row?.tokens ?? 0),
    requests: row?.requests ?? 0,
    blocked: row?.blocked ?? 0,
    allowance: limits.schoolMonthlyTokens,
    costMicros: row?.unknownCost ? null : Number(row?.cost ?? 0),
  };
}
