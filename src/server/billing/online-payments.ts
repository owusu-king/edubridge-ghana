import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { subscriptionInvoices, subscriptionPayments, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Paying an EduBridge invoice online (SUB-04), into EduBridge's own Paystack account (D-R3-5), never a
 * school's subaccount. Industry practice for hosted checkout: the browser is sent to the provider's page;
 * whatever comes back (the redirect, or the signed webhook) only names the reference, and the outcome is
 * read from the provider's verify endpoint with EduBridge's secret key. The amount and currency must equal
 * the invoice; the invoice is then marked paid once, in the database (subscription_invoice_paid_online).
 */

export interface VerifiedCharge {
  status: "success" | "failed" | "pending";
  amountPesewas: number;
  currency: string;
  paidAt: Date | null;
  providerReference: string | null;
  channel: string | null;
}

export interface InvoicePaymentProvider {
  name: "paystack" | "mock";
  currencies: readonly string[];
  initialize(input: {
    reference: string;
    amountPesewas: number;
    currency: string;
    email: string;
    callbackUrl: string;
  }): Promise<{ authorizationUrl: string }>;
  /** `expected` is used only by the test-mode mock, which has no provider to ask. */
  verify(reference: string, expected: { amountPesewas: number; currency: string }): Promise<VerifiedCharge>;
  /** Whether a webhook body was signed by the provider. */
  verifyWebhook(rawBody: string, signature: string | null): boolean;
}

export class PaymentProviderError extends Error {}

/** Paystack with EduBridge's own secret key (EDUBRIDGE_PAYSTACK_SECRET_KEY). */
export function edubridgePaystack(config: {
  secretKey: string;
  currencies: readonly string[];
  baseUrl?: string;
}): InvoicePaymentProvider {
  const base = config.baseUrl ?? "https://api.paystack.co";
  const call = async (path: string, init?: { method: "POST"; body: unknown }) => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: init ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaymentProviderError("Paystack could not be reached. Try again in a moment.");
    }
    const json = (await response.json().catch(() => null)) as {
      status?: boolean;
      data?: Record<string, unknown> | null;
    } | null;
    if (!response.ok || !json?.status || !json.data)
      throw new PaymentProviderError("Paystack did not accept the request.");
    return json.data;
  };
  return {
    name: "paystack",
    currencies: config.currencies,
    async initialize(input) {
      const data = await call("/transaction/initialize", {
        method: "POST",
        body: {
          email: input.email,
          amount: input.amountPesewas,
          currency: input.currency,
          reference: input.reference,
          callback_url: input.callbackUrl,
          metadata: { purpose: "edubridge_invoice" },
        },
      });
      const url = data.authorization_url;
      if (typeof url !== "string" || !url.startsWith("https://"))
        throw new PaymentProviderError("Paystack did not return a payment page.");
      return { authorizationUrl: url };
    },
    async verify(reference) {
      const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
      const status =
        data.status === "success"
          ? "success"
          : data.status === "failed" || data.status === "abandoned"
            ? "failed"
            : "pending";
      return {
        status,
        amountPesewas: Number(data.amount ?? 0),
        currency: String(data.currency ?? ""),
        paidAt: typeof data.paid_at === "string" ? new Date(data.paid_at) : null,
        providerReference: data.id !== undefined ? String(data.id) : null,
        channel: typeof data.channel === "string" ? data.channel.slice(0, 40) : null,
      };
    },
    verifyWebhook(rawBody, signature) {
      if (!signature) return false;
      const expected = createHmac("sha512", config.secretKey).update(rawBody).digest("hex");
      return (
        signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      );
    },
  };
}

/**
 * Test mode (development and end-to-end runs only): no money moves. The "payment page" is the return
 * address itself, and verification reports the charge as paid in full.
 */
export function mockInvoicePayments(): InvoicePaymentProvider {
  return {
    name: "mock",
    currencies: ["GHS", "KES", "NGN", "UGX", "TZS", "RWF", "XOF", "ZAR", "USD"],
    async initialize(input) {
      const url = new URL(input.callbackUrl);
      url.searchParams.set("reference", input.reference);
      return { authorizationUrl: url.toString() };
    },
    async verify(reference, expected) {
      return {
        status: "success",
        amountPesewas: expected.amountPesewas,
        currency: expected.currency,
        paidAt: new Date(),
        providerReference: `mock-${reference.slice(-8)}`,
        channel: "test",
      };
    },
    verifyWebhook: () => false,
  };
}

