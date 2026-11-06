import "server-only";
import { and, count, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { MOBILE_MONEY_NETWORKS, type MobileMoneyNetwork } from "@/lib/mobile-money";
import { formatCedis, parseCedis } from "@/lib/money";
import { maskPhone, normalizePhone } from "@/lib/phone";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { mobileMoneyRequests, payments, students, users } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { campusScopeFilter, loadFinanceStudent } from "../fees/access";
import { insertPayment } from "../fees/payments";
import type { TenantContext } from "../tenancy/service";
import { callbackUrlFor, mobileMoneyProvider } from "./config";
import { ProviderError, type CollectionStatus, type MobileMoneyProvider } from "./provider";

/**
 * Mobile Money collections: a prompt is sent to the payer's phone, and the payment is recorded (receipt,
 * ledger credit, audit) only when the provider confirms it for exactly the amount requested. Every step
 * is idempotent: a form submitted twice sends one prompt, and checking a request twice, or at the same
 * time, records one payment.
 */

export type MobileMoneyRequestStatus = (typeof mobileMoneyRequests.$inferSelect)["status"];

/** A prompt nobody answered within this time stops blocking new prompts for the student. */
export const PROMPT_EXPIRY_MS = 30 * 60_000;
/** How long a provider may take before "no record of this request" means it was never received. */
const NOT_FOUND_GRACE_MS = 5 * 60_000;

export const OPEN_STATUSES: readonly MobileMoneyRequestStatus[] = ["pending", "expired"];
const OPEN = OPEN_STATUSES;

export interface MobileMoneyDeps {
  /** Defaults to the provider configured for this deployment. */
  provider?: MobileMoneyProvider | null;
  now?: Date;
  /** Base URL for provider callbacks; defaults to APP_URL. */
  callbackBaseUrl?: string;
}

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

/** Who records an outcome: a staff member, or the system (worker, callbacks) with no user. */
export interface Actor {
  tenantId: string;
  timezone: string;
  userId: string | null;
}

const actorOf = (ctx: TenantContext): Actor => ({
  tenantId: ctx.tenant.id,
  timezone: ctx.tenant.timezone,
  userId: ctx.userId,
});
const actorScope = (actor: Actor) => ({ tenantId: actor.tenantId, userId: actor.userId ?? "" });

export type MobileMoneyRequest = typeof mobileMoneyRequests.$inferSelect;

export function providerFor(deps: MobileMoneyDeps): MobileMoneyProvider | null {
  return deps.provider === undefined ? mobileMoneyProvider() : deps.provider;
}

/** Whether staff can send prompts, and whether they are only tests. */
export function mobileMoneySetup(deps: MobileMoneyDeps = {}): { enabled: boolean; testMode: boolean } {
  const provider = providerFor(deps);
  return { enabled: provider !== null, testMode: provider?.testMode ?? false };
}

const requestSchema = z.object({
  studentId: z.string().uuid(),
  amount: z.string().transform((text, ctx) => {
    const pesewas = parseCedis(text);
    if (pesewas === null || pesewas === 0) {
      ctx.addIssue({ code: "custom", message: "Enter the amount to collect, like 450 or 450.50." });
      return z.NEVER;
    }
    return pesewas;
  }),
  phone: z.string().transform((text, ctx) => {
    const e164 = normalizePhone(text);
    if (!e164 || !/^\+233[25]\d{8}$/.test(e164)) {
      ctx.addIssue({ code: "custom", message: "Enter a Ghanaian mobile number, like 024 123 4567." });
      return z.NEVER;
    }
    return e164;
  }),
  network: z.enum(MOBILE_MONEY_NETWORKS, { message: "Choose the payer's network." }),
  idempotencyKey: z.string().uuid(),
});

export interface RequestOutcome {
  requestId: string;
  status: MobileMoneyRequestStatus;
  /** True when this submission had already been sent (double submit). */
  replayed: boolean;
  /** True when the provider did not confirm it received the prompt; checking later settles it. */
  unconfirmed: boolean;
}

async function findByKey(database: Database, ctx: TenantContext, key: string) {
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select()
      .from(mobileMoneyRequests)
      .where(
        and(eq(mobileMoneyRequests.tenantId, ctx.tenant.id), eq(mobileMoneyRequests.idempotencyKey, key)),
      );
    return row ?? null;
  });
}

