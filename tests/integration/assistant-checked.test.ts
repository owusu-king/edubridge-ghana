import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { AiConfig } from "@/server/ai/config";
import { EVAL_CASES, runEvaluation } from "@/server/ai/eval";
import type { AiBlock, AiProvider } from "@/server/ai/types";
import { askAssistant, FORECAST_NOTE, listAssistantQueries } from "@/server/assistant/service";
import { ASSISTANT_TOOLS } from "@/server/assistant/tools";
import { withTenant } from "@/server/db/context";
import { assistantQueries } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { saveAssistantPreferences } from "@/server/tenancy/preferences";
import { DEFAULT_AI_LIMITS } from "@/lib/ai-providers";
import { conn, school as baseSchool, type School } from "../support/mobile-money";

afterAll(() => conn.close());

// The gateway's settings are passed in: a free provider, AI on (the platform's own settings are global).
const config: AiConfig = {
  enabled: true,
  provider: "groq",
  model: "scripted",
  baseUrl: null,
  apiKey: null,
  identifiableApproved: false,
  tasks: { assistant: true, remarks: true, announcements: true, board_report: true },
  limits: { ...DEFAULT_AI_LIMITS, userPerMinute: 60, userPerHour: 1000 },
};

/** Calls `calls` first, then answers with `text`, or with what the tools returned when `text` is not given. */
function scripted(
  calls: (question: string) => { name: string; input: Record<string, unknown> }[],
  text?: string,
) {
  const seen: string[] = [];
  const provider: AiProvider = {
    id: "scripted",
    model: "scripted",
    async respond({ messages }) {
      const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 };
      if (messages.length === 1)
        return {
          stop: "tool_calls",
          content: calls(String(messages[0]!.content)).map((c, i) => ({
            type: "tool_call",
            id: `c${i}`,
            name: c.name,
            input: c.input,
          })),
          usage,
        };
      const results = messages.at(-1)!.content as Extract<AiBlock, { type: "tool_result" }>[];
      seen.push(...results.map((r) => r.content));
      return {
        stop: "end",
        content: [{ type: "text", text: text ?? results.map((r) => r.content).join("\n") }],
        usage,
      };
    },
  };
  return { ai: { provider, config }, seen };
}

async function school(): Promise<School> {
  const s = await baseSchool();
  await saveAssistantPreferences(conn.app, s.owner, { assistantEnabled: true, assistantShareNames: false });
  return s;
}

describe("checked answers (AST-01)", () => {
  it("flags figures not in the records, keeps them with the question, and links the sources", async () => {
    const s = await school();
    await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);
    const { ai } = scripted(
      () => [{ name: "outstanding_fees", input: {} }],
      "Ama Mensah owes GH₵1,000.00, out of GH₵9,999.99 across the school.",
    );
    const answer = await askAssistant(conn.app, s.bursar, { question: "Who owes the most?" }, ai);
    expect(answer.uncheckedFigures).toEqual(["9,999.99"]);
    expect(answer.sources).toEqual([{ label: "Fees, Owing", path: "fees/owing" }]);
    const [row] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select().from(assistantQueries).where(eq(assistantQueries.id, answer.id)),
    );
    expect(row!.uncheckedFigures).toEqual(["9,999.99"]);
    expect((await listAssistantQueries(conn.app, s.owner, { everyone: true }))[0]!.uncheckedFigures).toEqual([
      "9,999.99",
    ]);
    // A figure the person wrote in the question is theirs, not flagged.
    const { ai: echo } = scripted(
      () => [{ name: "outstanding_fees", input: {} }],
      "Nobody owes more than 5000 cedis.",
    );
    expect(
      (await askAssistant(conn.app, s.bursar, { question: "Who owes more than 5000 cedis?" }, echo))
        .uncheckedFigures,
    ).toEqual([]);
  });

  it("says a forecast is a forecast when the model did not", async () => {
    const s = await school();
    const { ai } = scripted(
      () => [{ name: "collection_forecast", input: {} }],
      "There is not enough history yet.",
    );
    const answer = await askAssistant(conn.app, s.owner, { question: "What will we collect this term?" }, ai);
    expect(answer.answer).toBe(`There is not enough history yet.\n\n${FORECAST_NOTE}`);
    expect(answer.sources).toEqual([{ label: "Fees, Forecast", path: "fees/forecast" }]);
    const { ai: named } = scripted(
      () => [{ name: "collection_forecast", input: {} }],
      "The forecast needs history.",
    );
    expect((await askAssistant(conn.app, s.owner, { question: "What will we collect?" }, named)).answer).toBe(
      "The forecast needs history.",
    );
  });
});

