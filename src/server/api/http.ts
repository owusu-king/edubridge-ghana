import "server-only";
import { ZodError } from "zod";
import { validateDeviceToken } from "../auth/device-tokens";
import { validateSessionToken, type SessionUser } from "../auth/sessions";
import { ForbiddenError } from "../authz/permissions";
import type { Database } from "../db/client";
import { DomainError } from "../errors";
import { NotPlatformAdminError } from "../platform/service";

/**
 * HTTP plumbing for `/api/v1`, on the web-standard Request and Response (no framework), so the same
 * handlers run under Next.js and in tests. Errors use one format: `{ error: { code, message, fields? } }`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function apiError(status: number, code: string, message: string, fields?: Record<string, string>) {
  return Response.json(
    { error: { code, message, ...(fields ? { fields } : {}) } },
    { status, headers: NO_STORE },
  );
}

/** Expected failures become 4xx answers; anything else is re-thrown (a 500, logged by the host). */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return apiError(error.status, error.code, error.message, error.fields);
  if (error instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "_";
      if (!fields[key]) fields[key] = issue.message;
    }
    return apiError(422, "invalid_input", "Some fields are not valid.", fields);
  }
  if (error instanceof DomainError)
    return apiError(
      409,
      error.code,
      error.message,
      error.field ? { [error.field]: error.message } : undefined,
    );
  if (error instanceof ForbiddenError || error instanceof NotPlatformAdminError)
    return apiError(403, "forbidden", "You do not have permission to do this.");
  throw error;
}

/** Request bodies are small JSON documents; sync batches are the largest. */
export const MAX_BODY_BYTES = 1024 * 1024;

export async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new ApiError(413, "too_large", "The request is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > max) throw new ApiError(413, "too_large", "The request is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export interface ApiCaller {
  user: SessionUser;
  /** The device token used (bearer), or null for the web session cookie. */
  tokenId: string | null;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Bearer device tokens for every method. The web session cookie (passed in by the host) only for safe
 * methods: browsers attach cookies to cross-site requests, so cookie-authenticated writes would be open
 * to CSRF. Web session tokens are never accepted as bearer tokens.
 */
export async function authenticate(
  database: Database,
  request: Request,
  cookieToken?: string | null,
): Promise<ApiCaller | null> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    const found = await validateDeviceToken(database, bearer);
    return found ? { user: found.user, tokenId: found.tokenId } : null;
  }
  if (cookieToken && SAFE_METHODS.has(request.method)) {
    const session = await validateSessionToken(database, cookieToken);
    return session ? { user: session.user, tokenId: null } : null;
  }
  return null;
}

/** Client details for sign-in records, from proxy headers (trustworthy only behind a proxy that sets them). */
export function clientOf(request: Request): { ipAddress: string | null; userAgent: string | null } {
  const forwarded =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "";
  const ip = /^[0-9a-f.:]{3,45}$/i.test(forwarded) ? forwarded : null;
  return { ipAddress: ip, userAgent: request.headers.get("user-agent") };
}
