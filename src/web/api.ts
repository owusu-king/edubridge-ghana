import "server-only";
import { cookies } from "next/headers";
import { validateSessionToken, type SessionUser } from "@/server/auth/sessions";
import { db } from "@/server/db/client";
import { SESSION_COOKIE } from "./session-cookie";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Authenticates a /api/v1 request. Mobile clients send `Authorization: Bearer <token>`.
 * The web session cookie is accepted only for safe methods: browsers attach cookies to cross-site
 * requests, so cookie-authenticated writes would be open to CSRF.
 */
export async function authenticateApiRequest(request: Request): Promise<SessionUser | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const cookie = SAFE_METHODS.has(request.method) ? (await cookies()).get(SESSION_COOKIE)?.value : undefined;
  const token = bearer ?? cookie;
  if (!token) return null;
  return (await validateSessionToken(db(), token))?.user ?? null;
}

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
