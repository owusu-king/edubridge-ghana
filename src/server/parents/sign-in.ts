import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { normalizePhone } from "@/lib/phone";
import { hashToken } from "../auth/tokens";
import type { ClientInfo } from "../auth/sessions";
import type { Database } from "../db/client";
import { parentSignInCodes } from "../db/schema";
import { DomainError } from "../errors";
import { enqueue } from "../notifications/outbox";
import { createParentSession } from "./sessions";
import { recordParentCodeUsage } from "../billing/usage";
import { schoolsForPhone } from "./schools";

/**
 * Parents sign in with a 6-digit code sent by SMS to a number a school has on file for them (D-02, D-04:
 * no passwords, no self-claimed children). Codes cost the school an SMS, so requests are limited per
 * number, per network address and per school, and unknown numbers are never sent anything. The response
 * is the same whether or not the number is known, so the form does not reveal who is a parent where.
 */

export const CODE_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

export interface CodeLimits {
  /** Codes per number in 15 minutes, and in 24 hours. */
  perPhone15Min: number;
  perPhoneDay: number;
  /** Codes per network address in an hour. Generous: Ghanaian mobile networks share addresses widely. */
  perIpHour: number;
  /** SMS codes sent to one school's parents in an hour, protecting the school's SMS spend. */
  perSchoolHour: number;
}

export const CODE_LIMITS: CodeLimits = {
  perPhone15Min: 3,
  perPhoneDay: 10,
  perIpHour: 30,
  perSchoolHour: 300,
};

const codeHash = (requestId: string, code: string) => hashToken(`parent:${requestId}:${code}`);

const throttled = () =>
  new DomainError("parent_code_throttled", "Too many codes have been asked for. Try again later.");

/** Sends a sign-in code if the number is on file at a school. Returns the request to verify against. */
export async function requestParentCode(
  database: Database,
  rawPhone: unknown,
  client: ClientInfo = {},
  now = new Date(),
  limits: CodeLimits = CODE_LIMITS,
): Promise<{ requestId: string; phone: string }> {
  const phone = normalizePhone(String(rawPhone ?? "").slice(0, 32));
  if (!phone)
    throw new DomainError("phone_invalid", "Enter a valid mobile number, e.g. 024 123 4567.", "phone");
  const ip = client.ipAddress ?? null;
  const schools = await schoolsForPhone(database, phone);
  const tenantIds = schools.map((s) => s.id);

  return database.transaction(async (tx) => {
    // One request per number at a time, so concurrent requests cannot slip past the limits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`parent-code:${phone}`}))`);
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const [byPhone] = await tx
      .select({
        last15: sql<number>`count(*) filter (where ${parentSignInCodes.createdAt} > ${minutesAgo(15)})::int`,
        lastDay: sql<number>`count(*)::int`,
      })
      .from(parentSignInCodes)
      .where(and(eq(parentSignInCodes.phone, phone), gt(parentSignInCodes.createdAt, minutesAgo(24 * 60))));
    if (byPhone!.last15 >= limits.perPhone15Min || byPhone!.lastDay >= limits.perPhoneDay) throw throttled();
    if (ip) {
      const [byIp] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(parentSignInCodes)
        .where(
          and(
            sql`${parentSignInCodes.ipAddress} = ${ip}::inet`,
            gt(parentSignInCodes.createdAt, minutesAgo(60)),
          ),
        );
      if (byIp!.n >= limits.perIpHour) throw throttled();
    }
    if (tenantIds.length > 0) {
      const busy = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from ${parentSignInCodes}, unnest(${parentSignInCodes.tenantIds}) as school
        where ${parentSignInCodes.createdAt} > ${minutesAgo(60)}
          and school in (${sql.join(
            tenantIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        group by school
        having count(*) >= ${limits.perSchoolHour}`);
      if (busy.rows.length > 0) throw throttled();
    }

    const requestId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await tx.insert(parentSignInCodes).values({
      id: requestId,
      phone,
      codeHash: codeHash(requestId, code),
      tenantIds,
      expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      ipAddress: ip,
      createdAt: now,
    });
    // Unknown numbers get no SMS (and so cost nothing), but the same response.
    if (tenantIds.length > 0) {
      const outboxId = await enqueue(tx, {
        channel: "sms",
        recipient: phone,
        template: "phone_code",
        payload: { code },
      });
      // Each school with the number pays for the code (billing records; shared codes are marked as such).
      await recordParentCodeUsage(tx, outboxId, tenantIds);
    }
    return { requestId, phone };
  });
}

/** Checks a code and starts a 30-day parent session. Each code works once, within 10 minutes and 5 tries. */
export async function verifyParentCode(
  database: Database,
  requestId: string,
  rawCode: unknown,
  client: ClientInfo = {},
  now = new Date(),
): Promise<{ token: string; expiresAt: Date; phone: string }> {
  const invalid = new DomainError("parent_code_invalid", "That code is not right, or has expired.", "code");
  const code = String(rawCode ?? "").replace(/\s+/g, "");
  if (!/^[0-9a-f-]{36}$/.test(requestId) || !/^\d{6}$/.test(code)) throw invalid;
  const [attempt] = await database
    .update(parentSignInCodes)
    .set({ attempts: sql`${parentSignInCodes.attempts} + 1` })
    .where(
      and(
        eq(parentSignInCodes.id, requestId),
        isNull(parentSignInCodes.consumedAt),
        gt(parentSignInCodes.expiresAt, now),
        lt(parentSignInCodes.attempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .returning();
  // A number no school had on file was never sent a code, so nothing can match it.
  if (!attempt || attempt.tenantIds.length === 0 || attempt.codeHash !== codeHash(attempt.id, code))
    throw invalid;
  const [consumed] = await database
    .update(parentSignInCodes)
    .set({ consumedAt: now })
    .where(and(eq(parentSignInCodes.id, attempt.id), isNull(parentSignInCodes.consumedAt)))
    .returning({ id: parentSignInCodes.id });
  if (!consumed) throw invalid;
  const session = await createParentSession(database, attempt.phone, client, now);
  return { ...session, phone: attempt.phone };
}

/** The number a pending code request was for, while it can still be used (to show where the code went). */
export async function pendingCodePhone(
  database: Database,
  requestId: string,
  now = new Date(),
): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) return null;
  const [row] = await database
    .select({ phone: parentSignInCodes.phone })
    .from(parentSignInCodes)
    .where(
      and(
        eq(parentSignInCodes.id, requestId),
        isNull(parentSignInCodes.consumedAt),
        gt(parentSignInCodes.expiresAt, now),
        lt(parentSignInCodes.attempts, MAX_CODE_ATTEMPTS),
      ),
    );
  return row?.phone ?? null;
}