function replay(
  existing: typeof mobileMoneyRequests.$inferSelect,
  data: { studentId: string; amount: number; phone: string },
): RequestOutcome {
  if (
    existing.studentId !== data.studentId ||
    existing.amountPesewas !== data.amount ||
    existing.msisdn !== data.phone
  )
    throw new DomainError(
      "duplicate_submission",
      "This form was already used for another request. Reload the page.",
    );
  return { requestId: existing.id, status: existing.status, replayed: true, unconfirmed: false };
}

/** Sends a payment prompt to the payer's phone for a student's fees. */
export async function requestMobileMoneyPayment(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  deps: MobileMoneyDeps = {},
): Promise<RequestOutcome> {
  assertCan(ctx.roles, "payments.record");
  const provider = providerFor(deps);
  if (!provider)
    throw new DomainError("mobile_money_off", "Mobile Money payments are not set up for this school yet.");
  const data = requestSchema.parse(input);

  const existing = await findByKey(database, ctx, data.idempotencyKey);
  if (existing) return replay(existing, data);

  let created: { id: string; studentName: string };
  try {
    created = await withTenant(database, scope(ctx), async (tx) => {
      const student = await loadFinanceStudent(tx, ctx, data.studentId);
      if (!student) throw new DomainError("student_not_found", "Student not found.");
      const [row] = await tx
        .insert(mobileMoneyRequests)
        .values({
          tenantId: ctx.tenant.id,
          studentId: student.id,
          provider: provider.name,
          network: data.network,
          msisdn: data.phone,
          amountPesewas: data.amount,
          idempotencyKey: data.idempotencyKey,
          requestedByUserId: ctx.userId,
        })
        .returning({ id: mobileMoneyRequests.id });
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "mobile_money.requested",
        entityType: "mobile_money_request",
        entityId: row!.id,
        metadata: {
          amountPesewas: data.amount,
          network: data.network,
          phone: maskPhone(data.phone),
          provider: provider.name,
        },
      });
      return { id: row!.id, studentName: `${student.firstName} ${student.lastName}` };
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      // Either the same form raced itself, or the student already has a prompt waiting.
      const winner = await findByKey(database, ctx, data.idempotencyKey);
      if (winner) return replay(winner, data);
      throw new DomainError(
        "prompt_pending",
        "A Mobile Money prompt for this student is still waiting. Check its status before sending another.",
      );
    }
    throw error;
  }

  try {
    const started = await provider.requestPayment({
      reference: created.id,
      amountPesewas: data.amount,
      currency: "GHS",
      msisdn: data.phone,
      network: data.network,
      payerMessage: `School fees for ${created.studentName}, ${ctx.tenant.name}`,
      callbackUrl: callbackUrlFor(provider.name, ctx.tenant.id, deps.callbackBaseUrl),
    });
    if (started.providerReference) {
      await withTenant(database, scope(ctx), (tx) =>
        tx
          .update(mobileMoneyRequests)
          .set({ providerReference: started.providerReference, updatedAt: new Date() })
          .where(
            and(eq(mobileMoneyRequests.tenantId, ctx.tenant.id), eq(mobileMoneyRequests.id, created.id)),
          ),
      );
    }
    return { requestId: created.id, status: "pending", replayed: false, unconfirmed: false };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (!error.rejected) {
      // Unknown whether the prompt went out (e.g. a timeout). It stays pending; a status check settles it.
      return { requestId: created.id, status: "pending", replayed: false, unconfirmed: true };
    }
    await withTenant(database, scope(ctx), async (tx) => {
      await finish(tx, actorOf(ctx), created.id, {
        status: "failed",
        statusReason: reason(error.message),
      });
    });
    throw new DomainError("provider_rejected", error.message, "phone");
  }
}

export interface CheckOutcome {
  requestId: string;
  status: MobileMoneyRequestStatus;
  statusReason: string | null;
  paymentId: string | null;
}

/**
 * Asks the provider for the outcome of a request and records it. A confirmed payment is recorded with
 * its receipt in the same transaction that marks the request successful.
 */
export async function checkMobileMoneyRequest(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  deps: MobileMoneyDeps = {},
): Promise<CheckOutcome> {
  assertCan(ctx.roles, "payments.record");
  const request = await loadRequest(database, ctx, requestId);
  if (!request) throw new DomainError("request_not_found", "Mobile Money request not found.");
  if (!OPEN.includes(request.status)) return outcome(request);

  const provider = providerFor(deps);
  if (!provider || provider.name !== request.provider)
    throw new DomainError(
      "provider_unavailable",
      "This prompt was sent through a provider that is no longer set up. If the money arrived, record the payment by hand.",
    );
  try {
    return await settleRequest(database, actorOf(ctx), request, provider, deps.now ?? new Date());
  } catch (error) {
    if (error instanceof ProviderError)
      throw new DomainError("provider_unavailable", `${error.message} Try again in a minute.`);
    throw error;
  }
}

