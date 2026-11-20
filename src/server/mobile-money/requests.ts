import "server-only";
import { moduleActive } from "../entitlements/service";
import { and, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { countryProfile } from "@/lib/countries";
import { networksFor, type MobileMoneyNetwork } from "@/lib/mobile-money";
import { formatMoney, parseMoney } from "@/lib/money";
import { maskPhone, normalizePhone } from "@/lib/phone";
import { recordAudit } from "../audit/record";
import { assertAllowed, assertFeature } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  ledgerEntries,
  mobileMoneyRequests,
  mobileMoneyRequestShares,
  payments,
  students,
  tenantEntitlements,
  users,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { campusScopeFilter, loadFinanceStudent } from "../fees/access";
import { insertPayment } from "../fees/payments";
import { linkedStudents } from "../parents/portal";
import { schoolBySlug, type ParentSchoolRef } from "../parents/schools";
import type { TenantContext } from "../tenancy/service";
import { callbackUrlFor, mobileMoneyRegistry, providerForSchool, providerNamed } from "./config";
import { ProviderError, supportsCurrency, type CollectionStatus, type MobileMoneyProvider } from "./provider";

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
  /**
   * For tests: one provider for everything. Otherwise a school's prompts use its provider (PAY-06) and a
   * prompt is always checked with the provider that sent it.
   */
  provider?: MobileMoneyProvider | null;
  now?: Date;
  /** Base URL for provider callbacks; defaults to APP_URL. */
  callbackBaseUrl?: string;
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Who records an outcome: a staff member, or the system (worker, callbacks) with no user. */
export interface Actor {
  tenantId: string;
  timezone: string;
  userId: string | null;
  supportGrantId?: string | null;
}

const actorOf = (ctx: TenantContext): Actor => ({
  tenantId: ctx.tenant.id,
  timezone: ctx.tenant.timezone,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});
const actorScope = (actor: Actor) => ({
  tenantId: actor.tenantId,
  userId: actor.userId ?? "",
  supportGrantId: actor.supportGrantId,
});

export type MobileMoneyRequest = typeof mobileMoneyRequests.$inferSelect;

/** Every provider the worker should look after: the test override, or all this deployment has. */
export function providersIn(deps: MobileMoneyDeps): MobileMoneyProvider[] {
  if (deps.provider !== undefined) return deps.provider ? [deps.provider] : [];
  return [...mobileMoneyRegistry().providers.values()];
}

/** The provider a school sends new prompts with. */
export function schoolProviderFor(
  school: { mobileMoneyProvider?: string | null; tenant: { isDemo: boolean } },
  deps: MobileMoneyDeps,
): MobileMoneyProvider | null {
  if (deps.provider !== undefined) return deps.provider;
  return providerForSchool({ choice: school.mobileMoneyProvider ?? null, isDemo: school.tenant.isDemo });
}

/** The provider that sent a prompt, which is the one that can say what happened to it. */
export function providerOfRequest(
  request: { provider: string },
  deps: MobileMoneyDeps,
): MobileMoneyProvider | null {
  const provider = deps.provider === undefined ? providerNamed(request.provider) : deps.provider;
  return provider && provider.name === request.provider ? provider : null;
}

/**
 * Whether staff can send prompts: a provider is configured, it collects in the school's currency, and the
 * school's plan includes Mobile Money.
 */
export function mobileMoneySetup(
  ctx: Pick<TenantContext, "features" | "mobileMoneyProvider"> & {
    tenant: Pick<TenantContext["tenant"], "currencyCode" | "countryCode"> & { isDemo?: boolean };
  },
  deps: MobileMoneyDeps = {},
): {
  enabled: boolean;
  testMode: boolean;
  testHint: string | null;
  networks: { id: MobileMoneyNetwork; label: string }[];
} {
  const provider = schoolProviderFor(
    { mobileMoneyProvider: ctx.mobileMoneyProvider, tenant: { isDemo: ctx.tenant.isDemo ?? false } },
    deps,
  );
  return {
    enabled:
      provider !== null &&
      supportsCurrency(provider, ctx.tenant.currencyCode) &&
      ctx.features.includes("mobile_money"),
    testMode: provider?.testMode ?? false,
    testHint: provider?.testMode ? (provider.testHint ?? null) : null,
    networks: networksFor(ctx.tenant.countryCode),
  };
}

/** A prompt's details, checked against the school's country (phone numbering, networks) and currency. */
function requestSchemaFor(school: { countryCode: string; currencyCode: string }) {
  const networks = networksFor(school.countryCode).map((n) => n.id);
  const home = countryProfile(school.countryCode);
  return z.object({
    studentId: z.string().uuid(),
    amount: z.string().transform((text, ctx) => {
      const minor = parseMoney(text, school.currencyCode);
      if (minor === null || minor === 0) {
        ctx.addIssue({ code: "custom", message: "Enter the amount to collect, like 450 or 450.50." });
        return z.NEVER;
      }
      return minor;
    }),
    phone: z.string().transform((text, ctx) => {
      const e164 = normalizePhone(text, school.countryCode);
      if (!e164 || !e164.startsWith(`+${home.dialCode}`)) {
        ctx.addIssue({ code: "custom", message: `Enter a mobile number in ${home.name}.` });
        return z.NEVER;
      }
      return e164;
    }),
    network: z
      .string()
      .refine(
        (n): n is MobileMoneyNetwork => networks.includes(n as MobileMoneyNetwork),
        "Choose the payer's network.",
      )
      .transform((n) => n as MobileMoneyNetwork),
    idempotencyKey: z.string().uuid(),
  });
}

export interface RequestOutcome {
  requestId: string;
  status: MobileMoneyRequestStatus;
  /** True when this submission had already been sent (double submit). */
  replayed: boolean;
  /** True when the provider did not confirm it received the prompt; checking later settles it. */
  unconfirmed: boolean;
}

/** Who sends a prompt: a staff member, or a parent from the parent view (no user). */
interface Origin {
  tenantId: string;
  tenantName: string;
  currency: string;
  timezone: string;
  userId: string | null;
  supportGrantId?: string | null;
  /** Recorded in the audit entry. */
  by: "staff" | "parent";
}

const originOf = (ctx: TenantContext): Origin => ({
  tenantId: ctx.tenant.id,
  tenantName: ctx.tenant.name,
  currency: ctx.tenant.currencyCode,
  timezone: ctx.tenant.timezone,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
  by: "staff",
});

async function findByKey(database: Database, origin: Origin, key: string) {
  return withTenant(database, actorScope(origin), async (tx) => {
    const [row] = await tx
      .select()
      .from(mobileMoneyRequests)
      .where(
        and(eq(mobileMoneyRequests.tenantId, origin.tenantId), eq(mobileMoneyRequests.idempotencyKey, key)),
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

type RequestData = z.infer<ReturnType<typeof requestSchemaFor>>;
type PromptStudent = { id: string; firstName: string; lastName: string };
/** One child's part of a family payment, in minor units. */
export interface FamilyShare {
  studentId: string;
  amount: number;
}

/**
 * A family is never sent two prompts for the same child at once: not two for one child, and not a family prompt
 * while one of its children has a prompt waiting (or the other way round).
 */
async function assertNoPromptWaiting(tx: Transaction, tenantId: string, studentIds: readonly string[]) {
  const ids = sql.join(
    studentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const waiting = await tx.execute(sql`
    select 1 from mobile_money_requests r
    where r.tenant_id = ${tenantId} and r.status = 'pending'
      and (r.student_id in (${ids})
        or exists (select 1 from mobile_money_request_shares s where s.request_id = r.id and s.student_id in (${ids})))
    limit 1`);
  if (waiting.rows.length > 0)
    throw new DomainError(
      "prompt_pending",
      studentIds.length > 1
        ? "A Mobile Money prompt for one of these children is still waiting. Check its status before sending another."
        : "A Mobile Money prompt for this student is still waiting. Check its status before sending another.",
    );
}

/**
 * Records the request and sends the prompt. `loadStudent` (inside the tenant transaction) decides whether
 * the sender may collect for the student, and may refuse with a DomainError.
 */
async function sendPrompt(
  database: Database,
  origin: Origin,
  data: RequestData,
  provider: MobileMoneyProvider,
  deps: MobileMoneyDeps,
  loadStudent: (tx: Transaction) => Promise<PromptStudent | null>,
  /** A family payment: each child's part (the first is `data.studentId`), adding up to `data.amount`. */
  family?: { shares: readonly FamilyShare[]; payerMessage: string },
): Promise<RequestOutcome> {
  const existing = await findByKey(database, origin, data.idempotencyKey);
  if (existing) return replay(existing, data);

  let created: { id: string; studentName: string; settlementAccount: string | null };
  try {
    created = await withTenant(database, actorScope(origin), async (tx) => {
      const student = await loadStudent(tx);
      if (!student) throw new DomainError("student_not_found", "Student not found.");
      await assertNoPromptWaiting(
        tx,
        origin.tenantId,
        family ? family.shares.map((sh) => sh.studentId) : [student.id],
      );
      const [row] = await tx
        .insert(mobileMoneyRequests)
        .values({
          tenantId: origin.tenantId,
          studentId: student.id,
          provider: provider.name,
          network: data.network,
          msisdn: data.phone,
          amountPesewas: data.amount,
          currency: origin.currency,
          idempotencyKey: data.idempotencyKey,
          requestedByUserId: origin.userId,
        })
        .returning({ id: mobileMoneyRequests.id });
      if (family)
        await tx.insert(mobileMoneyRequestShares).values(
          family.shares.map((sh) => ({
            tenantId: origin.tenantId,
            requestId: row!.id,
            studentId: sh.studentId,
            amountPesewas: sh.amount,
          })),
        );
      await recordAudit(tx, {
        tenantId: origin.tenantId,
        actorUserId: origin.userId,
        action: "mobile_money.requested",
        entityType: "mobile_money_request",
        entityId: row!.id,
        metadata: {
          amountPesewas: data.amount,
          network: data.network,
          phone: maskPhone(data.phone),
          provider: provider.name,
          by: origin.by,
          ...(family ? { children: family.shares.length } : {}),
        },
      });
      const [plan] = await tx
        .select({ settlementAccount: tenantEntitlements.settlementAccount })
        .from(tenantEntitlements)
        .where(eq(tenantEntitlements.tenantId, origin.tenantId));
      return {
        id: row!.id,
        studentName: `${student.firstName} ${student.lastName}`,
        settlementAccount: plan?.settlementAccount ?? null,
      };
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      // Either the same form raced itself, or the student already has a prompt waiting.
      const winner = await findByKey(database, origin, data.idempotencyKey);
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
      tenantId: origin.tenantId,
      reference: created.id,
      amountPesewas: data.amount,
      currency: origin.currency,
      msisdn: data.phone,
      network: data.network,
      payerMessage: family?.payerMessage ?? `School fees for ${created.studentName}, ${origin.tenantName}`,
      callbackUrl: callbackUrlFor(provider.name, origin.tenantId, deps.callbackBaseUrl),
      settlementAccount: created.settlementAccount,
    });
    if (started.providerReference) {
      await withTenant(database, actorScope(origin), (tx) =>
        tx
          .update(mobileMoneyRequests)
          .set({ providerReference: started.providerReference, updatedAt: new Date() })
          .where(
            and(eq(mobileMoneyRequests.tenantId, origin.tenantId), eq(mobileMoneyRequests.id, created.id)),
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
    await withTenant(database, actorScope(origin), async (tx) => {
      await finish(tx, origin, created.id, { status: "failed", statusReason: reason(error.message) });
    });
    throw new DomainError("provider_rejected", error.message, "phone");
  }
}

/** Sends a payment prompt to the payer's phone for a student's fees. */
export async function requestMobileMoneyPayment(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  deps: MobileMoneyDeps = {},
): Promise<RequestOutcome> {
  assertAllowed(ctx, "payments.record");
  // Checking or settling a prompt already sent is never blocked, so money in flight is always recorded.
  assertFeature(ctx, "mobile_money");
  const provider = schoolProviderFor(ctx, deps);
  if (!provider || !supportsCurrency(provider, ctx.tenant.currencyCode))
    throw new DomainError("mobile_money_off", "Mobile Money payments are not set up for this school yet.");
  const data = requestSchemaFor(ctx.tenant).parse(input);
  return sendPrompt(database, originOf(ctx), data, provider, deps, (tx) =>
    loadFinanceStudent(tx, ctx, data.studentId),
  );
}

/** The provider a school's families pay through (schools in the parent view are never demo schools). */
async function parentSchoolProvider(
  database: Database,
  school: Pick<ParentSchoolRef, "id">,
  deps: MobileMoneyDeps,
): Promise<MobileMoneyProvider | null> {
  if (deps.provider !== undefined) return deps.provider;
  const choice = await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    const [plan] = await tx
      .select({ provider: tenantEntitlements.mobileMoneyProvider })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, school.id));
    return plan?.provider ?? null;
  });
  return providerForSchool({ choice, isDemo: false });
}

/** Whether parents can pay a school online: a provider is configured and the plan includes Mobile Money. */
export async function parentPaymentSetup(
  database: Database,
  school: Pick<ParentSchoolRef, "id" | "countryCode" | "currencyCode">,
  deps: MobileMoneyDeps = {},
): Promise<{
  enabled: boolean;
  testMode: boolean;
  testHint: string | null;
  networks: { id: MobileMoneyNetwork; label: string }[];
}> {
  const provider = await parentSchoolProvider(database, school, deps);
  const tenantId = school.id;
  const included = await withTenant(database, { tenantId, userId: "" }, async (tx) => {
    return moduleActive(tx, tenantId, "mobile_money");
  });
  return {
    enabled: provider !== null && supportsCurrency(provider, school.currencyCode) && included,
    testMode: provider?.testMode ?? false,
    testHint: provider?.testMode ? (provider.testHint ?? null) : null,
    networks: networksFor(school.countryCode),
  };
}

/**
 * A parent pays a child's fees from the parent view (PAY-01, PRT-02): in full or in part, never more than
 * is owed. The child must be linked to the parent's number. Settled exactly as staff prompts are.
 */
export async function requestParentMobileMoneyPayment(
  database: Database,
  parentPhone: string,
  slug: string,
  input: unknown,
  deps: MobileMoneyDeps = {},
): Promise<RequestOutcome> {
  const school = await schoolBySlug(database, slug);
  if (!school) throw new DomainError("student_not_found", "Student not found.");
  const setup = await parentPaymentSetup(database, school, deps);
  const provider = await parentSchoolProvider(database, school, deps);
  if (!setup.enabled || !provider)
    throw new DomainError("mobile_money_off", "This school does not take payments online yet.");
  const data = requestSchemaFor(school).parse(input);
  const origin: Origin = {
    tenantId: school.id,
    tenantName: school.name,
    currency: school.currencyCode,
    timezone: school.timezone,
    userId: null,
    by: "parent",
  };
  return sendPrompt(database, origin, data, provider, deps, async (tx) => {
    const [student] = await linkedStudents(tx, school.id, parentPhone, data.studentId);
    if (!student) return null;
    const [owed] = await tx
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, school.id), eq(ledgerEntries.studentId, student.id)));
    const balance = Number(owed?.total ?? 0);
    if (balance <= 0) throw new DomainError("nothing_owed", "Nothing is owed for this child.", "amount");
    if (data.amount > balance)
      throw new DomainError(
        "amount_over_balance",
        `Pay at most ${formatMoney(balance, school.currencyCode)}, the amount owed.`,
        "amount",
      );
    return student;
  });
}

/** A family payment: the children and their amounts (blank or 0 leaves a child out), and the payer's phone. */
function familySchemaFor(school: { countryCode: string; currencyCode: string }) {
  const single = requestSchemaFor(school);
  return z.object({
    shares: z
      .array(z.object({ studentId: z.string().uuid(), amount: z.string() }))
      .min(1)
      .max(20)
      .transform((rows, ctx) => {
        const out: FamilyShare[] = [];
        for (const r of rows) {
          if (r.amount.trim() === "" || parseMoney(r.amount, school.currencyCode) === 0) continue;
          const minor = parseMoney(r.amount, school.currencyCode);
          if (minor === null) {
            ctx.addIssue({
              code: "custom",
              message: "Enter each amount like 450 or 450.50.",
              path: ["amount"],
            });
            return z.NEVER;
          }
          if (out.some((o) => o.studentId === r.studentId)) continue;
          out.push({ studentId: r.studentId, amount: minor });
        }
        if (out.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "Enter an amount for at least one child.",
            path: ["amount"],
          });
          return z.NEVER;
        }
        return out;
      }),
    phone: single.shape.phone,
    network: single.shape.network,
    idempotencyKey: single.shape.idempotencyKey,
  });
}

