import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { AssistantModel, AssistantMessage, AssistantMessageParam } from "@/server/assistant/model";
import { askAssistant, listAssistantQueries } from "@/server/assistant/service";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { assistantQueries } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { updateEntitlements } from "@/server/platform/service";
import { grantSupportAccess } from "@/server/support/access";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { FEATURES } from "@/lib/plan";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

/**
 * A stand-in model: asks for the given tools on its first turn, then answers with a summary of what the
 * tools returned (so the test sees exactly what the model was given). No network, no cost.
 */
function scriptedModel(calls: { name: string; input: Record<string, unknown> }[]) {
  const seen: AssistantMessageParam[][] = [];
  const model: AssistantModel = {
    name: "scripted",
    async respond({ messages }) {
      seen.push(structuredClone(messages));
      const base = {
        id: "msg",
        type: "message",
        role: "assistant",
        model: "scripted",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      if (messages.length === 1)
        return {
          ...base,
          stop_reason: "tool_use",
          content: calls.map((c, i) => ({ type: "tool_use", id: `call_${i}`, name: c.name, input: c.input })),
        } as unknown as AssistantMessage;
      const results = messages.at(-1)!.content as { content: string; is_error?: boolean }[];
      return {
        ...base,
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: results.map((r) => (r.is_error ? `DENIED ${r.content}` : r.content)).join("\n"),
          },
        ],
      } as unknown as AssistantMessage;
    },
  };
  return { model, seen };
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
    expect(result.sources).toEqual(["Fees, Owing"]);

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
    expect(result.sources).toEqual(["Insights, Money"]);
    const toolResults = seen[1]!.at(-1)!.content as { is_error?: boolean }[];
    expect(toolResults.map((r) => r.is_error ?? false)).toEqual([true, false]);
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
    // Without a model configured for the deployment, it says so instead of calling anything.
    await expect(askAssistant(conn.app, s.owner, { question: "How are we doing?" })).rejects.toMatchObject({
      code: "assistant_not_configured",
    });
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
    const refusing: AssistantModel = {
      name: "refusing",
      respond: async () =>
        ({
          content: [],
          stop_reason: "refusal",
          usage: { input_tokens: 1, output_tokens: 1 },
        }) as unknown as AssistantMessage,
    };
    expect(
      (await askAssistant(conn.app, s.owner, { question: "Something off-limits" }, refusing)).status,
    ).toBe("refused");
    const broken: AssistantModel = {
      name: "broken",
      respond: async () => {
        throw new Error("network down");
      },
    };
    const failed = await askAssistant(conn.app, s.owner, { question: "How are we doing?" }, broken);
    expect(failed).toMatchObject({ status: "failed", sources: [] });
    await expect(askAssistant(conn.app, s.owner, { question: "x" }, broken)).rejects.toThrow();
  });
});
