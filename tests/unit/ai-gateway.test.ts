import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limitReached } from "@/server/ai/gateway";
import {
  fromChatCompletion,
  openAiCompatibleProvider,
  toChatMessages,
} from "@/server/ai/providers/openai-compatible";
import { ProviderError } from "@/server/ai/types";
import { canApproveIdentifiable, DEFAULT_AI_LIMITS, estimateCostMicros } from "@/lib/ai-providers";

describe("the OpenAI-compatible adapter (AIG-01)", () => {
  it("translates the neutral conversation, tool calls and results included", () => {
    expect(
      toChatMessages("Rules", [
        { role: "user", content: "Who owes?" },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "c1", name: "owing", input: { limit: 5 } }],
        },
        { role: "user", content: [{ type: "tool_result", callId: "c1", content: "[]", isError: true }] },
      ]),
    ).toEqual([
      { role: "system", content: "Rules" },
      { role: "user", content: "Who owes?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "owing", arguments: '{"limit":5}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ERROR: []" },
    ]);
    expect(
      fromChatCompletion({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{ id: "x", function: { name: "owing", arguments: "not json" } }],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      }),
    ).toEqual({
      stop: "tool_calls",
      content: [{ type: "tool_call", id: "x", name: "owing", input: {} }],
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
    });
  });

  // A stand-in provider on this machine: no network beyond localhost, no cost.
  const seen: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  let status = 200;
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      if (status === 429) {
        res.writeHead(429, { "retry-after": "120" }).end("slow down");
        return;
      }
      res.writeHead(status, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "Three families owe fees." } }],
          usage: { prompt_tokens: 50, completion_tokens: 6 },
        }),
      );
    });
  });
  let url = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("calls the chat API with the model, tools, output cap and key, and reads the answer", async () => {
    const provider = openAiCompatibleProvider({
      id: "groq",
      baseUrl: `${url}/`,
      model: "llama",
      apiKey: "k-test",
    });
    const reply = await provider.respond(
      {
        system: "Rules",
        messages: [{ role: "user", content: "Who owes?" }],
        tools: [{ name: "owing", description: "Owing", input_schema: { type: "object" }, strict: true }],
        maxOutputTokens: 500,
      },
      AbortSignal.timeout(5_000),
    );
    expect(reply).toEqual({
      stop: "end",
      content: [{ type: "text", text: "Three families owe fees." }],
      usage: { inputTokens: 50, outputTokens: 6, cachedInputTokens: 0 },
    });
    expect(seen[0]!.auth).toBe("Bearer k-test");
    expect(seen[0]!.body).toMatchObject({
      model: "llama",
      max_tokens: 500,
      tools: [{ type: "function", function: { name: "owing", parameters: { type: "object" } } }],
    });
    // The strict flag is not sent: some OpenAI-compatible servers refuse unknown fields.
    expect(JSON.stringify(seen[0]!.body.tools)).not.toContain("strict");
  });

  it("reports the provider's rate or quota limit, with when to try again, and an unreachable provider", async () => {
    status = 429;
    const provider = openAiCompatibleProvider({ id: "groq", baseUrl: url, model: "llama", apiKey: null });
    const request = { system: "", messages: [], tools: [], maxOutputTokens: 256 };
    await expect(provider.respond(request, AbortSignal.timeout(5_000))).rejects.toMatchObject({
      kind: "quota",
      retryAfterSeconds: 120,
    });
    status = 200;
    const gone = openAiCompatibleProvider({
      id: "ollama",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "x",
      apiKey: null,
    });
    await expect(gone.respond(request, AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("costs, approval and limits (AIG-03 to AIG-05)", () => {
  it("costs nothing on free and local providers, and only paid ones can be approved for identifiable data", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 500_000 };
    expect(estimateCostMicros("groq", "llama-3.3-70b-versatile", usage)).toBe(0);
    expect(estimateCostMicros("ollama", "llama3.1:8b", usage)).toBe(0);
    // Opus 5.5: 500,000 fresh × $4 + 500,000 cached × $0.20 + 100,000 out × $20 per million = $4.10.
    expect(estimateCostMicros("anthropic", "claude-opus-5-5", usage)).toBe(4_100_000);
    expect(estimateCostMicros("openai_compatible", "unknown", usage)).toBeNull();
    expect(["ollama", "groq", "none"].map((p) => canApproveIdentifiable(p as "groq"))).toEqual([
      false,
      false,
      false,
    ]);
    expect(canApproveIdentifiable("anthropic")).toBe(true);
  });

  it("names the first limit reached, with when it starts again", () => {
    const c = {
      platformTokens: 0,
      schoolTokens: 0,
      userTokensToday: 0,
      userRequestsMinute: 0,
      userRequestsHour: 0,
    };
    const l = DEFAULT_AI_LIMITS;
    expect(limitReached(c, l, "2026-11-18", true)).toBeNull();
    expect(limitReached({ ...c, schoolTokens: l.schoolMonthlyTokens }, l, "2026-11-18", true)).toMatchObject({
      code: "ai_limit_school",
      message: "This school's AI allowance for this month is used up. It starts again on 1 Dec 2026.",
    });
    expect(
      limitReached({ ...c, platformTokens: 1 }, { ...l, platformMonthlyTokens: 0 }, "2026-12-31", true),
    ).toMatchObject({ code: "ai_limit_platform", message: expect.stringContaining("1 Jan 2027") });
    expect(limitReached({ ...c, userRequestsMinute: l.userPerMinute }, l, "2026-11-18", true)?.code).toBe(
      "ai_limit_minute",
    );
    // Rate limits count requests (questions): the calls within an open request are not throttled.
    expect(limitReached({ ...c, userRequestsMinute: l.userPerMinute }, l, "2026-11-18", false)).toBeNull();
    expect(limitReached({ ...c, userTokensToday: l.userDailyTokens }, l, "2026-11-18", false)?.code).toBe(
      "ai_limit_day",
    );
  });
});
