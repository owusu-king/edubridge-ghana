import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { assistantQueries, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { todayIn } from "../../lib/format";
import { assistantConfigured, claudeModel, type AssistantMessageParam, type AssistantModel } from "./model";
import { ASSISTANT_TOOLS, runTool } from "./tools";

/**
 * The school assistant: a person asks a question about the school; the model may only answer from what
 * the read-only tools return (each one a service called with the person's own permissions), and every
 * question is recorded with the records it read and the answer (`assistant_queries`). It never writes,
 * never sees more than the person could open themselves, and says so when something is not in the
 * records or not available to their role.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Tool rounds per question: enough to combine a few sources, never a runaway loop. */
const MAX_ROUNDS = 6;

function systemPrompt(ctx: TenantContext): string {
  return [
    `You answer questions from staff of ${ctx.tenant.name}, a school in Ghana, about the school's own records.`,
    `Today is ${todayIn(ctx.tenant.timezone)}. Money is in Ghana cedis (GH₵).`,
    "Use the tools to read the records, and answer only from what they return. If the tools do not contain the answer, say what is missing; never estimate or invent figures, names or reasons. If a tool says something is not available to this person's role, tell them that.",
    "Results come from published report cards; attendance from registers, where late counts as attending; money from the fee ledger and receipts. Mention the term a figure belongs to.",
    "Be brief and plain: a sentence or two, then a short list or small table when it helps. Do not give advice about individual children beyond what the records show; suggest the relevant page instead.",
  ].join("\n");
}

const questionSchema = z.object({
  question: z.string().trim().min(3, "Ask a question.").max(500, "Keep the question under 500 characters."),
});

export interface AssistantAnswer {
  id: string;
  answer: string;
  status: "answered" | "refused" | "failed";
  /** The records it read, for the person to check (page names). */
  sources: string[];
}

export async function askAssistant(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  model: AssistantModel | null = null,
): Promise<AssistantAnswer> {
  assertAllowed(ctx, "assistant.use");
  const { question } = questionSchema.parse(input);
  const llm = model ?? (assistantConfigured() ? claudeModel() : null);
  if (!llm)
    throw new DomainError(
      "assistant_not_configured",
      "The assistant is not switched on for EduBridge yet. Insights shows the same figures.",
    );

  const tools = Object.values(ASSISTANT_TOOLS).map((t) => t.definition);
  const messages: AssistantMessageParam[] = [{ role: "user", content: question }];
  const used: { name: string; input: unknown; allowed: boolean }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  let status: AssistantAnswer["status"] = "failed";

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await llm.respond({ system: systemPrompt(ctx), messages, tools });
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      if (response.stop_reason === "refusal") {
        status = "refused";
        answer = "The assistant cannot help with that question.";
        break;
      }
      const calls = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || calls.length === 0) {
        answer = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        status = answer ? "answered" : "failed";
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const call of calls) {
        const outcome = await runTool(database, ctx, call.name, call.input);
        used.push({ name: call.name, input: call.input, allowed: outcome.allowed });
        results.push({
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: JSON.stringify(outcome.result).slice(0, 60_000),
          ...(outcome.allowed ? {} : { is_error: true }),
        });
      }
      messages.push({ role: "user", content: results });
    }
    if (!answer)
      answer = "The assistant could not finish an answer. Try a simpler question, or see Insights.";
  } catch (error) {
    status = "failed";
    answer = "The assistant is not available right now. Insights shows the same figures.";
    console.error("assistant failed", error instanceof Error ? error.message : error);
  }

  const id = await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .insert(assistantQueries)
      .values({
        tenantId: ctx.tenant.id,
        userId: ctx.userId,
        question,
        answer,
        status,
        tools: used,
        model: llm.name,
        inputTokens,
        outputTokens,
      })
      .returning({ id: assistantQueries.id });
    return row!.id;
  });
  const sources = [
    ...new Set(
      used
        .filter((u) => u.allowed)
        .map((u) => ASSISTANT_TOOLS[u.name]?.source)
        .filter(Boolean),
    ),
  ] as string[];
  return { id, answer, status, sources };
}

export interface AssistantLogRow {
  id: string;
  askedBy: string;
  question: string;
  answer: string | null;
  status: "answered" | "refused" | "failed";
  tools: { name: string; input: unknown; allowed: boolean }[];
  bySupport: boolean;
  createdAt: Date;
}

/** Recent questions: the person's own, or everyone's for those who see the audit log. */
export async function listAssistantQueries(
  database: Database,
  ctx: TenantContext,
  options: { everyone?: boolean } = {},
): Promise<AssistantLogRow[]> {
  assertAllowed(ctx, "assistant.use");
  const everyone = options.everyone && allowed(ctx, "audit.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: assistantQueries.id,
        askedBy: users.name,
        question: assistantQueries.question,
        answer: assistantQueries.answer,
        status: assistantQueries.status,
        tools: assistantQueries.tools,
        supportGrantId: assistantQueries.supportGrantId,
        createdAt: assistantQueries.createdAt,
      })
      .from(assistantQueries)
      .innerJoin(users, eq(users.id, assistantQueries.userId))
      .where(
        and(
          eq(assistantQueries.tenantId, ctx.tenant.id),
          everyone ? undefined : eq(assistantQueries.userId, ctx.userId),
        ),
      )
      .orderBy(desc(assistantQueries.createdAt))
      .limit(50);
    return rows.map(({ supportGrantId, ...r }) => ({ ...r, bySupport: supportGrantId !== null }));
  });
}
