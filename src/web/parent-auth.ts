import "server-only";
import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/server/db/client";
import {
  PARENT_SESSION_LIFETIME_MS,
  revokeParentSession,
  validateParentSession,
  type ParentSession,
} from "@/server/parents/sessions";
import { safeRedirectPath } from "@/lib/format";
import { PARENT_COOKIE, sessionCookieOptions } from "./session-cookie";

/**
 * Next.js adapter for parent sign-in (src/server/parents). Parents are identified by a verified phone
 * number; what they may see is decided by the server modules on every request.
 */

export async function setParentSessionCookie(token: string): Promise<void> {
  (await cookies()).set(PARENT_COOKIE, token, sessionCookieOptions(PARENT_SESSION_LIFETIME_MS));
}

export const getParentSession = cache(async (): Promise<ParentSession | null> => {
  const token = (await cookies()).get(PARENT_COOKIE)?.value;
  if (!token) return null;
  return validateParentSession(db(), token);
});

export async function requireParent(): Promise<ParentSession> {
  const session = await getParentSession();
  if (!session) redirect("/p/login" as Route);
  return session;
}

export async function signOutParent(): Promise<void> {
  const store = await cookies();
  const token = store.get(PARENT_COOKIE)?.value;
  if (token) await revokeParentSession(db(), token);
  store.delete(PARENT_COOKIE);
}

/** Where to go after signing in: only within the parent area. */
export function parentNext(value: unknown): string {
  const path = safeRedirectPath(value, "/p");
  return path === "/p" || path.startsWith("/p/") ? path : "/p";
}
