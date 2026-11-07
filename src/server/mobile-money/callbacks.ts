import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { mobileMoneyCallbacks, mobileMoneyRequests, tenants } from "../db/schema";
import { ProviderError } from "./provider";
import {
  OPEN_STATUSES,
  providerFor,
  settleRequest,
  type Actor,
  type MobileMoneyDeps,
  type MobileMoneyRequest,
} from "./requests";

/**
 * Provider callbacks and background status checks. A callback is stored first (so none is lost), then
 * processed straight away when possible; the worker processes anything left and also asks the provider
 * about prompts still waiting, so a lost callback only delays a receipt. Both paths end in
 * settleRequest, which asks the provider for the outcome: a callback's own content is never trusted.
 */

/** A waiting prompt is checked at most this often. */
const PENDING_CHECK_MS = 60_000;
/** An expired prompt is still checked, less often, in case the payer approves late. */
const EXPIRED_CHECK_MS = 15 * 60_000;
/** After this, nobody looks automatically any more; staff can still check by hand. */
const AUTO_CHECK_WINDOW_MS = 24 * 60 * 60_000;
/** A callback whose request cannot be checked (provider unreachable) is retried this many times. */
export const MAX_CALLBACK_ATTEMPTS = 10;
const BATCH = 50;

const isUuid = (value: string) => z.string().uuid().safeParse(value).success;

export interface SchoolRef {
  id: string;
  timezone: string;
}

export type CallbackReceipt =
  | { kind: "accepted" | "duplicate"; school: SchoolRef }
  /** Genuine, but not about an EduBridge payment (another Paystack event): acknowledged, nothing stored. */
  | { kind: "ignored" }
  | { kind: "unknown_provider" | "unknown_school" | "invalid_signature" };

/**
 * Stores a provider callback for a school after checking its signature. Repeats of the same callback
 * (providers retry) are stored once.
 */
export async function receiveMobileMoneyCallback(
  database: Database,
  /** The school from the callback URL, or null when the provider uses one address for all (Paystack). */
  input: { providerName: string; tenantId: string | null; headers: Headers; rawBody: string },
  deps: MobileMoneyDeps = {},
): Promise<CallbackReceipt> {
  const provider = providerFor(deps);
  if (!provider || provider.name !== input.providerName) return { kind: "unknown_provider" };
  if (input.tenantId !== null && !isUuid(input.tenantId)) return { kind: "unknown_school" };
  const ref = provider.verifyCallback({ headers: input.headers, rawBody: input.rawBody });
  if (!ref) return { kind: "invalid_signature" };
  // One address for every school: the school comes from the (signed) reference.
  const tenantId = input.tenantId ?? ref.tenantId ?? null;
  if (tenantId === null) return { kind: "ignored" };
  if (input.tenantId !== null && ref.tenantId && ref.tenantId !== input.tenantId)
    return { kind: "unknown_school" };
  const [school] = await database
    .select({ id: tenants.id, timezone: tenants.timezone })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.status, "active")));
  if (!school) return { kind: "unknown_school" };

  const requestId = ref.reference && isUuid(ref.reference) ? ref.reference : null;
  if (!requestId && !ref.providerReference) return { kind: "invalid_signature" };
  const inserted = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
    tx
      .insert(mobileMoneyCallbacks)
      .values({
        tenantId: school.id,
        provider: provider.name,
        requestId,
        providerReference: ref.providerReference,
        bodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
      })
      .onConflictDoNothing()
      .returning({ id: mobileMoneyCallbacks.id }),
  );
  return { kind: inserted.length ? "accepted" : "duplicate", school };
}

export interface MobileMoneyWork {
  callbacks: number;
  checked: number;
  /** Payments recorded (receipts issued). */
  recorded: number;
  /** Provider calls that failed; they are retried later. */
  errors: number;
}

const none = (): MobileMoneyWork => ({ callbacks: 0, checked: 0, recorded: 0, errors: 0 });

const systemActor = (school: SchoolRef): Actor => ({
  tenantId: school.id,
  timezone: school.timezone,
  userId: null,
});
const systemScope = (school: SchoolRef) => ({ tenantId: school.id, userId: "" });

