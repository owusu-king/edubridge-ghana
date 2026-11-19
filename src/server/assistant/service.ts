import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { assistantQueries, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { countryName, todayIn } from "../../lib/format";
import { AI_PROVIDERS } from "../../lib/ai-providers";
import { isConfigured, readAiConfig, type AiConfig } from "../ai/config";
import { AiUnavailableError, openAiSession, type AiSession } from "../ai/gateway";
import type { AiBlock, AiMessage, AiProvider } from "../ai/types";
import { readPreferences } from "../tenancy/preferences";
import { uncheckedFigures as findUnchecked } from "../../lib/answer-check";
import { ASSISTANT_TOOLS, runTool } from "./tools";

/**
 * The school assistant: a person asks a question about the school; the model may only answer from what
 * the read-only tools return (each one a service called with the person's own permissions), and every
 * question is recorded with the records it read and the answer (`assistant_queries`). It never writes,
 * never sees more than the person could open themselves, and says so when something is not in the
 * records or not available to their role. Every call goes through the AI gateway (`src/server/ai`), which
 * applies the feature flags and limits and records usage; with a provider not approved for identifiable data
 * (every free and local one), people and the school are never named to it (AIG-05).
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Tool rounds per question: enough to combine a few sources, never a runaway loop. */
const MAX_ROUNDS = 6;

function systemPrompt(ctx: TenantContext, nameSchool: boolean): string {
  return [
    `You answer questions from staff of ${nameSchool ? ctx.tenant.name : "the school"}, a school in ${countryName(ctx.tenant.countryCode)}, about the school's own records.`,
    `Today is ${todayIn(ctx.tenant.timezone)}. Money is in ${ctx.tenant.currencyCode}; amounts from the tools are already formatted in it.`,
    "Use the tools to read the records, and answer only from what they return. If the tools do not contain the answer, say what is missing; never estimate or invent figures, names or reasons. If a tool says something is not available to this person's role, tell them that.",
    "Results come from published report cards; attendance from registers, where late counts as attending; money from the fee ledger and receipts. Mention the term a figure belongs to.",
    "Be brief and plain: a sentence or two, then a short list or small table when it helps. Do not give advice about individual children beyond what the records show; suggest the relevant page instead.",
    "Give figures exactly as the tools return them. Every figure in your answer is checked against the tool results, and figures that are not there are flagged to the reader, so do not add up or work out new figures unless asked.",
    "Figures from collection_forecast are a forecast, not a fact: always call them a forecast.",
  ].join("\n");
}

const questionSchema = z.object({
  question: z.string().trim().min(3, "Ask a question.").max(500, "Keep the question under 500 characters."),
});

export interface AssistantSource {
  label: string;
  /** The page under the school, e.g. "fees/owing" ("" for the Command Center). */
  path: string;
}

export interface AssistantAnswer {
  id: string;
  answer: string;
  status: "answered" | "refused" | "failed";
  /** The pages the figures came from, for the person to check (AST-01b). */
  sources: AssistantSource[];
  /** Figures in the answer not found in what the tools returned (AST-01a). */
  uncheckedFigures: string[];
}

/** Added when an answer uses the forecast without saying it is one (AST-01c). */
export const FORECAST_NOTE =
  "These collection figures are a forecast from the school's past terms, not a promise.";

export interface AssistantRun {
  answer: string;
  status: AssistantAnswer["status"];
  used: { name: string; input: unknown; allowed: boolean }[];
  sources: AssistantSource[];
  uncheckedFigures: string[];
  inputTokens: number;
  outputTokens: number;
}

const FALLBACK = "Insights shows the same figures.";

export async function askAssistant(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  /** Tests: a scripted provider, and the gateway settings to use instead of the platform's. */
  ai: { provider: AiProvider; config?: AiConfig } | null = null,
): Promise<AssistantAnswer> {
  assertAllowed(ctx, "assistant.use");
  const { question } = questionSchema.parse(input);
  const prefs = await withTenant(database, scope(ctx), (tx) => readPreferences(tx, ctx.tenant.id));
  if (!prefs.assistantEnabled)
    throw new DomainError(
      "assistant_off_for_school",
      "The Proprietor has not turned the assistant on for this school (Settings, Assistant).",
    );
  let session: AiSession;
  try {
    session = await openAiSession(database, ctx, "assistant", ai ?? {});
  } catch (error) {
    if (!(error instanceof AiUnavailableError)) throw error;
    if (error.code === "ai_off" || error.code === "ai_not_configured" || error.code === "ai_task_off")
      throw new DomainError(
        "assistant_not_configured",
        `The assistant is not switched on for EduBridge yet. ${FALLBACK}`,
      );
    throw new DomainError(error.code, `${error.message} ${FALLBACK}`);
  }
  // Names go to the provider only if it is approved for identifiable data and the Proprietor agreed (AIG-05).
  const run = await runAssistant(
    database,
    ctx,
    question,
    session,
    session.identifiableApproved && prefs.assistantShareNames,
  );
  const { answer, status, used, inputTokens, outputTokens } = run;

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
        uncheckedFigures: run.uncheckedFigures,
        model: `${session.provider}:${session.model}`,
        inputTokens,
        outputTokens,
      })
      .returning({ id: assistantQueries.id });
    return row!.id;
  });
  return { id, answer, status, sources: run.sources, uncheckedFigures: run.uncheckedFigures };
}

/**
 * One question through an open AI session: the tool rounds, then the checks on the answer (AST-01). Writes nothing
 * to the school's question log (askAssistant does), so the evaluation set can use it too.
 */
