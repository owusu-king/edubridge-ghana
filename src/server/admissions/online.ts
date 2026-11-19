import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { hashToken } from "../auth/tokens";
import type { ClientInfo } from "../auth/sessions";
import { readBillingState } from "../billing/state";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { applicationVerifications, levels, terms } from "../db/schema";
import { DomainError } from "../errors";
import { enqueue } from "../notifications/outbox";
import { moduleActive } from "../entitlements/service";
import { schoolBySlug } from "../parents/schools";
import { readPreferences } from "../tenancy/preferences";
import { insertApplication, parseApplicant } from "./service";
import { staffDevicesFor } from "../notifications/staff-push";

/**
 * Online applications (ADM-02): a public form per school, open only when the school turns it on and its
 * plan includes admissions. The parent's phone is confirmed by an SMS code before anything is saved as an
 * application, so the school only hears from families who can be reached. Each code is an SMS the school
 * pays for, so requests are limited per number, per network address and per school, and a hidden field
 * catches simple bots. The unconfirmed draft is kept at most 15 minutes and purged by the worker.
 */

export const VERIFICATION_LIFETIME_MS = 15 * 60_000;
export const MAX_VERIFICATION_ATTEMPTS = 5;

export const ONLINE_LIMITS = {
  /** Codes per number in 15 minutes and in a day. */
  perPhone15Min: 3,
  perPhoneDay: 6,
  /** Codes per network address in an hour (mobile networks share addresses, so not too low). */
  perIpHour: 20,
  /** Codes per school in an hour: the school's SMS spend. */
  perSchoolHour: 60,
};

const codeHash = (id: string, code: string) => hashToken(`application:${id}:${code}`);
const throttled = () =>
  new DomainError("application_throttled", "Too many codes have been asked for. Try again later.");

interface OpenSchool {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  countryCode: string;
  currencyCode: string;
}

/** The school, when it takes applications online now; otherwise null (the form says so). */
async function openSchool(database: Database, slug: string): Promise<OpenSchool | null> {
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  const open = await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    if (!(await moduleActive(tx, school.id, "admissions"))) return false;
    return (await readPreferences(tx, school.id)).onlineApplications;
  });
  return open ? school : null;
}

export interface OnlineForm {
  school: { name: string; slug: string; countryCode: string };
  levels: { id: string; name: string }[];
  terms: { id: string; name: string }[];
}

/** What the public form offers: the school's levels and the terms not yet over. */
export async function getOnlineApplicationForm(database: Database, slug: string): Promise<OnlineForm | null> {
  const school = await openSchool(database, slug);
  if (!school) return null;
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => ({
    school: { name: school.name, slug: school.slug, countryCode: school.countryCode },
    levels: await tx
      .select({ id: levels.id, name: levels.name })
      .from(levels)
      .where(and(eq(levels.tenantId, school.id), eq(levels.status, "active")))
      .orderBy(asc(levels.sequence)),
    terms: await tx
      .select({ id: terms.id, name: terms.name })
      .from(terms)
      .where(and(eq(terms.tenantId, school.id), sql`${terms.endsOn} >= ${todayIn(school.timezone)}`))
      .orderBy(asc(terms.startsOn)),
  }));
}

/**
 * Checks the form and texts a 6-digit code to the parent's phone. Returns the check to confirm against;
 * nothing is an application yet.
 */
export async function startOnlineApplication(
  database: Database,
  slug: string,
  input: unknown,
  client: ClientInfo = {},
  now = new Date(),
): Promise<{ verificationId: string }> {
  const school = await openSchool(database, slug);
  if (!school) throw new DomainError("applications_closed", "This school is not taking applications online.");
  const raw = (input ?? {}) as Record<string, unknown>;
  // A field people never see: bots fill it in.
  if (typeof raw.website === "string" && raw.website.trim() !== "")
    throw new DomainError("application_refused", "This application could not be sent.");
  const data = parseApplicant(raw, school.countryCode);
  const ip = client.ipAddress ?? null;
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    // One check at a time per school, so the limits below cannot be raced past.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`application-codes:${school.id}`}, 0))`,
    );
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const [counts] = await tx
      .select({
        phone15: sql<number>`count(*) filter (where ${applicationVerifications.phone} = ${data.phone} and ${applicationVerifications.createdAt} > ${ago(15 * 60_000)})::int`,
        phoneDay: sql<number>`count(*) filter (where ${applicationVerifications.phone} = ${data.phone})::int`,
        ipHour: ip
          ? sql<number>`count(*) filter (where ${applicationVerifications.ipAddress} = ${ip}::inet and ${applicationVerifications.createdAt} > ${ago(3_600_000)})::int`
          : sql<number>`0`,
        schoolHour: sql<number>`count(*) filter (where ${applicationVerifications.createdAt} > ${ago(3_600_000)})::int`,
      })
      .from(applicationVerifications)
      .where(
        and(
          eq(applicationVerifications.tenantId, school.id),
          gt(applicationVerifications.createdAt, ago(86_400_000)),
        ),
      );
    if (
      (counts?.phone15 ?? 0) >= ONLINE_LIMITS.perPhone15Min ||
      (counts?.phoneDay ?? 0) >= ONLINE_LIMITS.perPhoneDay ||
      (counts?.ipHour ?? 0) >= ONLINE_LIMITS.perIpHour ||
      (counts?.schoolHour ?? 0) >= ONLINE_LIMITS.perSchoolHour
    )
      throw throttled();
    const tenant = { id: school.id, timezone: school.timezone, isDemo: false };
    if ((await readBillingState(tx, tenant)).state === "limited")
      throw new DomainError(
        "applications_unavailable",
        "Online applications are not available right now. Please call the school.",
      );
    const left = await smsAllowance(tx, school.id, school.timezone);
    if (left !== null && left <= 0)
      throw new DomainError(
        "applications_unavailable",
        "Online applications are not available right now. Please call the school.",
      );
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const id = randomUUID();
    const [row] = await tx
      .insert(applicationVerifications)
      .values({
        id,
        tenantId: school.id,
        phone: data.phone,
        codeHash: codeHash(id, code),
        draft: { ...data, guardianPhone: data.phone },
        expiresAt: new Date(now.getTime() + VERIFICATION_LIFETIME_MS),
        ipAddress: ip,
        createdAt: now,
      })
      .returning({ id: applicationVerifications.id });
    const outboxId = await enqueue(tx, {
      channel: "sms",
      recipient: data.phone,
      template: "application_code",
      payload: { schoolName: school.name, code },
    });
    await recordSmsUsage(tx, school.id, "application_code", outboxId);
    return { verificationId: row!.id };
  });
}

