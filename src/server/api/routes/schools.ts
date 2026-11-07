import "server-only";
import { z } from "zod";
import { getCurrentTerm } from "../../academics/calendar";
import { getScoreSheet, listAssessmentClasses } from "../../assessment/scores";
import { getRegister, listRegisters } from "../../attendance/registers";
import { allowed, PERMISSIONS } from "../../authz/permissions";
import { getStudent, listClassOptions, listStudents } from "../../students/service";
import { notFound, type ApiRoute } from "../router";

const listQuery = z.object({
  q: z.string().max(100).optional(),
  classId: z.string().uuid().optional(),
  status: z.enum(["active", "withdrawn", "graduated"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
});

/** Read routes over a school's records, through the same services (and checks) as the web pages. */
export const schoolRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/schools/:school",
    summary: "The school, the caller's roles and permissions there, the plan's modules and the current term.",
    auth: "school",
    handler: async ({ database, ctx }) => {
      const term = await getCurrentTerm(database, ctx);
      return {
        school: {
          slug: ctx.tenant.slug,
          name: ctx.tenant.name,
          timezone: ctx.tenant.timezone,
          currency: ctx.tenant.currencyCode,
          demo: ctx.tenant.isDemo,
        },
        roles: ctx.roles,
        permissions: PERMISSIONS.filter((p) => allowed(ctx, p)),
        features: ctx.features,
        campusIds: ctx.campusIds,
        support: ctx.support ? { expiresAt: ctx.support.expiresAt.toISOString() } : null,
        currentTerm: term
          ? {
              id: term.id,
              name: term.name,
              yearName: term.yearName,
              startsOn: term.startsOn,
              endsOn: term.endsOn,
            }
          : null,
      };
    },
  },
  {
    method: "GET",
    path: "/schools/:school/classes",
    summary: "Classes the caller can see.",
    auth: "school",
    handler: async ({ database, ctx }) => ({ classes: await listClassOptions(database, ctx) }),
  },
  {
    method: "GET",
    path: "/schools/:school/students",
    summary: "Students, 50 a page: search by name or admission number (q), class (classId) and status.",
    auth: "school",
    handler: async ({ database, ctx, url }) =>
      listStudents(database, ctx, listQuery.parse(Object.fromEntries(url.searchParams))),
  },
  {
    method: "GET",
    path: "/schools/:school/students/:id",
    summary: "One student, with classes by term and guardians.",
    auth: "school",
    handler: async ({ database, ctx, params }) => {
      if (!z.string().uuid().safeParse(params.id).success) throw notFound();
      return (await getStudent(database, ctx, params.id!)) ?? Promise.reject(notFound());
    },
  },
  {
    method: "GET",
    path: "/schools/:school/attendance/:date",
    summary: "Registers for a school day (YYYY-MM-DD): the caller's classes and whether each is taken.",
    auth: "school",
    handler: async ({ database, ctx, params }) => listRegisters(database, ctx, params.date!),
  },
  {
    method: "GET",
    path: "/schools/:school/attendance/:date/:classId",
    summary: "One class register with each mark's version (send changes through /sync).",
    auth: "school",
    handler: async ({ database, ctx, params }) => {
      if (!z.string().uuid().safeParse(params.classId).success) throw notFound();
      return (await getRegister(database, ctx, params.classId!, params.date!)) ?? Promise.reject(notFound());
    },
  },
  {
    method: "GET",
    path: "/schools/:school/assessment/:termId",
    summary: "Classes the caller enters marks for in a term, with progress.",
    auth: "school",
    handler: async ({ database, ctx, params }) => {
      if (!z.string().uuid().safeParse(params.termId).success) throw notFound();
      return (await listAssessmentClasses(database, ctx, params.termId!)) ?? Promise.reject(notFound());
    },
  },
  {
    method: "GET",
    path: "/schools/:school/assessment/:termId/:classId/:subjectId",
    summary: "A score sheet: each student's marks for a subject (send changes through /sync).",
    auth: "school",
    handler: async ({ database, ctx, params }) => {
      const ids = [params.termId, params.classId, params.subjectId];
      if (!ids.every((id) => z.string().uuid().safeParse(id).success)) throw notFound();
      return (
        (await getScoreSheet(database, ctx, params.termId!, params.classId!, params.subjectId!)) ??
        Promise.reject(notFound())
      );
    },
  },
];