export async function runAssistant(
  database: Database,
  ctx: TenantContext,
  question: string,
  session: AiSession,
  identifiable: boolean,
): Promise<AssistantRun> {
  const people = identifiable ? null : new Pseudonyms();
  const tools = Object.values(ASSISTANT_TOOLS).map((t) => t.definition);
  const messages: AiMessage[] = [{ role: "user", content: question }];
  const used: AssistantRun["used"] = [];
  // What the tools returned (before references replaced names), to check the answer's figures against.
  const read: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  let status: AssistantAnswer["status"] = "failed";

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await session.respond({ system: systemPrompt(ctx, identifiable), messages, tools });
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      if (response.stop === "refusal") {
        status = "refused";
        answer = "The assistant cannot help with that question.";
        break;
      }
      const calls = response.content.filter(
        (b): b is Extract<AiBlock, { type: "tool_call" }> => b.type === "tool_call",
      );
      if (response.stop !== "tool_calls" || calls.length === 0) {
        answer = response.content
          .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        status = answer ? "answered" : "failed";
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      const results: AiBlock[] = [];
      for (const call of calls) {
        const outcome = await runTool(database, ctx, call.name, call.input);
        used.push({ name: call.name, input: call.input, allowed: outcome.allowed });
        if (outcome.allowed) read.push(outcome.result);
        const shared = people && outcome.allowed ? people.hide(outcome.result) : outcome.result;
        results.push({
          type: "tool_result",
          callId: call.id,
          content: JSON.stringify(shared).slice(0, 60_000),
          ...(outcome.allowed ? {} : { isError: true }),
        });
      }
      messages.push({ role: "user", content: results });
    }
    if (!answer)
      answer = "The assistant could not finish an answer. Try a simpler question, or see Insights.";
    else if (people) answer = people.reveal(answer);
  } catch (error) {
    status = "failed";
    answer =
      error instanceof AiUnavailableError
        ? `${error.message} ${FALLBACK}`
        : `The assistant is not available right now. ${FALLBACK}`;
    if (!(error instanceof AiUnavailableError))
      console.error("assistant failed", error instanceof Error ? error.message : error);
  }

  // Figures the person wrote in the question are theirs, not the records'.
  const uncheckedFigures = status === "answered" ? findUnchecked(answer, [...read, question]) : [];
  if (
    status === "answered" &&
    used.some((u) => u.allowed && u.name === "collection_forecast") &&
    !/forecast/i.test(answer)
  )
    answer = `${answer}\n\n${FORECAST_NOTE}`;
  const sources = [
    ...new Map(
      used
        .filter((u) => u.allowed && ASSISTANT_TOOLS[u.name])
        .map((u) => ASSISTANT_TOOLS[u.name]!.source)
        .map((src) => [src.label, src] as const),
    ).values(),
  ];
  return { answer, status, used, sources, uncheckedFigures, inputTokens, outputTokens };
}

/**
 * Keys whose values identify a person in tool results (students, guardians, staff): names, admission numbers and
 * contact details. They are replaced by references before anything goes to a provider not approved for
 * identifiable data, or when the school has not agreed to share names.
 */
const PERSON_KEYS = new Set([
  "name",
  "teacher",
  "classTeacherName",
  "askedBy",
  "studentName",
  "guardianName",
  "staffName",
  "borrower",
  "student",
  "custodian",
  "requestedBy",
  "admissionNumber",
  "phone",
  "email",
]);

/**
 * Replaces people's names in tool results with references like [P3] before they go to the provider, and
 * puts the names back in the answer. The mapping lives only for one question, on the server.
 */
class Pseudonyms {
  private byName = new Map<string, string>();
  private byRef = new Map<string, string>();

  hide(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.hide(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          PERSON_KEYS.has(k) && typeof v === "string" && v ? this.ref(v) : this.hide(v),
        ]),
      );
    return value;
  }

  private ref(name: string): string {
    let ref = this.byName.get(name);
    if (!ref) {
      ref = `[P${this.byName.size + 1}]`;
      this.byName.set(name, ref);
      this.byRef.set(ref, name);
    }
    return ref;
  }

  reveal(text: string): string {
    return text.replace(/\[P\d+\]/g, (ref) => this.byRef.get(ref) ?? ref);
  }
}

export interface AssistantStatus {
  /** EduBridge has switched AI and the assistant on, with a provider set up. */
  platform: boolean;
  /** The school's plan includes it and the Proprietor has switched it on. */
  school: boolean;
  shareNames: boolean;
  /** The provider is not approved for identifiable data: names are never sent, whatever the school chose. */
  deidentified: boolean;
  /** The provider EduBridge uses, as named to schools. */
  provider: string;
}

/** Whether the assistant can run for this person's school, and how. */
export async function assistantStatus(database: Database, ctx: TenantContext): Promise<AssistantStatus> {
  const prefs = await withTenant(database, scope(ctx), (tx) => readPreferences(tx, ctx.tenant.id));
  const config = await readAiConfig(database);
  return {
    platform: config.enabled && config.tasks.assistant && isConfigured(config),
    school: prefs.assistantEnabled,
    shareNames: prefs.assistantShareNames,
    deidentified: !config.identifiableApproved,
    provider: AI_PROVIDERS[config.provider].label,
  };
}

export interface AssistantLogRow {
  id: string;
  askedBy: string;
  question: string;
  answer: string | null;
  status: "answered" | "refused" | "failed";
  tools: { name: string; input: unknown; allowed: boolean }[];
  /** Figures the answer gave that were not in the records it read (AST-01a). */
  uncheckedFigures: string[];
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
        uncheckedFigures: assistantQueries.uncheckedFigures,
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
