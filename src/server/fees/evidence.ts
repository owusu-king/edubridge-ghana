import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { payments } from "../db/schema";
import { DomainError } from "../errors";
import { listFiles, markRemoved, readStoredFile, storeFile } from "../files/service";
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";

/**
 * Evidence for a payment (FIN-07): a bank slip, a cheque image or a Mobile Money screenshot, attached
 * after the payment is recorded. The payment itself never changes. Seen by finance staff within their
 * campuses; every download is recorded; removing one (a wrong file) is for the Proprietor and is audited.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

async function loadPayment(tx: Transaction, ctx: TenantContext, paymentId: string) {
  if (!z.string().uuid().safeParse(paymentId).success) return null;
  const [row] = await tx
    .select({ id: payments.id, studentId: payments.studentId, receiptNumber: payments.receiptNumber })
    .from(payments)
    .where(and(eq(payments.tenantId, ctx.tenant.id), eq(payments.id, paymentId)));
  if (!row || !(await loadFinanceStudent(tx, ctx, row.studentId))) return null;
  return row;
}

async function requirePayment(tx: Transaction, ctx: TenantContext, paymentId: string) {
  const payment = await loadPayment(tx, ctx, paymentId);
  if (!payment) throw new DomainError("payment_not_found", "Payment not found.");
  return payment;
}

export async function addPaymentEvidence(
  database: Database,
  ctx: TenantContext,
  paymentId: string,
  file: { filename: string; bytes: Buffer },
): Promise<string> {
  assertAllowed(ctx, "payments.record");
  return withTenant(database, scope(ctx), async (tx) => {
    const payment = await requirePayment(tx, ctx, paymentId);
    const id = await storeFile(tx, ctx, { purpose: "payment_evidence", ownerId: payment.id, ...file });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payment.evidence_added",
      entityType: "payment",
      entityId: payment.id,
      metadata: { fileId: id, filename: file.filename.slice(0, 120), receiptNumber: payment.receiptNumber },
    });
    return id;
  });
}

export async function listPaymentEvidence(database: Database, ctx: TenantContext, paymentId: string) {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const payment = await loadPayment(tx, ctx, paymentId);
    return payment ? listFiles(tx, ctx.tenant.id, "payment_evidence", payment.id) : [];
  });
}

/** One evidence file, or null; the download is recorded. */
export async function downloadPaymentEvidence(
  database: Database,
  ctx: TenantContext,
  paymentId: string,
  fileId: string,
) {
  assertAllowed(ctx, "fees.view");
  if (!z.string().uuid().safeParse(fileId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const payment = await loadPayment(tx, ctx, paymentId);
    if (!payment) return null;
    const file = await readStoredFile(tx, ctx.tenant.id, fileId, "payment_evidence");
    if (!file || file.ownerId !== payment.id) return null;
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payment.evidence_downloaded",
      entityType: "payment",
      entityId: payment.id,
      metadata: { fileId },
    });
    return file;
  });
}

export async function removePaymentEvidence(
  database: Database,
  ctx: TenantContext,
  paymentId: string,
  fileId: string,
): Promise<void> {
  assertAllowed(ctx, "payments.void");
  await withTenant(database, scope(ctx), async (tx) => {
    const payment = await requirePayment(tx, ctx, paymentId);
    const removed = z.string().uuid().safeParse(fileId).success
      ? await markRemoved(tx, ctx, fileId, "payment_evidence")
      : null;
    if (!removed || removed.ownerId !== payment.id) throw new DomainError("not_found", "File not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payment.evidence_removed",
      entityType: "payment",
      entityId: payment.id,
      metadata: { fileId, filename: removed.filename },
    });
  });
}