describe("more of the school (AST-02)", () => {
  const added = [
    "command_center",
    "collection_forecast",
    "staff_and_leave",
    "transport",
    "inventory",
    "library",
    "boarding",
  ];

  it("reads each new area with the person's own permissions, and never safeguarding or early warning", async () => {
    const s = await school();
    const names = Object.keys(ASSISTANT_TOOLS);
    expect(names).toEqual(expect.arrayContaining(added));
    expect(names.some((n) => /safeguard|early|support_plan/.test(n))).toBe(false);
    const { ai, seen } = scripted(() => added.map((name) => ({ name, input: {} })));
    const answer = await askAssistant(conn.app, s.owner, { question: "Tell me about the school." }, ai);
    expect(answer.status).toBe("answered");
    expect(answer.sources.map((x) => x.label)).toEqual([
      "Command Center",
      "Fees, Forecast",
      "Staff and Leave",
      "Transport",
      "Inventory",
      "Library",
      "Boarding",
    ]);
    const [cc, forecast] = seen.map((c) => JSON.parse(c));
    expect(cc).toMatchObject({ term: "Term 1, 2026/2027", students: { inClasses: 0 } });
    expect(forecast).toMatchObject({ isForecast: true });

    // The accountant: money yes, staff records no (that section says so instead of failing the tool).
    const forBursar = scripted(() => [{ name: "staff_and_leave", input: {} }]);
    await askAssistant(conn.app, s.bursar, { question: "How many staff do we have?" }, forBursar.ai);
    expect(JSON.parse(forBursar.seen[0]!).staff).toBe(
      "Not available to this person's role or the school's plan.",
    );
  });
});

describe("the evaluation set (AIP-04)", () => {
  it("scores answers against figures our services work out, with tokens and cost, and writes no question", async () => {
    const s = await school();
    await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);
    const tool: Record<string, string> = {
      owed_today: "outstanding_fees",
      students_in_classes: "command_center",
      leave_waiting: "staff_and_leave",
      collection_forecast: "collection_forecast",
    };
    const cases = EVAL_CASES.filter((c) => tool[c.id]);
    const { ai } = scripted((q) => [{ name: tool[cases.find((c) => c.question === q)!.id]!, input: {} }]);
    const results = await runEvaluation(conn.app, s.owner, config, { cases, provider: ai.provider });
    expect(results.map((r) => [r.id, r.passed, r.skipped])).toEqual([
      ["owed_today", true, null],
      ["students_in_classes", true, null],
      ["leave_waiting", true, null],
      ["collection_forecast", true, null],
    ]);
    expect(results[0]).toMatchObject({
      expected: ["GH₵1,000.00"],
      inputTokens: 200,
      outputTokens: 40,
      costMicros: 0,
    });
    // A wrong answer fails, saying what was missing.
    const wrong = scripted(() => [{ name: "outstanding_fees", input: {} }], "Families owe GH₵5.00.");
    const [fail] = await runEvaluation(conn.app, s.owner, config, {
      cases: cases.slice(0, 1),
      provider: wrong.ai.provider,
    });
    expect(fail).toMatchObject({ passed: false, missing: ["GH₵1,000.00"], uncheckedFigures: ["5.00"] });
    expect(await listAssistantQueries(conn.app, s.owner, { everyone: true })).toEqual([]);
  });
});
