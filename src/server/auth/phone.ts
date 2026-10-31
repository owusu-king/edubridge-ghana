import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { phoneVerifications, users } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { enqueue } from "../notifications/outbox";
import { normalizePhone } from "@/lib/phone";
import { hashToken } from "./tokens";

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CODES_PER_HOUR = 3;
const MAX_ATTEMPTS = 5;

const codeHash = (verificationId: string, code: string) => hashToken(`${verificationId}:${code}`);

/** Sends a 6-digit code by SMS to prove the user owns the number. The number is attached only once confirmed. */
export async function startPhoneVerification(
  database: Database,
  userId: string,
  rawPhone: string,
  now = new Date(),
): Promise<{ verificationId: string; phone: string }> {
  const phone = normalizePhone(String(rawPhone ?? ""));
  if (!phone)
    throw new DomainError("phone_invalid", "Enter a valid mobile number, e.g. 024 123 4567.", "phone");

  const [owner] = await database.select({ id: users.id }).from(users).where(eq(users.phone, phone));
  if (owner && owner.id !== userId) {
    throw new DomainError("phone_taken", "This number is linked to another account.", "phone");
  }
  if (owner?.id === userId) throw new DomainError("phone_same", "This is already your number.", "phone");

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [recent] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(phoneVerifications)
    .where(and(eq(phoneVerifications.userId, userId), gt(phoneVerifications.createdAt, hourAgo)));
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) {
    throw new DomainError("phone_rate_limited", "Too many codes requested. Try again in an hour.");
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  return database.transaction(async (tx) => {
    const id = randomUUID();
    await tx.insert(phoneVerifications).values({
      id,
      userId,
      phone,
      codeHash: codeHash(id, code),
      expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      createdAt: now,
    });
    await enqueue(tx, { channel: "sms", recipient: phone, template: "phone_code", payload: { code } });
    return { verificationId: id, phone };
  });
}

export async function confirmPhoneVerification(
  database: Database,
  userId: string,
  verificationId: string,
  code: string,
  now = new Date(),
): Promise<string> {
  const invalid = new DomainError("phone_code_invalid", "That code is not valid or has expired.", "code");
  if (!/^[0-9a-f-]{36}$/.test(verificationId)) throw invalid;
  const [attempt] = await database
    .update(phoneVerifications)
    .set({ attempts: sql`${phoneVerifications.attempts} + 1` })
    .where(
      and(
        eq(phoneVerifications.id, verificationId),
        eq(phoneVerifications.userId, userId),
        isNull(phoneVerifications.consumedAt),
        gt(phoneVerifications.expiresAt, now),
        lt(phoneVerifications.attempts, MAX_ATTEMPTS),
      ),
    )
    .returning();
  if (!attempt || attempt.codeHash !== codeHash(attempt.id, code.replace(/\s+/g, ""))) throw invalid;

  try {
    await database.transaction(async (tx) => {
      await tx
        .update(phoneVerifications)
        .set({ consumedAt: now })
        .where(eq(phoneVerifications.id, attempt.id));
      await tx
        .update(users)
        .set({ phone: attempt.phone, phoneVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, userId));
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DomainError("phone_taken", "This number is linked to another account.", "phone");
    }
    throw error;
  }
  return attempt.phone;
}

export async function removePhone(database: Database, userId: string): Promise<void> {
  await database
    .update(users)
    .set({ phone: null, phoneVerifiedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function getVerifiedPhone(database: Database, userId: string): Promise<string | null> {
  const [row] = await database.select({ phone: users.phone }).from(users).where(eq(users.id, userId));
  return row?.phone ?? null;
}