/**
 * A parent pays several children's fees with one Mobile Money prompt (2026-11-18). Each child must be linked to the
 * parent's number and owe at least their share. The provider is asked for the total; once it confirms, each child gets
 * their own receipt (settled exactly as other prompts).
 */
export async function requestParentFamilyPayment(
  database: Database,
  parentPhone: string,
  slug: string,
  input: unknown,
  deps: MobileMoneyDeps = {},
): Promise<RequestOutcome> {
  const school = await schoolBySlug(database, slug);
  if (!school) throw new DomainError("student_not_found", "Student not found.");
  const setup = await parentPaymentSetup(database, school, deps);
  const provider = await parentSchoolProvider(database, school, deps);
  if (!setup.enabled || !provider)
    throw new DomainError("mobile_money_off", "This school does not take payments online yet.");
  const data = familySchemaFor(school).parse(input);
  const total = data.shares.reduce((sum, sh) => sum + sh.amount, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000)
    throw new DomainError("amount_too_large", "That total is too large for one prompt.", "amount");
  const origin: Origin = {
    tenantId: school.id,
    tenantName: school.name,
    currency: school.currencyCode,
    timezone: school.timezone,
    userId: null,
    by: "parent",
  };
  const first = data.shares[0]!;
  const request: RequestData = {
    studentId: first.studentId,
    amount: total,
    phone: data.phone,
    network: data.network,
    idempotencyKey: data.idempotencyKey,
  };
  const loadChildren = async (tx: Transaction): Promise<PromptStudent | null> => {
    const linked = new Map((await linkedStudents(tx, school.id, parentPhone)).map((st) => [st.id, st]));
    for (const share of data.shares) {
      const child = linked.get(share.studentId);
      if (!child) return null;
      const [owed] = await tx
        .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, school.id), eq(ledgerEntries.studentId, child.id)));
      const balance = Number(owed?.total ?? 0);
      const name = `${child.firstName} ${child.lastName}`;
      if (balance <= 0) throw new DomainError("nothing_owed", `Nothing is owed for ${name}.`, "amount");
      if (share.amount > balance)
        throw new DomainError(
          "amount_over_balance",
          `Pay at most ${formatMoney(balance, school.currencyCode)} for ${name}, the amount owed.`,
          "amount",
        );
    }
    return linked.get(first.studentId) ?? null;
  };
  if (data.shares.length === 1) return sendPrompt(database, origin, request, provider, deps, loadChildren);
  return sendPrompt(database, origin, request, provider, deps, loadChildren, {
    shares: data.shares,
    payerMessage: `School fees for ${data.shares.length} children, ${school.name}`,
  });
}

