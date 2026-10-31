import "server-only";
import { cookies, headers } from "next/headers";
import { validateSessionToken, type SessionUser } from "@/server/auth/sessions";
import { db } from "@/server/db/client";
import { SESSION_COOKIE } from "./session-cookie";

/**
 * Authenticates a /api/v1 request. Mobile clients send `Authorization: Bearer <token>`;
 * the web app's cookie is also accepted so the same endpoints serve both.
 */
export async function authenticateApiRequest(): Promise<SessionUser | null> {
  const authorization = (await headers()).get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const token = bearer ?? (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return (await validateSessionToken(db(), token))?.user ?? null;
}

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