/** The provider this deployment uses for EduBridge invoices, or null when online payment is off. */
export function invoicePaymentsFromEnv(env: NodeJS.ProcessEnv = process.env): InvoicePaymentProvider | null {
  const key = env.EDUBRIDGE_PAYSTACK_SECRET_KEY?.trim();
  // Live money only once the founder has approved it, as for schools' Mobile Money.
  if (key?.startsWith("sk_live_") && env.EDUBRIDGE_PAYSTACK_ALLOW_LIVE !== "true") return null;
  if (key)
    return edubridgePaystack({
      secretKey: key,
      currencies: (env.EDUBRIDGE_PAYSTACK_CURRENCIES ?? "GHS").split(",").map((c) => c.trim().toUpperCase()),
    });
  if (env.NODE_ENV !== "production" || env.EDUBRIDGE_PAYMENTS_PROVIDER === "mock")
    return mockInvoicePayments();
  return null;
}

const REFERENCE = /^EBI\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/;

export function parseInvoicePaymentReference(
  reference: string,
): { tenantId: string; paymentId: string } | null {
  const m = REFERENCE.exec(reference);
  if (!m || !z.string().uuid().safeParse(m[1]).success || !z.string().uuid().safeParse(m[2]).success)
    return null;
  return { tenantId: m[1]!, paymentId: m[2]! };
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Whether this member may pay this school's invoices online, and in which currencies. */
export function canPayOnline(ctx: TenantContext, provider: InvoicePaymentProvider | null): boolean {
  return Boolean(
    provider &&
    allowed(ctx, "plan.view") &&
    !ctx.support &&
    (!ctx.tenant.isDemo || provider.name === "mock") &&
    provider.currencies.includes(ctx.tenant.currencyCode),
  );
}

/** Starts paying an open invoice: records the attempt and returns the provider's payment page. */
export async function startInvoicePayment(
  database: Database,
  ctx: TenantContext,
  invoiceId: string,
  options: { provider: InvoicePaymentProvider | null; callbackUrl: string },
): Promise<{ authorizationUrl: string; reference: string }> {
  assertAllowed(ctx, "plan.view");
  const provider = options.provider;
  if (!provider || !canPayOnline(ctx, provider))
    throw new DomainError("online_payment_unavailable", "Online payment is not available for this school.");
  if (!z.string().uuid().safeParse(invoiceId).success)
    throw new DomainError("not_found", "Invoice not found.");
  const { payment, email } = await withTenant(database, scope(ctx), async (tx) => {
    const [invoice] = await tx
      .select()
      .from(subscriptionInvoices)
      .where(and(eq(subscriptionInvoices.tenantId, ctx.tenant.id), eq(subscriptionInvoices.id, invoiceId)));
    if (!invoice) throw new DomainError("not_found", "Invoice not found.");
    if (invoice.paidOn || invoice.voidedAt)
      throw new DomainError(
        "already_settled",
        `This invoice is already ${invoice.paidOn ? "paid" : "void"}.`,
      );
    const [me] = await tx.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
    const id = randomUUID();
    const [row] = await tx
      .insert(subscriptionPayments)
      .values({
        id,
        tenantId: ctx.tenant.id,
        invoiceId: invoice.id,
        reference: `EBI.${ctx.tenant.id}.${id}`,
        provider: provider.name,
        amountPesewas: invoice.totalPesewas,
        currencyCode: invoice.currencyCode,
        initiatedByUserId: ctx.userId,
      })
      .returning();
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subscription_payment.started",
      entityType: "subscription_invoice",
      entityId: invoice.id,
      metadata: { invoiceNumber: invoice.invoiceNumber, reference: row!.reference, provider: provider.name },
    });
    return { payment: row!, email: me!.email };
  });
  try {
    const page = await provider.initialize({
      reference: payment.reference,
      amountPesewas: payment.amountPesewas,
      currency: payment.currencyCode,
      email,
      callbackUrl: options.callbackUrl,
    });
    return { authorizationUrl: page.authorizationUrl, reference: payment.reference };
  } catch (error) {
    await withTenant(database, scope(ctx), (tx) =>
      tx
        .update(subscriptionPayments)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(subscriptionPayments.id, payment.id)),
    );
    if (error instanceof PaymentProviderError) throw new DomainError("provider_error", error.message);
    throw error;
  }
}

export type PaymentOutcome =
  | { outcome: "paid"; invoiceNumber: string }
  | { outcome: "pending" }
  | { outcome: "failed"; reason: string }
  /** Paid, but the invoice had been settled another way meanwhile: EduBridge refunds or credits it. */
  | { outcome: "duplicate"; invoiceNumber: string }
  | { outcome: "not_found" };

/**
 * Confirms a payment by asking the provider (from the return page or the webhook). Idempotent: a payment
 * already recorded returns "paid" again without touching anything.
 */
