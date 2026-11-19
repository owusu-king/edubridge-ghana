import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { AiConfig } from "@/server/ai/config";
import type { AiBlock, AiMessage, AiProvider } from "@/server/ai/types";
import { askAssistant, listAssistantQueries } from "@/server/assistant/service";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { assistantQueries } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { updateEntitlements } from "@/server/platform/service";
import { grantSupportAccess } from "@/server/support/access";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { DEFAULT_AI_LIMITS } from "@/lib/ai-providers";
import { FEATURES } from "@/lib/plan";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { saveAssistantPreferences } from "@/server/tenancy/preferences";
import { conn, school as baseSchool, type School } from "../support/mobile-money";

afterAll(() => conn.close());

/**
 * The gateway's settings for these tests (passed in, not the platform's, which other test files change): AI on,
 * a free provider, so de-identified only, unless `approved` (a paid provider approved for identifiable data).
 */
const settings = (approved = false): AiConfig => ({
  enabled: true,
  provider: approved ? "anthropic" : "groq",
  model: "scripted",
  baseUrl: null,
  apiKey: null,
  identifiableApproved: approved,
  tasks: { assistant: true, remarks: true, announcements: true, board_report: true },
  limits: { ...DEFAULT_AI_LIMITS, userPerMinute: 60, userPerHour: 1000 },
});

/**
 * A stand-in provider: asks for the given tools on its first turn, then answers with a summary of what the
 * tools returned (so the test sees exactly what the model was given). No network, no cost.
 */
function scriptedModel(calls: { name: string; input: Record<string, unknown> }[], approved = false) {
  const seen: { system: string; messages: AiMessage[] }[] = [];
  const provider: AiProvider = {
    id: "scripted",
    model: "scripted",
    async respond({ system, messages }) {
      seen.push(structuredClone({ system, messages }));
      const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };
      if (messages.length === 1)
        return {
          stop: "tool_calls",
          content: calls.map((c, i) => ({
            type: "tool_call",
            id: `call_${i}`,
            name: c.name,
            input: c.input,
          })),
          usage,
        };
      const results = messages.at(-1)!.content as Extract<AiBlock, { type: "tool_result" }>[];
      return {
        stop: "end",
        content: [
          {
            type: "text",
            text: results.map((r) => (r.isError ? `DENIED ${r.content}` : r.content)).join("\n"),
          },
        ],
        usage,
      };
    },
  };
  return { model: { provider, config: settings(approved) }, seen };
}

const only = (provider: AiProvider) => ({ provider, config: settings() });

/** A school whose Proprietor has turned the assistant on (sharing names unless told otherwise). */
async function school(shareNames = true) {
  const s = await baseSchool();
  await saveAssistantPreferences(conn.app, s.owner, {
    assistantEnabled: true,
    assistantShareNames: shareNames,
  });
  return s;
}

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