/** A parent asks whether their payment went through; the provider is asked, as for staff. */
export async function checkParentMobileMoneyRequest(
  database: Database,
  parentPhone: string,
  slug: string,
  requestId: string,
  deps: MobileMoneyDeps = {},
): Promise<CheckOutcome | null> {
  if (!z.string().uuid().safeParse(requestId).success) return null;
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  const actor: Actor = { tenantId: school.id, timezone: school.timezone, userId: null };
  const request = await withTenant(database, actorScope(actor), async (tx) => {
    const [row] = await tx
      .select()
      .from(mobileMoneyRequests)
      .where(and(eq(mobileMoneyRequests.tenantId, school.id), eq(mobileMoneyRequests.id, requestId)));
    if (!row || (await linkedStudents(tx, school.id, parentPhone, row.studentId)).length === 0) return null;
    return row;
  });
  if (!request) return null;
  if (!OPEN.includes(request.status)) return outcome(request);
  const provider = providerOfRequest(request, deps);
  if (!provider) return outcome(request);
  try {
    return await settleRequest(database, actor, request, provider, deps.now ?? new Date());
  } catch (error) {
    if (error instanceof ProviderError) return outcome(request);
    throw error;
  }
}

/** What a parent sees of a child's online payments (PAY-05), newest first, with the receipt once paid. */
export interface ParentPaymentAttempt {
  id: string;
  status: MobileMoneyRequestStatus;
  statusReason: string | null;
  /** This child's part (the whole amount, unless it was a family payment). */
  amountPesewas: number;
  /** What the payer approved: more than this child's part for a family payment. */
  totalPesewas: number;
  /** Paid with one prompt for several children. */
  family: boolean;
  msisdn: string;
  createdAt: Date;
  receiptNumber: string | null;
  paymentId: string | null;
}