/**
 * Asks the request's provider for its outcome and records it. Shared by staff checks, callbacks and
 * the worker. Throws ProviderError when the provider cannot be reached (nothing is recorded then).
 */
export async function settleRequest(
  database: Database,
  actor: Actor,
  request: Pick<MobileMoneyRequest, "id" | "providerReference">,
  provider: MobileMoneyProvider,
  now: Date,
): Promise<CheckOutcome> {
  const status = await provider.getStatus({
    reference: request.id,
    providerReference: request.providerReference,
  });
  return applyStatus(database, actor, request.id, status, now);
}

async function loadRequest(database: Database, ctx: TenantContext, requestId: string) {
  if (!z.string().uuid().safeParse(requestId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select()
      .from(mobileMoneyRequests)
      .where(and(eq(mobileMoneyRequests.tenantId, ctx.tenant.id), eq(mobileMoneyRequests.id, requestId)));
    if (!row || !(await loadFinanceStudent(tx, ctx, row.studentId))) return null;
    return row;
  });
}

function outcome(row: typeof mobileMoneyRequests.$inferSelect): CheckOutcome {
  return { requestId: row.id, status: row.status, statusReason: row.statusReason, paymentId: row.paymentId };
}

const reason = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** Why a reported success cannot be recorded automatically, or null when it matches the request. */
function mismatch(
  row: typeof mobileMoneyRequests.$inferSelect,
  status: Extract<CollectionStatus, { state: "successful" }>,
): string | null {
  if (status.currency !== row.currency)
    return `The network reported a payment in ${status.currency}, not GHS.`;
  if (!Number.isSafeInteger(status.amountPesewas) || status.amountPesewas <= 0)
    return "The network reported an invalid amount.";
  if (status.amountPesewas !== row.amountPesewas)
    return `The network reported ${formatCedis(status.amountPesewas)}, not the ${formatCedis(row.amountPesewas)} requested.`;
  if (!status.transactionId || status.transactionId.length > 60)
    return "The network did not report a usable transaction ID.";
  return null;
}

async function applyStatus(
  database: Database,
  actor: Actor,
  requestId: string,
  status: CollectionStatus,
  now: Date,
): Promise<CheckOutcome> {
  return withTenant(database, actorScope(actor), async (tx) => {
    // Lock the request: a concurrent check waits here, then sees the outcome this one recorded.
    const [row] = await tx
      .select()
      .from(mobileMoneyRequests)
      .where(and(eq(mobileMoneyRequests.tenantId, actor.tenantId), eq(mobileMoneyRequests.id, requestId)))
      .for("update");
    if (!row) throw new DomainError("request_not_found", "Mobile Money request not found.");
    if (!OPEN.includes(row.status)) return outcome(row);
    const age = now.getTime() - row.createdAt.getTime();

    switch (status.state) {
      case "successful": {
        const problem = mismatch(row, status);
        if (problem) {
          return finish(tx, actor, row.id, {
            status: "needs_review",
            statusReason: reason(problem),
            transactionId:
              status.transactionId && status.transactionId.length <= 60 ? status.transactionId : null,
          });
        }
        const completed = status.completedAt && status.completedAt < now ? status.completedAt : now;
        const { paymentId } = await insertPayment(tx, {
          tenantId: actor.tenantId,
          studentId: row.studentId,
          amountPesewas: row.amountPesewas,
          method: "mobile_money",
          reference: status.transactionId,
          payerName: null,
          paidOn: todayIn(actor.timezone, completed),
          idempotencyKey: `mobile_money:${row.id}`,
          recordedByUserId: actor.userId,
        });
        return finish(tx, actor, row.id, {
          status: "successful",
          paymentId,
          transactionId: status.transactionId,
        });
      }
      case "failed":
        return finish(tx, actor, row.id, { status: "failed", statusReason: reason(status.reason) });
      case "not_found":
        if (age > NOT_FOUND_GRACE_MS)
          return finish(tx, actor, row.id, {
            status: "failed",
            statusReason: "The network has no record of this prompt, so it was not sent.",
          });
        return touch(tx, actor, row);
      case "pending":
        if (row.status === "pending" && age > PROMPT_EXPIRY_MS) {
          const [updated] = await tx
            .update(mobileMoneyRequests)
            .set({ status: "expired", lastCheckedAt: now, updatedAt: now })
            .where(eq(mobileMoneyRequests.id, row.id))
            .returning();
          await recordAudit(tx, {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "mobile_money.expired",
            entityType: "mobile_money_request",
            entityId: row.id,
          });
          return outcome(updated!);
        }
        return touch(tx, actor, row);
    }
  });
}