/** Processes a school's stored callbacks, oldest first. */
export async function processMobileMoneyCallbacks(
  database: Database,
  school: SchoolRef,
  deps: MobileMoneyDeps = {},
): Promise<MobileMoneyWork> {
  const work = none();
  const provider = providerFor(deps);
  if (!provider) return work;
  const now = deps.now ?? new Date();
  const queued = await withTenant(database, systemScope(school), (tx) =>
    tx
      .select()
      .from(mobileMoneyCallbacks)
      .where(
        and(
          eq(mobileMoneyCallbacks.tenantId, school.id),
          eq(mobileMoneyCallbacks.provider, provider.name),
          isNull(mobileMoneyCallbacks.processedAt),
          lt(mobileMoneyCallbacks.attempts, MAX_CALLBACK_ATTEMPTS),
        ),
      )
      .orderBy(asc(mobileMoneyCallbacks.receivedAt))
      .limit(BATCH),
  );

  for (const callback of queued) {
    const request = await withTenant(database, systemScope(school), async (tx) => {
      const [row] = await tx
        .select()
        .from(mobileMoneyRequests)
        .where(
          and(
            eq(mobileMoneyRequests.tenantId, school.id),
            eq(mobileMoneyRequests.provider, callback.provider),
            callback.requestId
              ? eq(mobileMoneyRequests.id, callback.requestId)
              : eq(mobileMoneyRequests.providerReference, callback.providerReference!),
          ),
        );
      return row ?? null;
    });
    let result: string;
    if (!request) result = "unknown_request";
    else if (!OPEN_STATUSES.includes(request.status)) result = request.status;
    else {
      try {
        const outcome = await settleRequest(database, systemActor(school), request, provider, now);
        result = outcome.status;
        if (outcome.status === "successful") work.recorded++;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        work.errors++;
        await withTenant(database, systemScope(school), (tx) =>
          tx
            .update(mobileMoneyCallbacks)
            .set({ attempts: sql`${mobileMoneyCallbacks.attempts} + 1` })
            .where(eq(mobileMoneyCallbacks.id, callback.id)),
        );
        continue;
      }
    }
    await withTenant(database, systemScope(school), (tx) =>
      tx
        .update(mobileMoneyCallbacks)
        .set({
          processedAt: new Date(),
          result,
          attempts: sql`${mobileMoneyCallbacks.attempts} + 1`,
        })
        .where(and(eq(mobileMoneyCallbacks.id, callback.id), isNull(mobileMoneyCallbacks.processedAt))),
    );
    work.callbacks++;
  }
  return work;
}

/** Asks the provider about a school's prompts that are still waiting and due a check. */
export async function pollOpenRequests(
  database: Database,
  school: SchoolRef,
  deps: MobileMoneyDeps = {},
): Promise<MobileMoneyWork> {
  const work = none();
  const provider = providerFor(deps);
  if (!provider) return work;
  const now = deps.now ?? new Date();
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const due: MobileMoneyRequest[] = await withTenant(database, systemScope(school), (tx) =>
    tx
      .select()
      .from(mobileMoneyRequests)
      .where(
        and(
          eq(mobileMoneyRequests.tenantId, school.id),
          eq(mobileMoneyRequests.provider, provider.name),
          inArray(mobileMoneyRequests.status, [...OPEN_STATUSES]),
          gt(mobileMoneyRequests.createdAt, at(AUTO_CHECK_WINDOW_MS)),
          or(
            and(
              eq(mobileMoneyRequests.status, "pending"),
              or(
                isNull(mobileMoneyRequests.lastCheckedAt),
                lt(mobileMoneyRequests.lastCheckedAt, at(PENDING_CHECK_MS)),
              ),
            ),
            and(
              eq(mobileMoneyRequests.status, "expired"),
              lt(mobileMoneyRequests.lastCheckedAt, at(EXPIRED_CHECK_MS)),
            ),
          ),
        ),
      )
      .orderBy(sql`${mobileMoneyRequests.lastCheckedAt} asc nulls first`)
      .limit(BATCH),
  );

  for (const request of due) {
    try {
      const outcome = await settleRequest(database, systemActor(school), request, provider, now);
      work.checked++;
      if (outcome.status === "successful") work.recorded++;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      work.errors++;
      // Count the attempt so an unreachable provider is not asked again on every cycle.
      await withTenant(database, systemScope(school), (tx) =>
        tx
          .update(mobileMoneyRequests)
          .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
          .where(eq(mobileMoneyRequests.id, request.id)),
      );
    }
  }
  return work;
}

/** One worker cycle across every active school. */
export async function runMobileMoneyWork(
  database: Database,
  deps: MobileMoneyDeps = {},
): Promise<MobileMoneyWork> {
  const total = none();
  if (!providerFor(deps)) return total;
  const schools = await database
    .select({ id: tenants.id, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const school of schools) {
    for (const work of [
      await processMobileMoneyCallbacks(database, school, deps),
      await pollOpenRequests(database, school, deps),
    ]) {
      total.callbacks += work.callbacks;
      total.checked += work.checked;
      total.recorded += work.recorded;
      total.errors += work.errors;
    }
  }
  return total;
}
