import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ForbiddenError } from "../authz/permissions";
import type { Database } from "../db/client";
import { DomainError } from "../errors";
import { listOwing } from "../fees/owing";
import {
  getAttendanceInsights,
  getFinanceInsights,
  getLevelPerformance,
  getOperationsInsights,
  getStudentTrends,
  getTermTrends,
  seesAcademics,
  seesFinance,
} from "../insights/service";
import { listStudents } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { formatCedis } from "../../lib/money";

/**
 * What the school assistant can read: each tool calls the same service a page uses, with the asking
 * person's own context, so their role, the plan's modules and their campus scope apply exactly as on
 * screen. Nothing here writes. Money goes to the model in cedis as text (never floating point sums), and
 * results are capped so a question never ships a whole school's records.
 */

export interface AssistantTool {
  definition: Anthropic.Beta.Messages.BetaTool;
  /** Where a person can see the same records (shown with the answer). */
  source: string;
  run: (database: Database, ctx: TenantContext, input: unknown) => Promise<unknown>;
}

/** Results and attendance are for academic leads; money for finance staff (as on the Insights page). */
const academic =
  (run: AssistantTool["run"]): AssistantTool["run"] =>
  async (database, ctx, input) => {
    if (!seesAcademics(ctx)) throw new ForbiddenError("academics.manage");
    return run(database, ctx, input);
  };
const financial =
  (run: AssistantTool["run"]): AssistantTool["run"] =>
  async (database, ctx, input) => {
    if (!seesFinance(ctx)) throw new ForbiddenError("fees.view");
    return run(database, ctx, input);
  };

