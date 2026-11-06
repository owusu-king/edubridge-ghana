import "server-only";
import { and, eq, gt, lt } from "drizzle-orm";
import type { ClientInfo } from "../auth/sessions";
import { generateSessionToken, sessionIdFromToken } from "../auth/tokens";
import type { Database } from "../db/client";
import { parentSessions, parentSignInCodes } from "../db/schema";
import { PARENT_SESSION_LIFETIME_MS } from "./policy";

export { PARENT_SESSION_LIFETIME_MS };
/** Renewed when less than half remains, so a parent who checks in monthly stays signed in. */
const RENEW_THRESHOLD_MS = PARENT_SESSION_LIFETIME_MS / 2;

export interface ParentSession {
  sessionId: string;
  /** The verified number (E.164). Which children it reaches is decided on each request. */
  phone: string;
  expiresAt: Date;
  renewed: boolean;
}

export async function createParentSession(
  database: Database,
  phone: string,
  client: ClientInfo = {},
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + PARENT_SESSION_LIFETIME_MS);
  await database.insert(parentSessions).values({
    id: sessionIdFromToken(token),
    phone,
    expiresAt,
    createdAt: now,
    userAgent: client.userAgent?.slice(0, 512) ?? null,
    ipAddress: client.ipAddress ?? null,
  });
  return { token, expiresAt };
}

export async function validateParentSession(
  database: Database,
  token: string,
  now = new Date(),
): Promise<ParentSession | null> {
  if (!token || token.length > 128) return null;
  const sessionId = sessionIdFromToken(token);
  const [row] = await database
    .select({ phone: parentSessions.phone, expiresAt: parentSessions.expiresAt })
    .from(parentSessions)
    .where(and(eq(parentSessions.id, sessionId), gt(parentSessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() - now.getTime() < RENEW_THRESHOLD_MS) {
    const expiresAt = new Date(now.getTime() + PARENT_SESSION_LIFETIME_MS);
    await database.update(parentSessions).set({ expiresAt }).where(eq(parentSessions.id, sessionId));
    return { sessionId, phone: row.phone, expiresAt, renewed: true };
  }
  return { sessionId, phone: row.phone, expiresAt: row.expiresAt, renewed: false };
}

export async function revokeParentSession(database: Database, token: string): Promise<void> {
  await database.delete(parentSessions).where(eq(parentSessions.id, sessionIdFromToken(token)));
}

/** Removes expired sessions and codes older than the longest rate-limit window. Run by the worker. */
export async function purgeParentSignIns(
  database: Database,
  now = new Date(),
): Promise<{ sessions: number; codes: number }> {
  const sessions = await database.delete(parentSessions).where(lt(parentSessions.expiresAt, now));
  const codes = await database
    .delete(parentSignInCodes)
    .where(lt(parentSignInCodes.createdAt, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)));
  return { sessions: sessions.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}