async function touch(
  tx: Transaction,
  actor: Actor,
  row: typeof mobileMoneyRequests.$inferSelect,
): Promise<CheckOutcome> {
  const now = new Date();
  await tx
    .update(mobileMoneyRequests)
    .set({ lastCheckedAt: now, updatedAt: now })
    .where(and(eq(mobileMoneyRequests.tenantId, actor.tenantId), eq(mobileMoneyRequests.id, row.id)));
  return outcome(row);
}

const FINISH_AUDIT = {
  successful: "mobile_money.confirmed",
  failed: "mobile_money.failed",
  needs_review: "mobile_money.needs_review",
} as const;

async function finish(
  tx: Transaction,
  actor: Actor,
  requestId: string,
  result:
    | { status: "successful"; paymentId: string; transactionId: string }
    | { status: "failed"; statusReason: string }
    | { status: "needs_review"; statusReason: string; transactionId: string | null },
): Promise<CheckOutcome> {
  const now = new Date();
  const [updated] = await tx
    .update(mobileMoneyRequests)
    .set({
      status: result.status,
      paymentId: result.status === "successful" ? result.paymentId : null,
      transactionId: result.status === "failed" ? null : result.transactionId,
      statusReason: result.status === "successful" ? null : result.statusReason,
      completedAt: now,
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(and(eq(mobileMoneyRequests.tenantId, actor.tenantId), eq(mobileMoneyRequests.id, requestId)))
    .returning();
  await recordAudit(tx, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    action: FINISH_AUDIT[result.status],
    entityType: "mobile_money_request",
    entityId: requestId,
    metadata:
      result.status === "successful"
        ? { paymentId: result.paymentId, transactionId: result.transactionId }
        : { reason: result.statusReason },
  });
  return outcome(updated!);
}

export interface MobileMoneyRequestRow {
  id: string;
  studentId: string;
  studentName: string;
  admissionNumber: string;
  status: MobileMoneyRequestStatus;
  statusReason: string | null;
  network: MobileMoneyNetwork;
  msisdn: string;
  amountPesewas: number;
  transactionId: string | null;
  paymentId: string | null;
  receiptNumber: string | null;
  requestedBy: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  testMode: boolean;
}

const requester = alias(users, "requester");
const reviewer = alias(users, "reviewer");

/** Requests with their student, receipt and the people involved, newest first. */
async function selectRows(
  tx: Transaction,
  where: SQL | undefined,
  limit: number,
  offset = 0,
): Promise<MobileMoneyRequestRow[]> {
  const rows = await tx
    .select({
      id: mobileMoneyRequests.id,
      studentId: mobileMoneyRequests.studentId,
      firstName: students.firstName,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
      status: mobileMoneyRequests.status,
      statusReason: mobileMoneyRequests.statusReason,
      network: mobileMoneyRequests.network,
      msisdn: mobileMoneyRequests.msisdn,
      amountPesewas: mobileMoneyRequests.amountPesewas,
      transactionId: mobileMoneyRequests.transactionId,
      paymentId: mobileMoneyRequests.paymentId,
      receiptNumber: payments.receiptNumber,
      requestedBy: requester.name,
      createdAt: mobileMoneyRequests.createdAt,
      reviewedAt: mobileMoneyRequests.reviewedAt,
      reviewedBy: reviewer.name,
      reviewNote: mobileMoneyRequests.reviewNote,
      provider: mobileMoneyRequests.provider,
    })
    .from(mobileMoneyRequests)
    .innerJoin(students, eq(students.id, mobileMoneyRequests.studentId))
    .leftJoin(payments, eq(payments.id, mobileMoneyRequests.paymentId))
    .leftJoin(requester, eq(requester.id, mobileMoneyRequests.requestedByUserId))
    .leftJoin(reviewer, eq(reviewer.id, mobileMoneyRequests.reviewedByUserId))
    .where(where)
    .orderBy(desc(mobileMoneyRequests.createdAt), desc(mobileMoneyRequests.id))
    .limit(limit)
    .offset(offset);
  return rows.map(({ provider, firstName, lastName, ...row }) => ({
    ...row,
    studentName: `${firstName} ${lastName}`,
    testMode: provider === "mock",
  }));
}

/** A student's most recent Mobile Money requests, newest first. */
export async function listMobileMoneyRequests(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  limit = 5,
): Promise<MobileMoneyRequestRow[]> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await loadFinanceStudent(tx, ctx, studentId))) return [];
    return selectRows(
      tx,
      and(eq(mobileMoneyRequests.tenantId, ctx.tenant.id), eq(mobileMoneyRequests.studentId, studentId)),
      limit,
    );
  });
}

