import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parseMoney } from "../../lib/money";
import { todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  ledgerEntries,
  memberships,
  PAYMENT_METHODS,
  refunds,
  students,
  tenantCounters,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";
import { METHOD_LABELS } from "./payments";

/**
 * Refunds of a family's credit (FIN-10, D-05): requested, approved, then paid out. When the school has more
 * than one finance user (Proprietor or Accountant), the person who requested a refund cannot approve it.
 * Paying it out posts a `refund` entry on the student's account (taking the credit back to what is left)
 * with the school's next refund number. A refund can never exceed the credit, and nothing is deleted.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

async function balanceOf(tx: Transaction, tenantId: string, studentId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.studentId, studentId)));
  return Number(row?.total ?? 0);
}

/** Credit not already promised to an open refund (positive pesewas). */
async function availableCredit(
  tx: Transaction,
  tenantId: string,
  studentId: string,
  except?: string,
): Promise<number> {
  const credit = -(await balanceOf(tx, tenantId, studentId));
  const [open] = await tx
    .select({ total: sql<string>`coalesce(sum(${refunds.amountPesewas}), 0)` })
    .from(refunds)
    .where(
      and(
        eq(refunds.tenantId, tenantId),
        eq(refunds.studentId, studentId),
        inArray(refunds.status, ["requested", "approved"]),
        except ? sql`${refunds.id} <> ${except}` : undefined,
      ),
    );
  return credit - Number(open?.total ?? 0);
}

async function financeUsers(tx: Transaction, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${memberships.userId})::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        sql`${memberships.roles} && array['owner', 'bursar']::text[]`,
      ),
    );
  return row?.n ?? 0;
}

const requestSchema = (currency: string) =>
  z.object({
    amount: z.string().transform((text, issue) => {
      const minor = parseMoney(text, currency);
      if (minor === null || minor === 0) {
        issue.addIssue({ code: "custom", message: "Enter the amount to refund, like 200." });
        return z.NEVER;
      }
      return minor;
    }),
    reason: z
      .string()
      .trim()
      .min(3, "Say why the money is refunded.")
      .max(300, "Use 300 characters or fewer."),
  });

export async function requestRefund(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "fees.refund");
  const data = requestSchema(ctx.tenant.currencyCode).parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const student = await loadFinanceStudent(tx, ctx, studentId);
    if (!student) throw new DomainError("student_not_found", "Student not found.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"refund:" + student.id}, 0))`);
    const available = await availableCredit(tx, ctx.tenant.id, student.id);
    if (data.amount > available)
      throw new DomainError(
        "refund_exceeds_credit",
        available > 0
          ? "That is more than the family's credit (less any refunds already requested)."
          : "The family has no credit to refund.",
        "amount",
      );
    const [row] = await tx
      .insert(refunds)
      .values({
        tenantId: ctx.tenant.id,
        studentId: student.id,
        amountPesewas: data.amount,
        reason: data.reason,
        requestedByUserId: ctx.userId,
      })
      .returning({ id: refunds.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "refund.requested",
      entityType: "student",
      entityId: student.id,
      metadata: { refundId: row!.id, amountPesewas: data.amount, reason: data.reason },
    });
    return row!.id;
  });
}

async function loadRefund(tx: Transaction, ctx: TenantContext, id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new DomainError("refund_not_found", "Refund not found.");
  const [row] = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.tenantId, ctx.tenant.id), eq(refunds.id, id)))
    .for("update");
  if (!row || !(await loadFinanceStudent(tx, ctx, row.studentId)))
    throw new DomainError("refund_not_found", "Refund not found.");
  return row;
}

/** Approves or rejects a requested refund; a second finance user must decide when the school has one. */
export async function decideRefund(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "fees.refund");
  const data = z
    .object({
      approve: z.boolean(),
      note: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().max(300).optional()),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const refund = await loadRefund(tx, ctx, id);
    if (refund.status !== "requested")
      throw new DomainError("refund_decided", "This refund has already been decided.");
    if (refund.requestedByUserId === ctx.userId && (await financeUsers(tx, ctx.tenant.id)) > 1)
      throw new DomainError(
        "two_person_rule",
        "Another finance user (the Proprietor or an Accountant) must approve a refund you requested.",
      );
    await tx
      .update(refunds)
      .set({
        status: data.approve ? "approved" : "rejected",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: data.note ?? null,
      })
      .where(eq(refunds.id, refund.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: data.approve ? "refund.approved" : "refund.rejected",
      entityType: "student",
      entityId: refund.studentId,
      metadata: { refundId: refund.id, amountPesewas: refund.amountPesewas, note: data.note ?? null },
    });
  });
}