describe("the school assistant", () => {
  it("answers from the records the person may see, and records every question", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);
    const { model } = scriptedModel([{ name: "outstanding_fees", input: { min_cedis: "500" } }]);
    const result = await askAssistant(
      conn.app,
      s.bursar,
      { question: "Who owes more than 500 cedis?" },
      model,
    );
    expect(result.status).toBe("answered");
    expect(result.answer).toContain("Ama Mensah");
    expect(result.answer).toContain("GH₵1,000.00");
    expect(result.sources).toEqual([{ label: "Fees, Owing", path: "fees/owing" }]);

    const [row] = await asSchool(s, (tx) =>
      tx.select().from(assistantQueries).where(eq(assistantQueries.id, result.id)),
    );
    expect(row).toMatchObject({
      userId: s.bursar.userId,
      question: "Who owes more than 500 cedis?",
      status: "answered",
      tools: [{ name: "outstanding_fees", input: { min_cedis: "500" }, allowed: true }],
      inputTokens: 20,
      outputTokens: 10,
      supportGrantId: null,
    });
    // Records never change.
    await expect(
      asSchool(s, (tx) =>
        tx.update(assistantQueries).set({ answer: "edited" }).where(eq(assistantQueries.id, result.id)),
      ),
    ).rejects.toThrow();
    expect(ama.id).toBeTruthy();
  });

  it("cannot read what the person's role cannot, and tells the model so", async () => {
    const s = await school();
    // The accountant asks about results: the results tool is refused for their role.
    const { model, seen } = scriptedModel([
      { name: "student_trends", input: {} },
      { name: "money", input: {} },
    ]);
    const result = await askAssistant(conn.app, s.bursar, { question: "Who is declining?" }, model);
    expect(result.answer).toContain("DENIED");
    expect(result.sources).toEqual([{ label: "Insights, Money", path: "insights" }]);
    const toolResults = seen[1]!.messages.at(-1)!.content as Extract<AiBlock, { type: "tool_result" }>[];
    expect(toolResults.map((r) => r.isError ?? false)).toEqual([true, false]);
    const [row] = await asSchool(s, (tx) =>
      tx.select().from(assistantQueries).where(eq(assistantQueries.id, result.id)),
    );
    expect(row!.tools.map((t) => t.allowed)).toEqual([false, true]);
  });

  it("is for leaders and the accountant, needs the plan's module, and is off unless switched on", async () => {
    const s = await school();
    const { model } = scriptedModel([]);
    await expect(askAssistant(conn.app, s.teacher, { question: "How are we doing?" }, model)).rejects.toThrow(
      ForbiddenError,
    );
    const admin = await createUser(conn.owner, "Staff");
    await makePlatformAdmin(conn.owner, admin.id);
    await updateEntitlements(conn.app, admin.id, s.tenant.id, {
      planName: "Starter",
      maxCampuses: 2,
      maxStudents: null,
      maxSmsPerMonth: null,
      features: FEATURES.filter((f) => f !== "assistant"),
    });
    const owner = (await resolveTenantContext(conn.app, s.tenant.slug, s.owner.userId)) as TenantContext;
    await expect(
      askAssistant(conn.app, owner, { question: "How are we doing?" }, model),
    ).rejects.toMatchObject({
      code: "feature_not_included",
    });
  });

  it("needs the Proprietor's consent, and hides names from the provider unless allowed", async () => {
    const off = await baseSchool();
    await expect(
      askAssistant(conn.app, off.owner, { question: "How are we doing?" }, scriptedModel([]).model),
    ).rejects.toMatchObject({
      code: "assistant_off_for_school",
    });

    const s = await school(false);
    await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);
    const { model, seen } = scriptedModel([{ name: "outstanding_fees", input: {} }]);
    const result = await askAssistant(conn.app, s.bursar, { question: "Who owes the most?" }, model);
    const sent = JSON.stringify(seen[1]);
    expect(sent).not.toContain("Ama Mensah");
    expect(sent).toContain("[P1]");
    // The answer the person sees has the name back.
    expect(result.answer).toContain("Ama Mensah");
    expect(result.answer).not.toContain("[P1]");
  });

  it("never names people or the school to a provider not approved for identifiable data (AIG-05)", async () => {
    // The Proprietor agreed to share names, but the provider is a free tier: names and the school stay here.
    const s = await school(true);
    await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);
    const free = scriptedModel([{ name: "outstanding_fees", input: {} }]);
    const answer = await askAssistant(conn.app, s.bursar, { question: "Who owes the most?" }, free.model);
    expect(JSON.stringify(free.seen)).not.toContain("Ama Mensah");
    expect(JSON.stringify(free.seen)).not.toContain(s.tenant.name);
    expect(answer.answer).toContain("Ama Mensah");
    // A paid provider approved after the data-protection review: the school's consent applies.
    const paid = scriptedModel([{ name: "outstanding_fees", input: {} }], true);
    await askAssistant(conn.app, s.bursar, { question: "Who owes the most?" }, paid.model);
    expect(JSON.stringify(paid.seen[1])).toContain("Ama Mensah");
    expect(paid.seen[0]!.system).toContain(s.tenant.name);
  });

  it("shows leaders everyone's questions, marking EduBridge support's", async () => {
    const s = await school();
    const { model } = scriptedModel([{ name: "term_trends", input: {} }]);
    await askAssistant(conn.app, s.bursar, { question: "How much did we collect?" }, model);
    const admin = await createUser(conn.owner, "Support");
    await makePlatformAdmin(conn.owner, admin.id);
    await grantSupportAccess(conn.app, s.owner, { hours: 1, note: "" });
    const support = (await resolveTenantContext(conn.app, s.tenant.slug, admin.id)) as TenantContext;
    await askAssistant(conn.app, support, { question: "What is the attendance?" }, scriptedModel([]).model);

    const mine = await listAssistantQueries(conn.app, s.bursar, { everyone: true });
    expect(mine.map((q) => q.question)).toEqual(["How much did we collect?"]);
    const all = await listAssistantQueries(conn.app, s.owner, { everyone: true });
    expect(all.map((q) => [q.question, q.bySupport])).toEqual([
      ["What is the attendance?", true],
      ["How much did we collect?", false],
    ]);
  });

  it("records a refusal or a model failure without failing the page", async () => {
    const s = await school();
    const refusing: AiProvider = {
      id: "refusing",
      model: "refusing",
      respond: async () => ({
        stop: "refusal",
        content: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      }),
    };
    expect(
      (await askAssistant(conn.app, s.owner, { question: "Something off-limits" }, only(refusing))).status,
    ).toBe("refused");
    const broken: AiProvider = {
      id: "broken",
      model: "broken",
      respond: async () => {
        throw new Error("network down");
      },
    };
    const failed = await askAssistant(conn.app, s.owner, { question: "How are we doing?" }, only(broken));
    expect(failed).toMatchObject({ status: "failed", sources: [] });
    expect(failed.answer).toBe("The AI service is not available right now. Insights shows the same figures.");
    await expect(askAssistant(conn.app, s.owner, { question: "x" }, only(broken))).rejects.toThrow();
  });
});
