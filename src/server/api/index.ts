import "server-only";
import type { Database } from "../db/client";
import { dispatch, type ApiDeps, type ApiRoute } from "./router";
import { authRoutes } from "./routes/auth";
import { intelligenceRoutes } from "./routes/intelligence";
import { passportRoutes } from "./routes/passport";
import { schoolRoutes } from "./routes/schools";
import { syncRoutes } from "./routes/sync";

const indexRoute: ApiRoute = {
  method: "GET",
  path: "/",
  summary: "This list of routes.",
  auth: "public",
  handler: async () => ({
    version: "v1",
    authentication:
      "Send `Authorization: Bearer <device token>` (from POST /auth/token). Errors: { error: { code, message, fields? } }.",
    routes: API_ROUTES.map((r) => ({
      method: r.method,
      path: `/api/v1${r.path === "/" ? "" : r.path}`,
      auth: r.auth,
      summary: r.summary,
    })),
  }),
};

export const API_ROUTES: readonly ApiRoute[] = [
  indexRoute,
  ...authRoutes,
  ...schoolRoutes,
  ...syncRoutes,
  ...passportRoutes,
  ...intelligenceRoutes,
];

/** Answers a `/api/v1` request (the Next.js catch-all route and tests call this). */
export function handleApiRequest(
  database: Database,
  request: Request,
  options: { cookieToken?: string | null; deps?: ApiDeps } = {},
): Promise<Response> {
  return dispatch(API_ROUTES, database, request, options);
}