/** A linked child's online payment attempts for the parent view, or null when the number does not reach them. */
export async function listParentPaymentAttempts(
  database: Database,
  parentPhone: string,
  slug: string,
  studentId: string,
): Promise<ParentPaymentAttempt[] | null> {
  if (!z.string().uuid().safeParse(studentId).success) return null;
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    if ((await linkedStudents(tx, school.id, parentPhone, studentId)).length === 0) return null;
    return readParentPaymentAttempts(tx, school.id, studentId);
  });
}

export async function readParentPaymentAttempts(
  tx: Transaction,
  tenantId: string,
  studentId: string,
  limit = 5,
): Promise<ParentPaymentAttempt[]> {
  // A family payment shows on each child's page with that child's share and receipt.
  const share = alias(mobileMoneyRequestShares, "share");
  const rows = await tx
    .select({
      id: mobileMoneyRequests.id,
      status: mobileMoneyRequests.status,
      statusReason: mobileMoneyRequests.statusReason,
      amountPesewas:
        sql<number>`coalesce(${share.amountPesewas}, ${mobileMoneyRequests.amountPesewas})`.mapWith(Number),
      totalPesewas: mobileMoneyRequests.amountPesewas,
      family: sql<boolean>`${share.id} is not null`,
      msisdn: mobileMoneyRequests.msisdn,
      createdAt: mobileMoneyRequests.createdAt,
      receiptNumber: payments.receiptNumber,
      paymentId: sql<string | null>`coalesce(${share.paymentId}, ${mobileMoneyRequests.paymentId})`,
    })
    .from(mobileMoneyRequests)
    .leftJoin(share, and(eq(share.requestId, mobileMoneyRequests.id), eq(share.studentId, studentId)))
    .leftJoin(payments, sql`${payments.id} = coalesce(${share.paymentId}, ${mobileMoneyRequests.paymentId})`)
    .where(
      and(
        eq(mobileMoneyRequests.tenantId, tenantId),
        sql`(${mobileMoneyRequests.studentId} = ${studentId} or ${share.id} is not null)`,
      ),
    )
    .orderBy(desc(mobileMoneyRequests.createdAt))
    .limit(limit);
  return rows;
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
  assertAllowed(ctx, "payments.record");
  const request = await loadRequest(database, ctx, requestId);
  if (!request) throw new DomainError("request_not_found", "Mobile Money request not found.");
  if (!OPEN.includes(request.status)) return outcome(request);

  const provider = providerOfRequest(request, deps);
  if (!provider)
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
    tenantId: actor.tenantId,
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
    return `The network reported a payment in ${status.currency}, not ${row.currency}.`;
  if (!Number.isSafeInteger(status.amountPesewas) || status.amountPesewas <= 0)
    return "The network reported an invalid amount.";
  if (status.amountPesewas !== row.amountPesewas)
    return `The network reported ${formatMoney(status.amountPesewas, row.currency)}, not the ${formatMoney(row.amountPesewas, row.currency)} requested.`;
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
        const paidOn = todayIn(actor.timezone, completed);
        const shares = await tx
          .select()
          .from(mobileMoneyRequestShares)
          .where(
            and(
              eq(mobileMoneyRequestShares.tenantId, actor.tenantId),
              eq(mobileMoneyRequestShares.requestId, row.id),
            ),
          );
        let paymentId: string;
        if (shares.length === 0) {
          ({ paymentId } = await insertPayment(tx, {
            tenantId: actor.tenantId,
            studentId: row.studentId,
            amountPesewas: row.amountPesewas,
            method: "mobile_money",
            reference: status.transactionId,
            payerName: null,
            paidOn,
            idempotencyKey: `mobile_money:${row.id}`,
            recordedByUserId: actor.userId,
          }));
        } else {
          // A family payment: one receipt per child, in this transaction, for exactly each child's share.
          const paid = new Map<string, string>();
          for (const share of shares) {
            const receipt = await insertPayment(tx, {
              tenantId: actor.tenantId,
              studentId: share.studentId,
              amountPesewas: share.amountPesewas,
              method: "mobile_money",
              reference: status.transactionId,
              payerName: null,
              paidOn,
              idempotencyKey: `mobile_money:${row.id}:${share.studentId}`,
              recordedByUserId: actor.userId,
            });
            await tx
              .update(mobileMoneyRequestShares)
              .set({ paymentId: receipt.paymentId })
              .where(eq(mobileMoneyRequestShares.id, share.id));
            paid.set(share.studentId, receipt.paymentId);
          }
          paymentId = paid.get(row.studentId)!;
        }
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
  assertAllowed(ctx, "fees.view");
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
  assertAllowed(ctx, "fees.view");
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
  assertAllowed(ctx, "payments.record");
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
