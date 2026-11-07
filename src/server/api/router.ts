import "server-only";
import { hasMfa } from "../auth/mfa";
import type { Database } from "../db/client";
import { recordSupportView } from "../support/access";
import { resolveTenantContext, type TenantContext } from "../tenancy/service";
import { ApiError, apiError, authenticate, errorResponse, json, type ApiCaller } from "./http";

/**
 * `/api/v1`: a small router over the existing services. Handlers are thin: they parse the request, call
 * the same service functions as the web pages (which check permissions, plan features and campus scope
 * themselves) and shape the answer. School routes resolve the school exactly as the web does: the slug is
 * a hint, membership (or a live support grant) is checked, the school's two-step policy applies, and
 * support activity is recorded.
 */

export interface ApiDeps {
  /** Overrides for tests (e.g. the assistant's model). */
  [key: string]: unknown;
}

export interface RouteContext {
  database: Database;
  request: Request;
  url: URL;
  params: Record<string, string>;
  caller: ApiCaller | null;
  deps: ApiDeps;
}

export interface UserRouteContext extends RouteContext {
  caller: ApiCaller;
}

export interface SchoolRouteContext extends UserRouteContext {
  ctx: TenantContext;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Result = Response | object;

export type ApiRoute =
  | {
      method: Method;
      path: string;
      summary: string;
      auth: "public";
      handler: (c: RouteContext) => Promise<Result>;
    }
  | {
      method: Method;
      path: string;
      summary: string;
      auth: "user";
      handler: (c: UserRouteContext) => Promise<Result>;
    }
  | {
      method: Method;
      path: string;
      summary: string;
      auth: "school";
      handler: (c: SchoolRouteContext) => Promise<Result>;
    };

/** Matches "/schools/:school/students/:id" against a path, returning the named segments. */
function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) {
      try {
        params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
      } catch {
        return null;
      }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

export const API_PREFIX = "/api/v1";

export async function dispatch(
  routes: readonly ApiRoute[],
  database: Database,
  request: Request,
  options: { cookieToken?: string | null; deps?: ApiDeps } = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) return apiError(404, "not_found", "Not found.");
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const candidates = routes
    .map((r) => ({ route: r, params: match(r.path, path) }))
    .filter((c): c is { route: ApiRoute; params: Record<string, string> } => c.params !== null);
  if (candidates.length === 0) return apiError(404, "not_found", "Not found.");
  const found = candidates.find((c) => c.route.method === request.method);
  if (!found) return apiError(405, "method_not_allowed", "Method not allowed.");

  try {
    const base: RouteContext = {
      database,
      request,
      url,
      params: found.params,
      caller: null,
      deps: options.deps ?? {},
    };
    const { route } = found;
    let result: Result;
    if (route.auth === "public") {
      result = await route.handler(base);
    } else {
      const caller = await authenticate(database, request, options.cookieToken);
      if (!caller) return apiError(401, "unauthenticated", "Sign in to continue.");
      if (route.auth === "user") {
        result = await route.handler({ ...base, caller });
      } else {
        const ctx = await resolveTenantContext(database, found.params.school ?? "", caller.user.id);
        // Not found whether the school does not exist or the caller cannot use it (no disclosure).
        if (!ctx) return apiError(404, "not_found", "Not found.");
        if (ctx.mfaRequired && !(await hasMfa(database, caller.user.id)))
          return apiError(
            403,
            "mfa_required",
            "Turn on two-step verification for your account to use this school.",
          );
        if (ctx.support)
          await recordSupportView(database, ctx, url.pathname, request.method === "GET" ? "view" : "action");
        result = await route.handler({ ...base, caller, ctx });
      }
    }
    return result instanceof Response ? result : json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export const notFound = () => new ApiError(404, "not_found", "Not found.");
