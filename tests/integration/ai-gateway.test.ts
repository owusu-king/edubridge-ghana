import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { setSchoolAiLimits } from "@/server/ai/admin";
import type { AiConfig } from "@/server/ai/config";
import { getSchoolAiUsage, openAiSession } from "@/server/ai/gateway";
import { ProviderError, type AiProvider } from "@/server/ai/types";
import { askAssistant } from "@/server/assistant/service";
import { withTenant } from "@/server/db/context";
import { aiUsage } from "@/server/db/schema";
import { saveAssistantPreferences } from "@/server/tenancy/preferences";
import { DEFAULT_AI_LIMITS, type AiLimits } from "@/lib/ai-providers";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

// The gateway's settings are passed in (the platform's are global, and other test files change them).
const config = (limits: Partial<AiLimits> = {}, over: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true,
  provider: "groq",
  model: "test-model",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: null,
  identifiableApproved: false,
  tasks: { assistant: true, remarks: true, announcements: true, board_report: true },
  limits: { ...DEFAULT_AI_LIMITS, ...limits },
  ...over,
});

/** Answers every call with the same text, using `tokens` tokens (input and output). */
const answering = (tokens = 10): AiProvider => ({
  id: "scripted",
  model: "test-model",
  respond: async () => ({
    stop: "end",
    content: [{ type: "text", text: "Fine." }],
    usage: { inputTokens: tokens - 2, outputTokens: 2, cachedInputTokens: 0 },
  }),
});
const failing = (error: Error): AiProvider => ({
  id: "scripted",
  model: "test-model",
  respond: async () => {
    throw error;
  },
});

const request = { system: "Rules", messages: [{ role: "user" as const, content: "Hello" }], tools: [] };

const usageRows = (s: School) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx.select().from(aiUsage).where(eq(aiUsage.tenantId, s.tenant.id)).orderBy(aiUsage.createdAt),
  );

