import "server-only";
import { z } from "zod";
import { ForbiddenError } from "../authz/permissions";
import type { Database } from "../db/client";
import { DomainError } from "../errors";
import { getCurrentTerm } from "../academics/calendar";
import { getOperationsNow, getMovement } from "../dashboard/board-summary";
import { getOwedToday, getTermFinance } from "../dashboard/finance";
import { getEnrolment } from "../dashboard/school";
import { listExeats } from "../boarding/boarders";
import { listHouses } from "../boarding/houses";
import { getCollectionForecast } from "../forecasting/forecast";
import { listAssets } from "../inventory/assets";
import { listMaintenance } from "../inventory/maintenance";
import { listPurchaseRequests } from "../inventory/purchases";
import { listStockItems } from "../inventory/stock";
import { listTitles } from "../library/catalogue";
import { listOpenLoans } from "../library/loans";
import { getLeaveOverview } from "../staff/leave";
import { listStaff } from "../staff/records";
import { listRoutes } from "../transport/setup";
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
import type { AiTool } from "../ai/types";
import type { TenantContext } from "../tenancy/service";
import { formatMoney } from "../../lib/money";

/**
 * What the school assistant can read: each tool calls the same service a page uses, with the asking
 * person's own context, so their role, the plan's modules and their campus scope apply exactly as on
 * screen. Nothing here writes, and nothing reads safeguarding, early warning or support plans (AST-02). Money goes to the model in cedis as text (never floating point sums), and
 * results are capped so a question never ships a whole school's records.
 */

export interface AssistantTool {
  definition: AiTool;
  /** The page where a person can see the same records (linked with the answer). */
  source: { label: string; path: string };
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

/** Amounts in the school's currency, as the assistant shows them. */
const money = (ctx: TenantContext, minor: number | null | undefined) =>
  minor === null || minor === undefined ? null : formatMoney(minor, ctx.tenant.currencyCode);
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

/** Left out because the person's role or the school's plan does not include it. */
const NOT_SHOWN = "Not available to this person's role or the school's plan.";
/** A section the person may not see becomes NOT_SHOWN instead of failing the whole tool. */
async function optional<T>(run: () => Promise<T>): Promise<T | typeof NOT_SHOWN> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof DomainError) return NOT_SHOWN;
    throw error;
  }
}
const isShown = <T>(v: T | typeof NOT_SHOWN): v is T => v !== NOT_SHOWN;

