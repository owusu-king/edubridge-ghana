import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Database, Queryable } from "../db/client";
import { loginAttempts, mfaChallenges, mfaRecoveryCodes, userMfa, users } from "../db/schema";
import { DomainError } from "../errors";
import { verifyPassword } from "./password";
import { open, seal } from "./secret-box";
import { createSession, type ClientInfo } from "./sessions";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "./totp";
import { generateToken, hashToken } from "./tokens";

export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export async function getMfaStatus(database: Queryable, userId: string): Promise<MfaStatus> {
  const [row] = await database
    .select({ enabledAt: userMfa.enabledAt })
    .from(userMfa)
    .where(eq(userMfa.userId, userId));
  if (!row?.enabledAt) return { enabled: false, recoveryCodesRemaining: 0 };
  const [codes] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
  return { enabled: true, recoveryCodesRemaining: codes?.n ?? 0 };
}

/** Starts (or restarts) enrolment: a new secret that becomes active only after a code is confirmed. */
export async function beginEnrollment(
  database: Database,
  user: { id: string; email: string },
): Promise<{ secret: string; uri: string }> {
  if ((await getMfaStatus(database, user.id)).enabled) {
    throw new DomainError("mfa_already_enabled", "Two-step verification is already on.");
  }
  const secret = generateTotpSecret();
  await database
    .insert(userMfa)
    .values({ userId: user.id, secretSealed: seal(secret) })
    .onConflictDoUpdate({
      target: userMfa.userId,
      set: { secretSealed: seal(secret), enabledAt: null, lastUsedStep: null },
    });
  return { secret, uri: otpauthUri(secret, user.email) };
}

function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

const normalizeRecovery = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

async function replaceRecoveryCodes(database: Queryable, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await database.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await database
    .insert(mfaRecoveryCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashToken(normalizeRecovery(code)) })));
  return codes;
}

/**
 * Accepts a TOTP code (never the same time step twice) or, if allowed, an unused recovery code.
 * The conditional UPDATE makes acceptance atomic under concurrency.
 */
async function consumeCode(
  database: Queryable,
  userId: string,
  code: string,
  opts: { allowRecovery: boolean; requireEnabled: boolean; now?: Date },
): Promise<"totp" | "recovery" | null> {
  const [row] = await database.select().from(userMfa).where(eq(userMfa.userId, userId));
  if (!row || (opts.requireEnabled && !row.enabledAt)) return null;
  const step = verifyTotp(open(row.secretSealed), code, opts.now);
  if (step !== null) {
    const updated = await database
      .update(userMfa)
      .set({ lastUsedStep: step })
      .where(
        and(eq(userMfa.userId, userId), or(isNull(userMfa.lastUsedStep), lt(userMfa.lastUsedStep, step))),
      )
      .returning({ userId: userMfa.userId });
    return updated.length > 0 ? "totp" : null;
  }
  if (opts.allowRecovery && normalizeRecovery(code).length === 10) {
    const used = await database
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaRecoveryCodes.userId, userId),
          eq(mfaRecoveryCodes.codeHash, hashToken(normalizeRecovery(code))),
          isNull(mfaRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: mfaRecoveryCodes.id });
    if (used.length > 0) return "recovery";
  }
  return null;
}

/** Confirms enrolment with a code from the app; returns recovery codes, shown once. */
export async function confirmEnrollment(database: Database, userId: string, code: string): Promise<string[]> {
  return database.transaction(async (tx) => {
    const accepted = await consumeCode(tx, userId, code, { allowRecovery: false, requireEnabled: false });
    if (!accepted)
      throw new DomainError(
        "mfa_code_invalid",
        "That code is not valid. Check your app and try again.",
        "code",
      );
    await tx.update(userMfa).set({ enabledAt: new Date() }).where(eq(userMfa.userId, userId));
    return replaceRecoveryCodes(tx, userId);
  });
}

export async function regenerateRecoveryCodes(
  database: Database,
  userId: string,
  code: string,
): Promise<string[]> {
  return database.transaction(async (tx) => {
    const accepted = await consumeCode(tx, userId, code, { allowRecovery: false, requireEnabled: true });
    if (!accepted) throw new DomainError("mfa_code_invalid", "That code is not valid.", "code");
    return replaceRecoveryCodes(tx, userId);
  });
}

export async function disableMfa(
  database: Database,
  userId: string,
  password: string,
  code: string,
): Promise<void> {
  const [user] = await database
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    throw new DomainError("password_invalid", "Your password is incorrect.", "password");
  }
  await database.transaction(async (tx) => {
    const accepted = await consumeCode(tx, userId, code, { allowRecovery: true, requireEnabled: true });
    if (!accepted) throw new DomainError("mfa_code_invalid", "That code is not valid.", "code");
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.delete(userMfa).where(eq(userMfa.userId, userId));
  });
}

export async function createChallenge(database: Database, userId: string, now = new Date()) {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS);
  await database
    .delete(mfaChallenges)
    .where(and(eq(mfaChallenges.userId, userId), lt(mfaChallenges.expiresAt, now)));
  await database.insert(mfaChallenges).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export type ChallengeResult =
  | { ok: true; userId: string; session: { token: string; expiresAt: Date } }
  | { ok: false; reason: "invalid_code" | "expired" };

/**
 * Completes a sign-in with the second step. Each challenge allows a few attempts, and each failure also
 * counts towards the account's sign-in throttle, so codes cannot be brute-forced by restarting sign-in.
 */
export async function verifyChallenge(
  database: Database,
  token: string,
  code: string,
  client: ClientInfo = {},
  now = new Date(),
): Promise<ChallengeResult> {
  if (!token || token.length > 128) return { ok: false, reason: "expired" };
  const id = hashToken(token);
  const [challenge] = await database
    .update(mfaChallenges)
    .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
    .where(
      and(
        eq(mfaChallenges.id, id),
        gt(mfaChallenges.expiresAt, now),
        lt(mfaChallenges.attempts, MAX_CHALLENGE_ATTEMPTS),
      ),
    )
    .returning({ userId: mfaChallenges.userId });
  if (!challenge) return { ok: false, reason: "expired" };

  const accepted = await consumeCode(database, challenge.userId, code, {
    allowRecovery: true,
    requireEnabled: true,
    now,
  });
  if (!accepted) {
    const [user] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, challenge.userId));
    if (user)
      await database
        .insert(loginAttempts)
        .values({ email: user.email, ipAddress: client.ipAddress ?? null, attemptedAt: now });
    return { ok: false, reason: "invalid_code" };
  }
  await database.delete(mfaChallenges).where(eq(mfaChallenges.id, id));
  const [owner] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, challenge.userId));
  if (owner) await database.delete(loginAttempts).where(eq(loginAttempts.email, owner.email));
  await database.update(users).set({ lastLoginAt: now }).where(eq(users.id, challenge.userId));
  const session = await createSession(database, challenge.userId, client, now);
  return { ok: true, userId: challenge.userId, session };
}

export async function hasMfa(database: Queryable, userId: string): Promise<boolean> {
  return (await getMfaStatus(database, userId)).enabled;
}
