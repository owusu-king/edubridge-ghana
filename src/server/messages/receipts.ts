import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { readBillingState } from "../billing/state";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Transaction } from "../db/client";
import { ledgerEntries, students, tenants } from "../db/schema";
import { contactsFor } from "../fees/owing";
import { enqueue } from "../notifications/outbox";
import { readPreferences } from "../tenancy/preferences";

/**
 * An SMS to the family when a payment is recorded (COM-01), if the school turned it on: the amount, the
 * receipt number and the balance after it. Queued in the payment's own transaction, so it goes out if and
 * only if the payment is saved. Skipped (the payment is still recorded) for demo schools, while SMS are
 * paused for an overdue EduBridge invoice, over the plan's monthly SMS limit, or without a guardian phone.
 */
export async function queuePaymentReceipt(
  tx: Transaction,
  payment: { tenantId: string; studentId: string; amountPesewas: number; receiptNumber: string },
): Promise<boolean> {
  const prefs = await readPreferences(tx, payment.tenantId);
  if (!prefs.paymentReceiptSms) return false;
  const [tenant] = await tx
    .select({ id: tenants.id, name: tenants.name, timezone: tenants.timezone, isDemo: tenants.isDemo })
    .from(tenants)
    .where(eq(tenants.id, payment.tenantId));
  if (!tenant || tenant.isDemo) return false;
  if ((await readBillingState(tx, tenant)).state === "limited") return false;
  const allowance = await smsAllowance(tx, tenant.id, tenant.timezone);
  if (allowance !== null && allowance <= 0) return false;
  const contact = (await contactsFor(tx, { tenant }, [payment.studentId])).get(payment.studentId);
  if (!contact?.phone) return false;
  const [student] = await tx
    .select({ firstName: students.firstName })
    .from(students)
    .where(eq(students.id, payment.studentId));
  const [balance] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tenant.id), eq(ledgerEntries.studentId, payment.studentId)));
  const outboxId = await enqueue(tx, {
    channel: "sms",
    recipient: contact.phone,
    template: "payment_receipt",
    payload: {
      schoolName: tenant.name,
      studentFirstName: student?.firstName ?? "your child",
      amountPesewas: payment.amountPesewas,
      receiptNumber: payment.receiptNumber,
      balancePesewas: Number(balance?.total ?? 0),
    },
  });
  await recordSmsUsage(tx, tenant.id, "payment_receipt", outboxId, payment.studentId);
  return true;
}