const paySchema = z
  .object({
    method: z.enum(PAYMENT_METHODS, { message: "Choose how the money was paid back." }),
    reference: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().max(60).optional()),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."),
  })
  .refine((v) => v.method === "cash" || v.reference, {
    message: "Enter the transfer or cheque number.",
    path: ["reference"],
  });

/** Records the money paid back: the refund entry on the account, with the next refund number. */
export async function payRefund(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ refundNumber: string }> {
  assertAllowed(ctx, "fees.refund");
  const data = paySchema.parse(input);
  if (data.paidOn > todayIn(ctx.tenant.timezone))
    throw new DomainError("future_date", "The date cannot be in the future.", "paidOn");
  return withTenant(database, scope(ctx), async (tx) => {
    const refund = await loadRefund(tx, ctx, id);
    if (refund.status !== "approved")
      throw new DomainError("refund_not_approved", "Only an approved refund can be paid.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"refund:" + refund.studentId}, 0))`);
    // The credit may have been used meanwhile (e.g. new charges billed): never refund more than is there.
    if (refund.amountPesewas > (await availableCredit(tx, ctx.tenant.id, refund.studentId, refund.id)))
      throw new DomainError(
        "refund_exceeds_credit",
        "The family's credit is now less than this refund. Cancel it and request a new one.",
      );
    const [counter] = await tx
      .insert(tenantCounters)
      .values({ tenantId: ctx.tenant.id, key: "refund_number", value: 1 })
      .onConflictDoUpdate({
        target: [tenantCounters.tenantId, tenantCounters.key],
        set: { value: sql`${tenantCounters.value} + 1` },
      })
      .returning({ value: tenantCounters.value });
    const refundNumber = `RF${String(counter!.value).padStart(6, "0")}`;
    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        tenantId: ctx.tenant.id,
        studentId: refund.studentId,
        kind: "refund",
        description: `Refund ${refundNumber} (${METHOD_LABELS[data.method]})`,
        amountPesewas: refund.amountPesewas,
        effectiveOn: data.paidOn,
        recordedByUserId: ctx.userId,
      })
      .returning({ id: ledgerEntries.id });
    await tx
      .update(refunds)
      .set({
        status: "paid",
        refundNumber,
        paidByUserId: ctx.userId,
        paidOn: data.paidOn,
        method: data.method,
        reference: data.reference ?? null,
        ledgerEntryId: entry!.id,
      })
      .where(eq(refunds.id, refund.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "refund.paid",
      entityType: "student",
      entityId: refund.studentId,
      metadata: {
        refundId: refund.id,
        refundNumber,
        amountPesewas: refund.amountPesewas,
        method: data.method,
      },
    });
    return { refundNumber };
  });
}

/** Withdraws a refund that has not been paid. */
export async function cancelRefund(database: Database, ctx: TenantContext, id: string): Promise<void> {
  assertAllowed(ctx, "fees.refund");
  await withTenant(database, scope(ctx), async (tx) => {
    const refund = await loadRefund(tx, ctx, id);
    if (!["requested", "approved"].includes(refund.status))
      throw new DomainError("refund_closed", "This refund can no longer be cancelled.");
    await tx
      .update(refunds)
      .set({ status: "cancelled", decidedAt: new Date(), decidedByUserId: ctx.userId })
      .where(eq(refunds.id, refund.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "refund.cancelled",
      entityType: "student",
      entityId: refund.studentId,
      metadata: { refundId: refund.id },
    });
  });
}

export interface RefundRow {
  id: string;
  studentId: string;
  studentName: string;
  refundNumber: string | null;
  amountPesewas: number;
  reason: string;
  status: (typeof refunds.$inferSelect)["status"];
  requestedBy: string;
  requestedByUserId: string;
  requestedAt: Date;
  paidOn: string | null;
}

/** Refunds at the school (or for one student), newest first. */
export async function listRefunds(
  database: Database,
  ctx: TenantContext,
  options: { studentId?: string } = {},
): Promise<RefundRow[]> {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: refunds.id,
        studentId: refunds.studentId,
        first: students.firstName,
        last: students.lastName,
        refundNumber: refunds.refundNumber,
        amountPesewas: refunds.amountPesewas,
        reason: refunds.reason,
        status: refunds.status,
        requestedBy: users.name,
        requestedByUserId: refunds.requestedByUserId,
        requestedAt: refunds.requestedAt,
        paidOn: refunds.paidOn,
      })
      .from(refunds)
      .innerJoin(students, eq(students.id, refunds.studentId))
      .innerJoin(users, eq(users.id, refunds.requestedByUserId))
      .where(
        and(
          eq(refunds.tenantId, ctx.tenant.id),
          options.studentId ? eq(refunds.studentId, options.studentId) : undefined,
        ),
      )
      .orderBy(desc(refunds.requestedAt))
      .limit(200);
    return rows.map(({ first, last, ...r }) => ({ ...r, studentName: `${first} ${last}` }));
  });
}
