import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { loginAttempts, users } from "../db/schema";
import { getDummyHash, PASSWORD_MAX_LENGTH, verifyPassword } from "./password";
import { createSession, type ClientInfo } from "./sessions";

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 50;

export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; userId: string }
  | { ok: false; reason: "invalid_credentials" | "throttled" };

async function isThrottled(
  database: Database,
  email: string,
  ip: string | null,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - THROTTLE_WINDOW_MS);
  const [byEmail] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.attemptedAt, since)));
  if ((byEmail?.n ?? 0) >= MAX_FAILURES_PER_EMAIL) return true;
  if (!ip) return false;
  const [byIp] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ipAddress, ip), gt(loginAttempts.attemptedAt, since)));
  return (byIp?.n ?? 0) >= MAX_FAILURES_PER_IP;
}

/**
 * Verifies credentials and creates a session. Responses never reveal whether an email exists:
 * unknown users take the same code path (dummy hash) and return the same error.
 */
export async function signIn(
  database: Database,
  input: SignInInput,
  client: ClientInfo = {},
  now = new Date(),
): Promise<SignInResult> {
  const ip = client.ipAddress ?? null;
  if (await isThrottled(database, input.email, ip, now)) return { ok: false, reason: "throttled" };

  const [user] = await database
    .select({ id: users.id, passwordHash: users.passwordHash, status: users.status })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  const hash = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(input.password, hash);

  if (!user || !user.passwordHash || !passwordOk || user.status !== "active") {
    await database.insert(loginAttempts).values({ email: input.email, ipAddress: ip, attemptedAt: now });
    return { ok: false, reason: "invalid_credentials" };
  }

  await database.delete(loginAttempts).where(eq(loginAttempts.email, input.email));
  await database.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  const session = await createSession(database, user.id, client, now);
  return { ok: true, userId: user.id, ...session };
}
