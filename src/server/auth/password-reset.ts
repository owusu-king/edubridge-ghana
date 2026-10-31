import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { loginAttempts, passwordResets, sessions, users } from "../db/schema";
import { DomainError } from "../errors";
import { enqueue } from "../notifications/outbox";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";
import { identifierSchema } from "./sign-in";
import type { ClientInfo } from "./sessions";
import { generateToken, hashToken } from "./tokens";

export const RESET_LIFETIME_MINUTES = 30;
const MAX_REQUESTS_PER_USER_PER_HOUR = 3;
/** Per-IP limit; overridable for shared test environments where every request comes from one address. */
const maxRequestsPerIpPerHour = () => Number(process.env.PASSWORD_RESET_LIMIT_PER_IP_HOUR ?? 20);

export const resetRequestSchema = z.preprocess(
  (v) =>
    v && typeof v === "object" && !("identifier" in v) ? { identifier: (v as { email?: unknown }).email } : v,
  z.object({ identifier: identifierSchema }),
);

export const newPasswordSchema = z.object({
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`),
});

/**
 * Starts a password reset. The response never reveals whether the email has an account. Requests are
 * limited per account and per IP address so the flow cannot be used to flood someone's inbox.
 */
export async function requestPasswordReset(
  database: Database,
  input: unknown,
  client: ClientInfo = {},
  now = new Date(),
): Promise<void> {
  const { identifier } = resetRequestSchema.parse(input);
  const [user] = await database
    .select({ id: users.id, name: users.name, email: users.email, phone: users.phone, status: users.status })
    .from(users)
    .where(
      identifier.kind === "email" ? eq(users.email, identifier.value) : eq(users.phone, identifier.value),
    )
    .limit(1);
  if (!user || user.status !== "active") return;

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [byUser] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(passwordResets)
    .where(and(eq(passwordResets.userId, user.id), gt(passwordResets.createdAt, hourAgo)));
  if ((byUser?.n ?? 0) >= MAX_REQUESTS_PER_USER_PER_HOUR) return;
  if (client.ipAddress) {
    const [byIp] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(passwordResets)
      .where(and(eq(passwordResets.requestedIp, client.ipAddress), gt(passwordResets.createdAt, hourAgo)));
    if ((byIp?.n ?? 0) >= maxRequestsPerIpPerHour()) return;
  }

  const token = generateToken();
  await database.transaction(async (tx) => {
    await tx.insert(passwordResets).values({
      id: hashToken(token),
      userId: user.id,
      expiresAt: new Date(now.getTime() + RESET_LIFETIME_MINUTES * 60_000),
      requestedIp: client.ipAddress ?? null,
      createdAt: now,
    });
    // Reply on the channel the person used: a phone request gets an SMS, an email request an email.
    if (identifier.kind === "phone" && user.phone) {
      await enqueue(tx, {
        channel: "sms",
        recipient: user.phone,
        template: "password_reset_sms",
        payload: { token, expiresMinutes: RESET_LIFETIME_MINUTES },
      });
    } else {
      await enqueue(tx, {
        channel: "email",
        recipient: user.email,
        template: "password_reset",
        payload: { name: user.name, token, expiresMinutes: RESET_LIFETIME_MINUTES },
      });
    }
  });
}

/** Whether a reset link is still usable (for showing the form or an "expired" message). */
export async function isResetTokenValid(
  database: Database,
  token: string,
  now = new Date(),
): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const [row] = await database
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.id, hashToken(token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, now),
      ),
    );
  return Boolean(row);
}

/**
 * Sets a new password with a valid token: the token and any other pending tokens are consumed, every
 * session is signed out, and sign-in throttling is cleared. Two-step verification still applies at sign-in.
 */
export async function resetPassword(
  database: Database,
  token: string,
  input: unknown,
  now = new Date(),
): Promise<void> {
  const { password } = newPasswordSchema.parse(input);
  const passwordHash = await hashPassword(password);
  await database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResets.id, hashToken(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResets.userId });
    if (!claimed)
      throw new DomainError("reset_invalid", "This reset link is invalid or has expired. Request a new one.");
    const [user] = await tx
      .update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, claimed.userId))
      .returning({ email: users.email });
    await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.userId, claimed.userId), isNull(passwordResets.usedAt)));
    await tx.delete(sessions).where(eq(sessions.userId, claimed.userId));
    if (user) await tx.delete(loginAttempts).where(eq(loginAttempts.email, user.email));
  });
}