describe("the AI gateway", () => {
  it("records every call: tokens, a zero cost on a free provider, the outcome, grouped by request", async () => {
    const s = await school();
    const session = await openAiSession(conn.app, s.bursar, "assistant", {
      provider: answering(10),
      config: config(),
    });
    await session.respond(request);
    await session.respond(request);
    const rows = await usageRows(s);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      userId: s.bursar.userId,
      task: "assistant",
      provider: "scripted",
      model: "test-model",
      inputTokens: 8,
      outputTokens: 2,
      costMicros: 0,
      outcome: "ok",
    });
    expect(rows[0]!.requestId).toBe(rows[1]!.requestId);
    expect(await getSchoolAiUsage(conn.app, s.owner)).toMatchObject({ tokens: 20, requests: 1, blocked: 0 });
    // Usage is insert-only.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.execute(sql`delete from ai_usage`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/insert-only/) } });
    // Another school sees none of it.
    const other = await school();
    expect(await usageRows(other)).toEqual([]);
  });

  it("follows the global switch and the feature's flag", async () => {
    const s = await school();
    await expect(
      openAiSession(conn.app, s.owner, "assistant", {
        provider: answering(),
        config: config({}, { enabled: false }),
      }),
    ).rejects.toMatchObject({ code: "ai_off", message: "AI is not switched on for EduBridge yet." });
    await expect(
      openAiSession(conn.app, s.owner, "assistant", {
        provider: answering(),
        config: config(
          {},
          { tasks: { assistant: false, remarks: false, announcements: false, board_report: false } },
        ),
      }),
    ).rejects.toMatchObject({ code: "ai_task_off" });
  });

  it("throttles each person's requests, and stops at the school's and the platform's allowance", async () => {
    const s = await school();
    const options = {
      provider: answering(15),
      config: config({ userPerMinute: 1, schoolMonthlyTokens: 25 }),
    };
    const first = await openAiSession(conn.app, s.bursar, "assistant", options);
    await first.respond(request);
    // A second question within the minute is throttled, and the attempt recorded.
    await expect(openAiSession(conn.app, s.bursar, "assistant", options)).rejects.toMatchObject({
      code: "ai_limit_minute",
      message: "You are asking quickly. Wait a minute and try again.",
    });
    // Calls within an open request are not throttled, but the school's allowance applies: 15, then 30 of 25.
    await first.respond(request);
    await expect(first.respond(request)).rejects.toMatchObject({ code: "ai_limit_school" });
    const rows = await usageRows(s);
    expect(rows.map((r) => [r.outcome, r.detail])).toEqual([
      ["ok", null],
      ["blocked", "ai_limit_minute"],
      ["ok", null],
      ["blocked", "ai_limit_school"],
    ]);
    expect(await getSchoolAiUsage(conn.app, s.owner)).toMatchObject({ tokens: 30, requests: 1, blocked: 2 });
    // Another person at the same school is stopped by the school's allowance too.
    await expect(openAiSession(conn.app, s.owner, "assistant", options)).rejects.toMatchObject({
      code: "ai_limit_school",
    });
    // The platform's limit: zero stops everyone.
    const t = await school();
    await expect(
      openAiSession(conn.app, t.owner, "assistant", {
        provider: answering(),
        config: config({ platformMonthlyTokens: 0 }),
      }),
    ).rejects.toMatchObject({ code: "ai_limit_platform" });
  });

  it("gives a school its own allowance, set by platform staff", async () => {
    const s = await school();
    const staff = await createUser(conn.owner, "AI Staff");
    await makePlatformAdmin(conn.owner, staff.id);
    await expect(
      setSchoolAiLimits(conn.app, s.owner.userId, s.tenant.id, { monthlyTokens: 5 }),
    ).rejects.toThrow();
    await setSchoolAiLimits(conn.app, staff.id, s.tenant.id, {
      monthlyTokens: 12,
      userPerHour: "",
      userDailyTokens: "",
    });
    expect((await getSchoolAiUsage(conn.app, s.owner)).allowance).toBe(12);
    const options = { provider: answering(15), config: config({ schoolMonthlyTokens: 1_000_000 }) };
    const session = await openAiSession(conn.app, s.owner, "assistant", options);
    await session.respond(request);
    await expect(session.respond(request)).rejects.toMatchObject({ code: "ai_limit_school" });
  });

  it("explains the provider's quota and outages, and the assistant keeps the page working", async () => {
    const s = await school();
    const quota = await openAiSession(conn.app, s.owner, "assistant", {
      provider: failing(new ProviderError("quota", "429", 120)),
      config: config(),
    });
    await expect(quota.respond(request)).rejects.toMatchObject({
      code: "ai_provider_quota",
      message: "The AI service's free allowance is used up for now. Try again in 2 minutes.",
    });
    const down = await openAiSession(conn.app, s.owner, "assistant", {
      provider: failing(new Error("ECONNREFUSED")),
      config: config(),
    });
    await expect(down.respond(request)).rejects.toMatchObject({ code: "ai_unavailable" });
    expect((await usageRows(s)).map((r) => r.outcome)).toEqual(["provider_quota", "unavailable"]);

    // The assistant turns a limit into an answer the person can act on.
    await saveAssistantPreferences(conn.app, s.owner, { assistantEnabled: true, assistantShareNames: false });
    await expect(
      askAssistant(
        conn.app,
        s.owner,
        { question: "How are we doing?" },
        { provider: answering(), config: config({ schoolMonthlyTokens: 0 }) },
      ),
    ).rejects.toMatchObject({
      code: "ai_limit_school",
      message: expect.stringMatching(
        /allowance for this month is used up\. .* Insights shows the same figures\.$/,
      ),
    });
    const quotaAnswer = await askAssistant(
      conn.app,
      s.owner,
      { question: "How are we doing?" },
      { provider: failing(new ProviderError("quota", "429", null)), config: config() },
    );
    expect(quotaAnswer).toMatchObject({
      status: "failed",
      answer:
        "The AI service's free allowance is used up for now. Try again later. Insights shows the same figures.",
    });
  });
});
