import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readBillingState } from "../billing/state";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Transaction } from "../db/client";
import { ledgerEntries, students, tenants } from "../db/schema";
import { DomainError } from "../errors";
import { contactsFor } from "../fees/owing";
import { enqueue, smsSegmentsFor } from "../notifications/outbox";

/**
 * "Fees billed" SMS (COM-01, invoice issued): when the school bills a term and asks for it, each family
 * billed gets the new balance and a link to the parent view. Queued in the billing transaction, so the
 * messages go out only if the charges are saved. A fee payer's number is used first (SIS-04). Essential
 * finance messages, so a guardian's announcement opt-out does not apply. Never sent for demo schools.
 */
export async function queueBillingNotices(
  tx: Transaction,
  tenantId: string,
  studentIds: string[],
  termLabel: string,
): Promise<number> {
  if (studentIds.length === 0) return 0;
  const [tenant] = await tx
    .select({
      id: tenants.id,
      name: tenants.name,
      timezone: tenants.timezone,
      isDemo: tenants.isDemo,
      currencyCode: tenants.currencyCode,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant || tenant.isDemo) return 0;
  if ((await readBillingState(tx, tenant)).state === "limited")
    throw new DomainError(
      "sms_paused",
      "SMS to families are paused while an EduBridge invoice is overdue. Bill without SMS.",
    );
  const contacts = await contactsFor(tx, { tenant }, studentIds);
  const reach = studentIds.filter((id) => contacts.get(id)?.phone);
  if (reach.length === 0) return 0;
  const names = await tx
    .select({ id: students.id, firstName: students.firstName })
    .from(students)
    .where(and(eq(students.tenantId, tenant.id), inArray(students.id, reach)));
  const balances = new Map(
    (
      await tx
        .select({
          studentId: ledgerEntries.studentId,
          total: sql<string>`sum(${ledgerEntries.amountPesewas})`,
        })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, tenant.id), inArray(ledgerEntries.studentId, reach)))
        .groupBy(ledgerEntries.studentId)
    ).map((b) => [b.studentId, Number(b.total)]),
  );
  const rows = names.map((n) => ({
    ...n,
    payload: {
      schoolName: tenant.name,
      studentFirstName: n.firstName,
      termLabel,
      balancePesewas: Number(balances.get(n.id) ?? 0),
      currency: tenant.currencyCode,
    },
  }));
  // Counted in segments, before anything is queued: all families are told, or none.
  const need = rows.reduce((sum, r) => sum + smsSegmentsFor("fees_billed", r.payload), 0);
  const left = await smsAllowance(tx, tenant.id, tenant.timezone);
  if (left !== null && left < need)
    throw new DomainError(
      "sms_limit",
      `Telling every family needs ${need} SMS, and your plan has ${left} left this month. Bill without SMS.`,
    );
  for (const row of rows) {
    const outboxId = await enqueue(tx, {
      channel: "sms",
      recipient: contacts.get(row.id)!.phone!,
      template: "fees_billed",
      payload: row.payload,
    });
    await recordSmsUsage(tx, tenant.id, "fees_billed", outboxId, row.id);
  }
  return rows.length;
}