export const MOBILE_MONEY_PAGE_SIZE = 50;

/** "attention": held for review and not yet reviewed. "waiting": still waiting for the payer. */
export const MOBILE_MONEY_FILTERS = ["all", "attention", "waiting"] as const;
export type MobileMoneyFilter = (typeof MOBILE_MONEY_FILTERS)[number];

const needsAttention = and(
  eq(mobileMoneyRequests.status, "needs_review"),
  isNull(mobileMoneyRequests.reviewedAt),
);

export interface SchoolMobileMoneyPage {
  rows: MobileMoneyRequestRow[];
  total: number;
  page: number;
  /** Held payments nobody has reviewed yet, whatever the filter. */
  attentionCount: number;
}

/** Every Mobile Money request the member can see (campus scope applies), newest first. */
export async function listSchoolMobileMoneyRequests(
  database: Database,
  ctx: TenantContext,
  options: { filter: MobileMoneyFilter; page: number },
): Promise<SchoolMobileMoneyPage> {
  assertCan(ctx.roles, "fees.view");
  const page = Math.max(1, Math.floor(options.page));
  const visible = and(
    eq(mobileMoneyRequests.tenantId, ctx.tenant.id),
    campusScopeFilter(ctx, mobileMoneyRequests.studentId),
  );
  const filtered =
    options.filter === "attention"
      ? and(visible, needsAttention)
      : options.filter === "waiting"
        ? and(visible, inArray(mobileMoneyRequests.status, [...OPEN_STATUSES]))
        : visible;
  return withTenant(database, scope(ctx), async (tx) => {
    // One transaction is one connection: queries run one after another.
    const [totals] = await tx.select({ n: count() }).from(mobileMoneyRequests).where(filtered);
    const [attention] = await tx
      .select({ n: count() })
      .from(mobileMoneyRequests)
      .where(and(visible, needsAttention));
    const rows = await selectRows(tx, filtered, MOBILE_MONEY_PAGE_SIZE, (page - 1) * MOBILE_MONEY_PAGE_SIZE);
    return { rows, total: totals!.n, page, attentionCount: attention!.n };
  });
}

const reviewSchema = z.object({
  note: z
    .string()
    .trim()
    .min(3, "Say what you found, for example the receipt you recorded by hand.")
    .max(200, "Use 200 characters or fewer."),
});

/**
 * Closes a payment held for review once staff have checked the school's Mobile Money statement and
 * dealt with it (usually by recording what actually arrived by hand). Recorded once, with a note.
 */
export async function markMobileMoneyReviewed(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "payments.record");
  const { note } = reviewSchema.parse(input);
  if (!z.string().uuid().safeParse(requestId).success)
    throw new DomainError("request_not_found", "Mobile Money request not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select()
      .from(mobileMoneyRequests)
      .where(and(eq(mobileMoneyRequests.tenantId, ctx.tenant.id), eq(mobileMoneyRequests.id, requestId)))
      .for("update");
    if (!row || !(await loadFinanceStudent(tx, ctx, row.studentId)))
      throw new DomainError("request_not_found", "Mobile Money request not found.");
    if (row.status !== "needs_review")
      throw new DomainError("not_held", "Only payments held for review can be marked as reviewed.");
    if (row.reviewedAt) throw new DomainError("already_reviewed", "This payment has already been reviewed.");
    const now = new Date();
    await tx
      .update(mobileMoneyRequests)
      .set({ reviewedAt: now, reviewedByUserId: ctx.userId, reviewNote: note, updatedAt: now })
      .where(eq(mobileMoneyRequests.id, row.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "mobile_money.reviewed",
      entityType: "mobile_money_request",
      entityId: row.id,
      metadata: { note },
    });
  });
}