const cedis = (pesewas: number | null | undefined) =>
  pesewas === null || pesewas === undefined ? null : formatCedis(pesewas);
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const ASSISTANT_TOOLS: Record<string, AssistantTool> = {
  term_trends: {
    source: "Insights, Term by term",
    definition: {
      name: "term_trends",
      description:
        "The school term by term for the last terms that have started (oldest first): students enrolled and new, attendance and lateness rates (%), average report-card result out of 100, fees billed, collected and collected as a % of billed. Use for revenue this term, comparisons across terms and years, enrolment trends.",
      input_schema: schema({
        terms: { type: "integer", description: "How many terms, 1 to 6 (default 6)." },
      }),
      strict: true,
    },
    run: async (database, ctx, input) => {
      const { terms } = z.object({ terms: z.number().int().min(1).max(6).optional() }).parse(input);
      return (await getTermTrends(database, ctx, terms ?? 6)).map((t) => ({
        term: t.label,
        current: t.current,
        enrolled: t.enrolled,
        newStudents: t.newStudents,
        attendanceRate: t.attendanceRate,
        latenessRate: t.latenessRate,
        averageResult: t.averageScore,
        publishedReportCards: t.publishedCards,
        billed: cedis(t.billedPesewas),
        collected: cedis(t.collectedPesewas),
        collectedOfBilledPercent: t.collectionRate,
      }));
    },
  },
  student_trends: {
    source: "Insights, Students to follow up",
    definition: {
      name: "student_trends",
      description:
        "From published report cards: students whose average fell by at least `drop` points between their last two report cards (declining), and students whose latest average is below `below` (may need support).",
      input_schema: schema({
        drop: { type: "number", description: "Points of fall that count as declining (default 10)." },
        below: {
          type: "number",
          description: "Average below which a student may need support (default 50).",
        },
      }),
      strict: true,
    },
    run: academic(async (database, ctx, input) => {
      const p = z
        .object({ drop: z.number().min(1).max(100).optional(), below: z.number().min(1).max(100).optional() })
        .parse(input);
      const r = await getStudentTrends(database, ctx, { ...p, limit: 30 });
      const shape = (s: (typeof r.declining)[number]) => ({
        name: s.name,
        class: s.className,
        previous: s.previous,
        latest: s.latest,
        change: s.change,
      });
      return { declining: r.declining.map(shape), mayNeedSupport: r.support.map(shape) };
    }),
  },
  level_performance: {
    source: "Insights, Results by level",
    definition: {
      name: "level_performance",
      description:
        "Results for a level (e.g. 'Basic 5', 'Primary 5', 'JHS 1') or every level, across recent terms: the average report-card result and each subject's average, from published report cards.",
      input_schema: schema({
        level: {
          type: "string",
          description: "The level's name as the school uses it; omit for every level.",
        },
        terms: { type: "integer", description: "How many recent terms, 1 to 6 (default 3)." },
      }),
      strict: true,
    },
    run: academic(async (database, ctx, input) => {
      const p = z
        .object({ level: z.string().max(60).optional(), terms: z.number().int().min(1).max(6).optional() })
        .parse(input);
      // Schools say "Primary 5" and "Basic 5" for the same level; the school's own name is tried first.
      let found = await getLevelPerformance(database, ctx, { levelName: p.level, limit: p.terms ?? 3 });
      if (!found.length && p.level && /^primary\s+/i.test(p.level))
        found = await getLevelPerformance(database, ctx, {
          levelName: p.level.replace(/^primary/i, "Basic"),
          limit: p.terms ?? 3,
        });
      return found.length ? found : { note: "No published report cards for that level in these terms." };
    }),
  },
  attendance: {
    source: "Insights, Attendance",
    definition: {
      name: "attendance",
      description:
        "This term's attendance: absence and lateness by class (highest absence first), students absent on 10% or more of their registers, and students late three or more times in the last 30 days.",
      input_schema: schema({}),
      strict: true,
    },
    run: academic(async (database, ctx) => {
      const a = await getAttendanceInsights(database, ctx);
      return {
        term: a.term?.label ?? null,
        byClass: a.byClass.slice(0, 40),
        oftenAbsent: a.chronic.slice(0, 30),
        oftenLate: a.lateness.slice(0, 30),
      };
    }),
  },
  money: {
    source: "Insights, Money",
    definition: {
      name: "money",
      description:
        "This term's fees by level (billed, collected, owed today) and unpaid payment-plan instalments by when they fall due (overdue, next 30/60/90 days).",
      input_schema: schema({}),
      strict: true,
    },
    run: financial(async (database, ctx) => {
      const f = await getFinanceInsights(database, ctx);
      return {
        term: f.term?.label ?? null,
        byLevel: f.byLevel.map((l) => ({
          level: l.levelName,
          students: l.students,
          billed: cedis(l.billedPesewas),
          collected: cedis(l.collectedPesewas),
          owedToday: cedis(l.owedPesewas),
        })),
        paymentPlans: {
          activePlans: f.planDue.plans,
          overdue: cedis(f.planDue.overduePesewas),
          dueNext30Days: cedis(f.planDue.next30Pesewas),
          due31To60Days: cedis(f.planDue.next60Pesewas),
          due61To90Days: cedis(f.planDue.next90Pesewas),
        },
      };
    }),
  },
  outstanding_fees: {
    source: "Fees, Owing",
    definition: {
      name: "outstanding_fees",
      description:
        "Students who owe fees today, largest balance first (at most 50), with the total owed by everyone matching, how many have no guardian phone, and whether they are behind on a payment plan.",
      input_schema: schema({
        min_cedis: { type: "string", description: "Only balances of at least this many cedis, e.g. '500'." },
        behind_on_plan: { type: "boolean", description: "Only families behind on a payment plan." },
      }),
      strict: true,
    },
    run: async (database, ctx, input) => {
      const p = z
        .object({ min_cedis: z.string().max(12).optional(), behind_on_plan: z.boolean().optional() })
        .parse(input);
      const page = await listOwing(database, ctx, {
        minAmount: p.min_cedis,
        overdueOnly: p.behind_on_plan ?? false,
        page: 1,
      });
      return {
        studentsOwing: page.total,
        totalOwed: cedis(page.owedPesewas),
        withoutGuardianPhone: page.withoutPhone,
        largest: page.rows.slice(0, 50).map((r) => ({
          name: r.name,
          class: r.className,
          owes: cedis(r.balancePesewas),
          lastPaidOn: r.lastPaidOn,
          behindOnPlan: r.plan ? cedis(r.plan.overduePesewas) : null,
        })),
      };
    },
  },
  outstanding_work: {
    source: "Insights, Outstanding work",
    definition: {
      name: "outstanding_work",
      description:
        "Work not done: classes with registers not taken on school days in the last two weeks (with the class teacher and the days), and classes whose score sheets are not complete this term (with the class teacher). Use for 'which teachers have not submitted results'.",
      input_schema: schema({}),
      strict: true,
    },
    run: academic(async (database, ctx) => getOperationsInsights(database, ctx)),
  },
  find_students: {
    source: "Students",
    definition: {
      name: "find_students",
      description:
        "Find students by name or admission number (at most 20), with their class this term and status.",
      input_schema: schema(
        { query: { type: "string", description: "Part of a name or an admission number." } },
        ["query"],
      ),
      strict: true,
    },
    run: async (database, ctx, input) => {
      const { query } = z.object({ query: z.string().min(1).max(100) }).parse(input);
      const r = await listStudents(database, ctx, { q: query });
      return r.rows.slice(0, 20).map((s) => ({
        name: s.fullName,
        admissionNumber: s.admissionNumber,
        class: s.className,
        status: s.status,
      }));
    },
  },
};

export type ToolOutcome = { allowed: true; result: unknown } | { allowed: false; result: string };

/** Runs a tool for the person; refusals by their role or plan come back as text the model must respect. */
export async function runTool(
  database: Database,
  ctx: TenantContext,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const tool = ASSISTANT_TOOLS[name];
  if (!tool) return { allowed: false, result: `There is no tool called ${name}.` };
  try {
    return { allowed: true, result: await tool.run(database, ctx, input) };
  } catch (error) {
    if (error instanceof ForbiddenError)
      return {
        allowed: false,
        result: "Not available to this person's role. Say so; do not guess the figures.",
      };
    if (error instanceof DomainError) return { allowed: false, result: error.message };
    if (error instanceof z.ZodError) return { allowed: false, result: "The tool input was not valid." };
    throw error;
  }
}
