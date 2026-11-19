import "server-only";
import { containsFigure } from "../../lib/answer-check";
import { estimateCostMicros } from "../../lib/ai-providers";
import { formatMoney } from "../../lib/money";
import { getCurrentTerm } from "../academics/calendar";
import { runAssistant } from "../assistant/service";
import { listExeats } from "../boarding/boarders";
import { getOwedToday, getTermFinance } from "../dashboard/finance";
import { getEnrolment } from "../dashboard/school";
import type { Database } from "../db/client";
import { getCollectionForecast } from "../forecasting/forecast";
import { getTermTrends } from "../insights/service";
import { listOpenLoans } from "../library/loans";
import { listStockItems } from "../inventory/stock";
import { getLeaveOverview } from "../staff/leave";
import type { TenantContext } from "../tenancy/service";
import type { AiConfig } from "./config";
import { AiUnavailableError, openAiSession } from "./gateway";
import type { AiProvider } from "./types";

/**
 * The assistant's evaluation set (R5-4, AIP-04): questions about the seeded synthetic school, each with the figures a
 * correct answer must contain, worked out by our own services. Run on request before changing the model, the prompt
 * or a tool (`npm run ai:eval`); a run calls the provider, so it is never part of CI. It writes nothing to the
 * school's question log; the gateway still records each call's usage and cost.
 */

export interface EvalCase {
  id: string;
  question: string;
  /** The figures (as our code formats them) or words a correct answer contains; null when it does not apply. */
  expected: (database: Database, ctx: TenantContext) => Promise<string[] | null>;
}

const currentTermId = async (database: Database, ctx: TenantContext) =>
  (await getCurrentTerm(database, ctx))?.id;
const money = (ctx: TenantContext, minor: number) => formatMoney(minor, ctx.tenant.currencyCode);

export const EVAL_CASES: EvalCase[] = [
  {
    id: "owed_today",
    question: "How much do families owe the school today, in total?",
    expected: async (db, ctx) => [money(ctx, (await getOwedToday(db, ctx)).totalPesewas)],
  },
  {
    id: "students_in_classes",
    question: "How many students are in classes this term?",
    expected: async (db, ctx) => {
      const term = await currentTermId(db, ctx);
      const e = term ? await getEnrolment(db, ctx, term) : null;
      return e ? [String(e.total)] : null;
    },
  },
  {
    id: "collected_this_term",
    question: "How much has the school collected this term, and what share of the billed fees is that?",
    expected: async (db, ctx) => {
      const term = await currentTermId(db, ctx);
      const f = term ? await getTermFinance(db, ctx, term) : null;
      if (!f?.collected || f.collectionRate === null) return null;
      return [money(ctx, f.collected.totalPesewas), String(f.collectionRate)];
    },
  },
  {
    id: "attendance_rate",
    question: "What is this term's attendance rate?",
    expected: async (db, ctx) => {
      const current = (await getTermTrends(db, ctx, 1)).at(-1);
      return current?.attendanceRate === null || current === undefined
        ? null
        : [String(current.attendanceRate)];
    },
  },
  {
    id: "library_overdue",
    question: "How many library books are overdue?",
    expected: async (db, ctx) => [
      String((await listOpenLoans(db, ctx)).filter((l) => l.daysLate > 0).length),
    ],
  },
  {
    id: "boarders_out",
    question: "How many boarders are out on exeat right now?",
    expected: async (db, ctx) => [String((await listExeats(db, ctx)).out.length)],
  },
  {
    id: "low_stock",
    question: "Which stock items are running low?",
    expected: async (db, ctx) => {
      const low = (await listStockItems(db, ctx)).filter((s) => s.status === "active" && s.low);
      return low.length ? low.map((s) => s.name) : [];
    },
  },
  {
    id: "leave_waiting",
    question: "How many leave requests are waiting for a decision?",
    expected: async (db, ctx) => [String((await getLeaveOverview(db, ctx)).waiting.length)],
  },
  {
    id: "collection_forecast",
    question: "What does the forecast say we will have collected by the end of this term?",
    expected: async (db, ctx) => {
      const term = await currentTermId(db, ctx);
      const f = term ? await getCollectionForecast(db, ctx, term) : null;
      if (!f) return null;
      if (f.forecast.status === "no_history") return ["history"];
      if (f.forecast.status !== "forecast") return null;
      return [money(ctx, f.forecast.endOfTerm.likelyPesewas), "forecast"];
    },
  },
];

export interface EvalResult {
  id: string;
  question: string;
  passed: boolean;
  /** Why it did not run (no data for it, or AI unavailable). */
  skipped: string | null;
  expected: string[];
  missing: string[];
  uncheckedFigures: string[];
  answer: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in millionths of a US dollar; zero with free and local providers, null if not known. */
  costMicros: number | null;
}

/** Scores one answer: answered, every expected figure in it, and no figure it could not check. */
export function score(
  run: { status: string; answer: string; uncheckedFigures: string[] },
  expected: string[],
): { passed: boolean; missing: string[] } {
  const missing = expected.filter((e) => !containsFigure(run.answer, e));
  return {
    passed: run.status === "answered" && missing.length === 0 && run.uncheckedFigures.length === 0,
    missing,
  };
}

/** Runs the evaluation set (or some cases) as a person, with the given gateway settings. */
export async function runEvaluation(
  database: Database,
  ctx: TenantContext,
  config: AiConfig,
  options: { cases?: EvalCase[]; provider?: AiProvider } = {},
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of options.cases ?? EVAL_CASES) {
    const base = {
      id: c.id,
      question: c.question,
      expected: [] as string[],
      missing: [],
      uncheckedFigures: [],
    };
    const empty = { ...base, answer: "", inputTokens: 0, outputTokens: 0, costMicros: 0 };
    let expected: string[] | null;
    try {
      expected = await c.expected(database, ctx);
    } catch (error) {
      results.push({
        ...empty,
        passed: false,
        skipped: `No data: ${error instanceof Error ? error.message : error}`,
      });
      continue;
    }
    if (expected === null) {
      results.push({ ...empty, passed: false, skipped: "Nothing in the records for this question." });
      continue;
    }
    try {
      const session = await openAiSession(database, ctx, "assistant", { config, provider: options.provider });
      // Never identifiable in an evaluation, whatever the provider: the cases do not need names.
      const run = await runAssistant(database, ctx, c.question, session, false);
      const scored = score(run, expected);
      results.push({
        ...base,
        expected,
        passed: scored.passed,
        skipped: null,
        missing: scored.missing,
        uncheckedFigures: run.uncheckedFigures,
        answer: run.answer,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costMicros: estimateCostMicros(config.provider, config.model, {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cachedInputTokens: 0,
        }),
      });
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      results.push({ ...empty, expected, passed: false, skipped: error.message });
    }
  }
  return results;
}
