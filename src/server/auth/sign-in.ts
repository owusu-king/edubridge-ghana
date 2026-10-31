import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone";
import type { Database } from "../db/client";
import { loginAttempts, users } from "../db/schema";
import { getDummyHash, PASSWORD_MAX_LENGTH, verifyPassword } from "./password";
import { createChallenge, hasMfa } from "./mfa";
import { createSession, type ClientInfo } from "./sessions";

/** An email address or a phone number (local Ghanaian or international format). */
export const identifierSchema = z
  .string()
  .trim()
  .max(254)
  .transform((value, ctx) => {
    if (value.includes("@")) {
      const email = z.string().email().safeParse(value.toLowerCase());
      if (email.success) return { kind: "email" as const, value: email.data };
    } else {
      const phone = normalizePhone(value);
      if (phone) return { kind: "phone" as const, value: phone };
    }
    ctx.addIssue({ code: "custom", message: "Enter a valid email address or phone number." });
    return z.NEVER;
  });

export const signInSchema = z.preprocess(
  // `email` is accepted as an alias of `identifier` for API clients.
  (v) =>
    v && typeof v === "object" && !("identifier" in v)
      ? { ...v, identifier: (v as { email?: unknown }).email }
      : v,
  z.object({
    identifier: identifierSchema,
    password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
  }),
);
export type SignInInput = z.input<typeof signInSchema>;

export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 50;

export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; userId: string }
  /** Password accepted; the second step must be completed with this challenge. */
  | { ok: "mfa"; challengeToken: string; expiresAt: Date }
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
  const { identifier, password } = signInSchema.parse(input);
  // Phone sign-in only works with a verified number (numbers are stored only once verified).
  const [user] = await database
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash, status: users.status })
    .from(users)
    .where(
      identifier.kind === "email" ? eq(users.email, identifier.value) : eq(users.phone, identifier.value),
    )
    .limit(1);
  // Failures are counted per account (its email) whichever identifier was used, otherwise per identifier.
  const throttleKey = user?.email ?? identifier.value;
  if (await isThrottled(database, throttleKey, ip, now)) return { ok: false, reason: "throttled" };

  const hash = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(password, hash);

  if (!user || !user.passwordHash || !passwordOk || user.status !== "active") {
    await database.insert(loginAttempts).values({ email: throttleKey, ipAddress: ip, attemptedAt: now });
    return { ok: false, reason: "invalid_credentials" };
  }

  if (await hasMfa(database, user.id)) {
    // Failures are only cleared after the second step succeeds.
    const challenge = await createChallenge(database, user.id, now);
    return { ok: "mfa", challengeToken: challenge.token, expiresAt: challenge.expiresAt };
  }
  await database.delete(loginAttempts).where(eq(loginAttempts.email, user.email));
  await database.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  const session = await createSession(database, user.id, client, now);
  return { ok: true, userId: user.id, ...session };
}