/**
 * Confirms the code: the draft becomes an application (status "applied", source "online"). Sending the
 * right code again returns the same reference.
 */
export async function confirmOnlineApplication(
  database: Database,
  slug: string,
  input: unknown,
  now = new Date(),
): Promise<{ reference: string }> {
  const { verificationId, code } = z
    .object({
      verificationId: z.string().uuid(),
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/, "Enter the 6-digit code."),
    })
    .parse(input);
  const school = await schoolBySlug(database, slug);
  if (!school) throw new DomainError("verification_invalid", "This code has expired. Send the form again.");
  const wrong = () =>
    new DomainError("code_invalid", "That code is not right. Check the SMS and try again.", "code");
  const expired = () =>
    new DomainError("verification_invalid", "This code has expired. Send the form again.");
  const outcome = await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    const [row] = await tx
      .select()
      .from(applicationVerifications)
      .where(
        and(
          eq(applicationVerifications.tenantId, school.id),
          eq(applicationVerifications.id, verificationId),
        ),
      )
      .for("update");
    if (!row) return { error: expired() };
    if (row.consumedAt) {
      const reference = (row.draft as { reference?: unknown } | null)?.reference;
      if (typeof reference === "string" && row.codeHash === codeHash(row.id, code)) return { reference };
      return { error: expired() };
    }
    if (row.expiresAt <= now || row.attempts >= MAX_VERIFICATION_ATTEMPTS) return { error: expired() };
    if (row.codeHash !== codeHash(row.id, code)) {
      await tx
        .update(applicationVerifications)
        .set({ attempts: row.attempts + 1 })
        .where(eq(applicationVerifications.id, row.id));
      return { error: wrong() };
    }
    const data = parseApplicant(row.draft, school.countryCode);
    const created = await insertApplication(tx, school.id, data, {
      status: "applied",
      source: "online",
      actorUserId: null,
    });
    await tx
      .update(applicationVerifications)
      .set({ consumedAt: now, draft: { reference: created.reference } })
      .where(eq(applicationVerifications.id, row.id));
    // PSH-01: staff who run admissions and have notifications on are told there is a new application.
    for (const device of await staffDevicesFor(tx, school.id, "admissions.manage", now))
      await enqueue(tx, {
        channel: "push",
        recipient: device,
        template: "staff_application_push",
        payload: { schoolName: school.name, schoolSlug: school.slug },
      });
    return { reference: created.reference };
  });
  // A wrong attempt is counted (committed) before the error is reported.
  if ("error" in outcome) throw outcome.error;
  return outcome;
}

/** Deletes checks older than a day (drafts included), and drafts of expired checks. Worker, hourly. */
export async function purgeApplicationVerifications(database: Database, now = new Date()): Promise<number> {
  const schools = await database.execute<{ id: string }>(sql`select id from tenants`);
  let purged = 0;
  for (const school of schools.rows) {
    purged += await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      await tx
        .update(applicationVerifications)
        .set({ draft: null })
        .where(
          and(
            eq(applicationVerifications.tenantId, school.id),
            lt(applicationVerifications.expiresAt, now),
            sql`${applicationVerifications.consumedAt} is null and ${applicationVerifications.draft} is not null`,
          ),
        );
      const gone = await tx
        .delete(applicationVerifications)
        .where(
          and(
            eq(applicationVerifications.tenantId, school.id),
            lt(applicationVerifications.createdAt, new Date(now.getTime() - 86_400_000)),
          ),
        )
        .returning({ id: applicationVerifications.id });
      return gone.length;
    });
  }
  return purged;
}
