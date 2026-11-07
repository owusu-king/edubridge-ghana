import "server-only";
import type { AssistantModel } from "../../assistant/model";
import { askAssistant, listAssistantQueries } from "../../assistant/service";
import {
  getAttendanceInsights,
  getFinanceInsights,
  getLevelPerformance,
  getOperationsInsights,
  getStudentTrends,
  getTermTrends,
} from "../../insights/service";
import { readJson } from "../http";
import type { ApiRoute } from "../router";

/** Insights and the school assistant over HTTP. */
export const intelligenceRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/schools/:school/insights",
    summary:
      "Term-by-term trends, students to follow up, results by level, attendance, money and outstanding work.",
    auth: "school",
    handler: async ({ database, ctx }) => {
      const [terms, students, levels, attendance, money, work] = await Promise.all([
        getTermTrends(database, ctx),
        getStudentTrends(database, ctx),
        getLevelPerformance(database, ctx),
        getAttendanceInsights(database, ctx),
        getFinanceInsights(database, ctx),
        getOperationsInsights(database, ctx),
      ]);
      return { terms, students, levels, attendance, money, work };
    },
  },
  {
    method: "POST",
    path: "/schools/:school/assistant",
    summary:
      "Ask the school assistant a question: { question }. Answers come only from records the caller may see.",
    auth: "school",
    handler: async ({ database, ctx, request, deps }) =>
      askAssistant(
        database,
        ctx,
        await readJson(request, 8 * 1024),
        (deps.assistantModel as AssistantModel) ?? null,
      ),
  },
  {
    method: "GET",
    path: "/schools/:school/assistant/history",
    summary:
      "Recent questions: the caller's own, or everyone's (?everyone=1) for those who see the audit log.",
    auth: "school",
    handler: async ({ database, ctx, url }) => ({
      questions: await listAssistantQueries(database, ctx, {
        everyone: url.searchParams.get("everyone") === "1",
      }),
    }),
  },
];