export async function confirmInvoicePayment(
  database: Database,
  reference: string,
  options: { provider: InvoicePaymentProvider | null; actorUserId?: string | null },
): Promise<PaymentOutcome> {
  const parsed = parseInvoicePaymentReference(reference);
  if (!parsed || !options.provider) return { outcome: "not_found" };
  const provider = options.provider;
  return withTenant(
    database,
    { tenantId: parsed.tenantId, userId: options.actorUserId ?? "" },
    async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"invoice-payment:" + reference}, 0))`,
      );
      const [payment] = await tx
        .select()
        .from(subscriptionPayments)
        .where(
          and(
            eq(subscriptionPayments.tenantId, parsed.tenantId),
            eq(subscriptionPayments.reference, reference),
          ),
        );
      if (!payment || payment.provider !== provider.name) return { outcome: "not_found" } as const;
      const [invoice] = await tx
        .select({
          number: subscriptionInvoices.invoiceNumber,
          paidOn: subscriptionInvoices.paidOn,
          paymentReference: subscriptionInvoices.paymentReference,
          voidedAt: subscriptionInvoices.voidedAt,
        })
        .from(subscriptionInvoices)
        .where(eq(subscriptionInvoices.id, payment.invoiceId));
      const settledElsewhere =
        Boolean(invoice!.voidedAt) ||
        (invoice!.paidOn !== null && invoice!.paymentReference !== `Online ${reference}`);
      if (payment.status === "succeeded") {
        if (settledElsewhere) return { outcome: "duplicate", invoiceNumber: invoice!.number } as const;
        await tx.execute(sql`select subscription_invoice_paid_online(${payment.id})`);
        return { outcome: "paid", invoiceNumber: invoice!.number } as const;
      }
      if (payment.status === "failed")
        return { outcome: "failed", reason: "This payment did not go through." } as const;
      let charge: VerifiedCharge;
      try {
        charge = await provider.verify(reference, {
          amountPesewas: payment.amountPesewas,
          currency: payment.currencyCode,
        });
      } catch {
        return { outcome: "pending" } as const;
      }
      if (charge.status === "pending") return { outcome: "pending" } as const;
      const matches =
        charge.amountPesewas === payment.amountPesewas && charge.currency === payment.currencyCode;
      if (charge.status === "failed" || !matches) {
        await tx
          .update(subscriptionPayments)
          .set({ status: "failed", providerReference: charge.providerReference, updatedAt: new Date() })
          .where(eq(subscriptionPayments.id, payment.id));
        await recordAudit(tx, {
          tenantId: payment.tenantId,
          actorUserId: options.actorUserId ?? null,
          action: matches ? "subscription_payment.failed" : "subscription_payment.mismatch",
          entityType: "subscription_invoice",
          entityId: payment.invoiceId,
          metadata: {
            reference,
            expected: { amount: payment.amountPesewas, currency: payment.currencyCode },
            reported: { amount: charge.amountPesewas, currency: charge.currency },
          },
        });
        return {
          outcome: "failed",
          reason: matches
            ? "The payment did not go through."
            : "The amount paid did not match the invoice. EduBridge will be in touch.",
        } as const;
      }
      await tx
        .update(subscriptionPayments)
        .set({
          status: "succeeded",
          paidAt: charge.paidAt ?? new Date(),
          providerReference: charge.providerReference,
          channel: charge.channel,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionPayments.id, payment.id));
      if (settledElsewhere) {
        await recordAudit(tx, {
          tenantId: payment.tenantId,
          actorUserId: options.actorUserId ?? null,
          action: "subscription_payment.duplicate",
          entityType: "subscription_invoice",
          entityId: payment.invoiceId,
          metadata: {
            invoiceNumber: invoice!.number,
            reference,
            providerReference: charge.providerReference,
          },
        });
        return { outcome: "duplicate", invoiceNumber: invoice!.number } as const;
      }
      await tx.execute(sql`select subscription_invoice_paid_online(${payment.id})`);
      await recordAudit(tx, {
        tenantId: payment.tenantId,
        actorUserId: options.actorUserId ?? null,
        action: "subscription_invoice.paid_online",
        entityType: "subscription_invoice",
        entityId: payment.invoiceId,
        metadata: {
          invoiceNumber: invoice!.number,
          reference,
          provider: provider.name,
          providerReference: charge.providerReference,
          amountPesewas: payment.amountPesewas,
        },
      });
      return { outcome: "paid", invoiceNumber: invoice!.number } as const;
    },
  );
}

/** The reference in a Paystack webhook for a successful charge, if it is one of EduBridge's invoices. */
export function invoiceReferenceFromWebhook(body: unknown): string | null {
  const event = body as { event?: string; data?: { reference?: unknown } } | null;
  if (event?.event !== "charge.success" || typeof event.data?.reference !== "string") return null;
  return parseInvoicePaymentReference(event.data.reference) ? event.data.reference : null;
}
