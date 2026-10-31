import "server-only";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions, users } from "../db/schema";
import { SESSION_LIFETIME_MS } from "./policy";
import { generateSessionToken, sessionIdFromToken } from "./tokens";

export { SESSION_LIFETIME_MS };
/** Sessions are extended when less than this remains, so active users stay signed in. */
const RENEW_THRESHOLD_MS = SESSION_LIFETIME_MS / 2;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface ValidatedSession {
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
  /** True when the expiry was extended and the client cookie should be refreshed. */
  renewed: boolean;
}

export interface ClientInfo {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export async function createSession(
  database: Database,
  userId: string,
  client: ClientInfo = {},
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  await database.insert(sessions).values({
    id: sessionIdFromToken(token),
    userId,
    expiresAt,
    userAgent: client.userAgent?.slice(0, 512) ?? null,
    ipAddress: client.ipAddress ?? null,
  });
  return { token, expiresAt };
}

export async function validateSessionToken(
  database: Database,
  token: string,
  now = new Date(),
): Promise<ValidatedSession | null> {
  if (!token || token.length > 128) return null;
  const sessionId = sessionIdFromToken(token);
  const [row] = await database
    .select({
      expiresAt: sessions.expiresAt,
      user: { id: users.id, email: users.email, name: users.name },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now), eq(users.status, "active")))
    .limit(1);
  if (!row) return null;

  if (row.expiresAt.getTime() - now.getTime() < RENEW_THRESHOLD_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await database.update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId));
    return { sessionId, expiresAt, user: row.user, renewed: true };
  }
  return { sessionId, expiresAt: row.expiresAt, user: row.user, renewed: false };
}

export async function revokeSessionToken(database: Database, token: string): Promise<void> {
  await database.delete(sessions).where(eq(sessions.id, sessionIdFromToken(token)));
}

export async function revokeAllUserSessions(database: Database, userId: string): Promise<void> {
  await database.delete(sessions).where(eq(sessions.userId, userId));
}

export async function purgeExpiredSessions(database: Database, now = new Date()): Promise<number> {
  const result = await database.delete(sessions).where(lt(sessions.expiresAt, now));
  return result.rowCount ?? 0;
}

export async function countActiveSessions(database: Database, userId: string): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
  return row?.n ?? 0;
}