export const ASSISTANT_TOOLS: Record<string, AssistantTool> = {
  term_trends: {
    source: { label: "Insights, Term by term", path: "insights" },
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
        billed: money(ctx, t.billedPesewas),
        collected: money(ctx, t.collectedPesewas),
        collectedOfBilledPercent: t.collectionRate,
      }));
    },
  },
  student_trends: {
    source: { label: "Insights, Students to follow up", path: "insights" },
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
    source: { label: "Insights, Results by level", path: "insights" },
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
    source: { label: "Insights, Attendance", path: "insights" },
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
    source: { label: "Insights, Money", path: "insights" },
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
          billed: money(ctx, l.billedPesewas),
          collected: money(ctx, l.collectedPesewas),
          owedToday: money(ctx, l.owedPesewas),
        })),
        paymentPlans: {
          activePlans: f.planDue.plans,
          overdue: money(ctx, f.planDue.overduePesewas),
          dueNext30Days: money(ctx, f.planDue.next30Pesewas),
          due31To60Days: money(ctx, f.planDue.next60Pesewas),
          due61To90Days: money(ctx, f.planDue.next90Pesewas),
        },
      };
    }),
  },
  outstanding_fees: {
    source: { label: "Fees, Owing", path: "fees/owing" },
    definition: {
      name: "outstanding_fees",
      description:
        "Students who owe fees today, largest balance first (at most 50), with the total owed by everyone matching, how many have no guardian phone, and whether they are behind on a payment plan.",
      input_schema: schema({
        min_cedis: {
          type: "string",
          description: "Only balances of at least this amount in the school's currency, e.g. '500'.",
        },
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
        totalOwed: money(ctx, page.owedPesewas),
        withoutGuardianPhone: page.withoutPhone,
        largest: page.rows.slice(0, 50).map((r) => ({
          name: r.name,
          class: r.className,
          owes: money(ctx, r.balancePesewas),
          lastPaidOn: r.lastPaidOn,
          behindOnPlan: r.plan ? money(ctx, r.plan.overduePesewas) : null,
        })),
      };
    },
  },
  outstanding_work: {
    source: { label: "Insights, Outstanding work", path: "insights" },
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
    source: { label: "Students", path: "students" },
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
  command_center: {
    source: { label: "Command Center", path: "" },
    definition: {
      name: "command_center",
      description:
        "The Command Center for the current term: fees billed and collected and the collection rate, owed today across every term, students in classes with admissions, leavers and retention from last term, and operations now (leave waiting, repairs, purchases waiting, boarders overdue back, library books overdue, pickups refused today, visitors on site). Sections the person may not see are left out.",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const term = await getCurrentTerm(database, ctx);
      if (!term) return { note: "No current term is set." };
      const [finance, owed, enrolment, movement, operations] = await Promise.all([
        optional(() => getTermFinance(database, ctx, term.id)),
        optional(() => getOwedToday(database, ctx)),
        optional(() => getEnrolment(database, ctx, term.id)),
        optional(() => getMovement(database, ctx, term.id)),
        optional(() => getOperationsNow(database, ctx)),
      ]);
      return {
        term: `${term.name}, ${term.yearName}`,
        money: isShown(finance)
          ? {
              billed: money(ctx, finance?.billedPesewas),
              collected: money(ctx, finance?.collected?.totalPesewas ?? 0),
              collectionRatePercent: finance?.collectionRate ?? null,
              owedToday: isShown(owed) ? money(ctx, owed?.totalPesewas) : NOT_SHOWN,
              studentsOwing: isShown(owed) ? owed?.students : NOT_SHOWN,
            }
          : NOT_SHOWN,
        students: isShown(enrolment)
          ? {
              inClasses: enrolment?.total ?? 0,
              girls: enrolment?.female ?? 0,
              boys: enrolment?.male ?? 0,
              applicationsThisTerm: isShown(movement) ? movement?.applications : NOT_SHOWN,
              admittedThisTerm: isShown(movement) ? movement?.admitted : NOT_SHOWN,
              leftThisTerm: isShown(movement) ? movement?.left : NOT_SHOWN,
              retentionFromLastTermPercent: isShown(movement)
                ? (movement?.retention?.rate ?? null)
                : NOT_SHOWN,
            }
          : NOT_SHOWN,
        operationsNow: isShown(operations) && operations ? operations : NOT_SHOWN,
      };
    },
  },
  collection_forecast: {
    source: { label: "Fees, Forecast", path: "fees/forecast" },
    definition: {
      name: "collection_forecast",
      description:
        "The collection FORECAST for the current term, from the school's own past terms: billed, collected so far, and what is likely to be collected by the end of term with a low-high range, plus how last term's forecast turned out. These figures are a forecast, not a fact: say so whenever you use them.",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const term = await getCurrentTerm(database, ctx);
      if (!term) return { note: "No current term is set." };
      const f = await getCollectionForecast(database, ctx, term.id);
      if (!f) return { note: "No current term is set." };
      const r = f.forecast;
      const base = { isForecast: true, term: f.term.label, asOf: f.asOf };
      if (r.status === "no_history")
        return {
          ...base,
          note: "Not enough history: no complete past term with fees billed. Say so; do not estimate.",
        };
      if (r.status === "not_billed") return { ...base, note: "This term has not been billed yet." };
      if (r.status === "ended")
        return {
          ...base,
          ended: true,
          billed: money(ctx, r.billedPesewas),
          collected: money(ctx, r.collectedPesewas),
        };
      return {
        ...base,
        billed: money(ctx, r.billedPesewas),
        collectedSoFar: money(ctx, r.collectedPesewas),
        forecastEndOfTermLikely: money(ctx, r.endOfTerm.likelyPesewas),
        forecastEndOfTermLow: money(ctx, r.endOfTerm.lowPesewas),
        forecastEndOfTermHigh: money(ctx, r.endOfTerm.highPesewas),
        basedOnPastTerms: r.basedOn.map((b) => b.label),
        lastTermCheck: f.backtest
          ? {
              term: f.backtest.label,
              forecast: money(ctx, f.backtest.forecastPesewas),
              collected: money(ctx, f.backtest.collectedPesewas),
              differencePercent: f.backtest.errorPercent,
            }
          : null,
      };
    },
  },
  staff_and_leave: {
    source: { label: "Staff and Leave", path: "staff" },
    definition: {
      name: "staff_and_leave",
      description:
        "Staff in post (counts by department and employment type) and leave: requests waiting for a decision (who and which days), who is away today, and how many requests of each kind of leave are waiting. Reasons for leave, and which kind of leave a named person is on, are never given.",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const [staff, leave] = await Promise.all([
        optional(() => listStaff(database, ctx)),
        optional(() => getLeaveOverview(database, ctx)),
      ]);
      const countBy = <T>(rows: T[], key: (r: T) => string) =>
        rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [key(r)]: (acc[key(r)] ?? 0) + 1 }), {});
      return {
        staff:
          isShown(staff) && staff
            ? {
                inPost: staff.length,
                byDepartment: countBy(staff, (s) => s.department ?? "No department"),
                byEmploymentType: countBy(staff, (s) => s.employmentType),
              }
            : NOT_SHOWN,
        leave:
          isShown(leave) && leave
            ? {
                waitingForDecision: leave.waiting.map((l) => ({
                  staffName: l.staffName,
                  startsOn: l.startsOn,
                  endsOn: l.endsOn,
                  days: l.days,
                })),
                waitingByKind: countBy(leave.waiting, (l) => l.type),
                awayToday: leave.awayToday.map((l) => ({ staffName: l.staffName, until: l.endsOn })),
              }
            : NOT_SHOWN,
      };
    },
  },
  transport: {
    source: { label: "Transport", path: "transport" },
    definition: {
      name: "transport",
      description: "School bus routes: each route's stops, riders this term, fare and vehicle, with totals.",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const routes = (await listRoutes(database, ctx)).filter((r) => r.status === "active");
      return {
        routes: routes.map((r) => ({
          route: r.name,
          stops: r.stops,
          riders: r.riders,
          fare: money(ctx, r.farePesewas),
          vehicle: r.vehicle,
        })),
        totalRiders: routes.reduce((n, r) => n + r.riders, 0),
      };
    },
  },
  inventory: {
    source: { label: "Inventory", path: "inventory" },
    definition: {
      name: "inventory",
      description:
        "Stock items at or below their reorder level, assets by condition, repairs open (with priority), and purchase requests waiting for a decision (with their totals).",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const [stock, assets, repairs, purchases] = await Promise.all([
        optional(() => listStockItems(database, ctx)),
        optional(() => listAssets(database, ctx)),
        optional(() => listMaintenance(database, ctx)),
        optional(() => listPurchaseRequests(database, ctx)),
      ]);
      return {
        lowStock:
          isShown(stock) && stock
            ? stock
                .filter((s) => s.status === "active" && s.low)
                .map((s) => ({ item: s.name, onHand: s.onHand, reorderLevel: s.reorderLevel, unit: s.unit }))
            : NOT_SHOWN,
        assetsByCondition:
          isShown(assets) && assets
            ? assets.reduce<Record<string, number>>(
                (acc, a) => ({ ...acc, [a.condition]: (acc[a.condition] ?? 0) + 1 }),
                {},
              )
            : NOT_SHOWN,
        repairsOpen:
          isShown(repairs) && repairs
            ? repairs
                .filter((r) => r.status === "open" || r.status === "in_progress")
                .map((r) => ({
                  reference: r.reference,
                  title: r.title,
                  priority: r.priority,
                  status: r.status,
                }))
            : NOT_SHOWN,
        purchasesWaiting:
          isShown(purchases) && purchases
            ? purchases
                .filter((p) => p.status === "pending")
                .map((p) => ({ reference: p.reference, title: p.title, total: money(ctx, p.totalMinor) }))
            : NOT_SHOWN,
      };
    },
  },
  library: {
    source: { label: "Library", path: "library" },
    definition: {
      name: "library",
      description:
        "The library: titles and copies, books out on loan, holds waiting, and loans overdue (title, borrower, class and days late, most overdue first, at most 30).",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const [titles, loans] = await Promise.all([listTitles(database, ctx), listOpenLoans(database, ctx)]);
      const active = titles.filter((x) => x.status === "active");
      const overdue = loans.filter((l) => l.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate);
      return {
        titles: active.length,
        copies: active.reduce((n, x) => n + x.copies, 0),
        onLoan: loans.length,
        holdsWaiting: active.reduce((n, x) => n + x.waiting, 0),
        overdueLoans: overdue.length,
        mostOverdue: overdue.slice(0, 30).map((l) => ({
          title: l.title,
          borrower: l.borrower,
          class: l.className,
          daysLate: l.daysLate,
        })),
      };
    },
  },
  boarding: {
    source: { label: "Boarding", path: "boarding" },
    definition: {
      name: "boarding",
      description:
        "Boarding houses: beds, boarders and boarders out on exeat in each, and boarders out now (house, when they are due back and days overdue). Reasons for exeats and who collected a boarder are never given.",
      input_schema: schema({}),
      strict: true,
    },
    run: async (database, ctx) => {
      const [houses, exeats] = await Promise.all([listHouses(database, ctx), listExeats(database, ctx)]);
      return {
        houses: houses
          .filter((h) => h.status === "active")
          .map((h) => ({
            house: h.name,
            kind: h.kind,
            beds: h.beds,
            boarders: h.boarders,
            outOnExeat: h.out,
          })),
        outNow: exeats.out.map((e) => ({
          student: e.student,
          house: e.house,
          dueBackOn: e.expectedBackOn,
          daysOverdue: e.overdueDays,
        })),
        overdueBack: exeats.out.filter((e) => e.overdueDays > 0).length,
      };
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
