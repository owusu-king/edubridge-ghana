import "server-only";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { parseCedis, sumPesewas } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  ledgerEntries,
  PAYMENT_METHODS,
  payments,
  paymentVoids,
  students,
  tenantCounters,
  terms,
  users,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  mobile_money: "Mobile Money",
  bank_deposit: "Bank deposit",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
};

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const recordSchema = z
  .object({
    studentId: z.string().uuid(),
    amount: z.string().transform((text, ctx) => {
      const pesewas = parseCedis(text);
      if (pesewas === null || pesewas === 0) {
        ctx.addIssue({ code: "custom", message: "Enter the amount received, like 450 or 450.50." });
        return z.NEVER;
      }
      return pesewas;
    }),
    method: z.enum(PAYMENT_METHODS, { message: "Choose how the money was paid." }),
    reference: z.preprocess(
      blankToUndefined,
      z.string().trim().max(60, "Use 60 characters or fewer.").optional(),
    ),
    payerName: z.preprocess(
      blankToUndefined,
      z.string().trim().max(120, "Use 120 characters or fewer.").optional(),
    ),
    paidOn: isoDate,
    idempotencyKey: z.string().uuid(),
  })
  .refine((v) => v.method === "cash" || v.reference, {
    message: "Enter the transaction, slip or cheque number.",
    path: ["reference"],
  });

export interface RecordedPayment {
  paymentId: string;
  receiptNumber: string;
  /** True when this submission had already been recorded (double submit). */
  replayed: boolean;
}

/** R000001, R000002, … per school. Allocated inside the payment's transaction, so there are no gaps. */
async function nextReceiptNumber(tx: Transaction, tenantId: string): Promise<string> {
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, key: "receipt_number", value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.key],
      set: { value: sql`${tenantCounters.value} + 1` },
    })
    .returning({ value: tenantCounters.value });
  return `R${String(row!.value).padStart(6, "0")}`;
}

async function findByKey(database: Database, ctx: TenantContext, key: string) {
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, ctx.tenant.id), eq(payments.idempotencyKey, key)));
    return row ?? null;
  });
}

function replay(
  existing: typeof payments.$inferSelect,
  data: { studentId: string; amount: number },
): RecordedPayment {
  if (existing.studentId !== data.studentId || existing.amountPesewas !== data.amount)
    throw new DomainError(
      "duplicate_submission",
      "This form was already used for another payment. Reload the page.",
    );
  return { paymentId: existing.id, receiptNumber: existing.receiptNumber, replayed: true };
}

/**
 * Records money received and credits the student's account in one transaction. Submitting the same
 * form twice (same idempotency key) returns the first payment instead of recording another.
 */
export async function recordPayment(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<RecordedPayment> {
  assertCan(ctx.roles, "payments.record");
  const data = recordSchema.parse(input);
  const today = todayIn(ctx.tenant.timezone);
  if (data.paidOn > today)
    throw new DomainError("future_date", "The payment date cannot be in the future.", "paidOn");

  const existing = await findByKey(database, ctx, data.idempotencyKey);
  if (existing) return replay(existing, data);

  try {
    return await withTenant(database, scope(ctx), async (tx) => {
      const student = await loadFinanceStudent(tx, ctx, data.studentId);
      if (!student) throw new DomainError("student_not_found", "Student not found.");
      const [term] = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
      const receiptNumber = await nextReceiptNumber(tx, ctx.tenant.id);
      const [payment] = await tx
        .insert(payments)
        .values({
          tenantId: ctx.tenant.id,
          studentId: student.id,
          receiptNumber,
          amountPesewas: data.amount,
          method: data.method,
          reference: data.reference ?? null,
          payerName: data.payerName ?? null,
          paidOn: data.paidOn,
          idempotencyKey: data.idempotencyKey,
          recordedByUserId: ctx.userId,
        })
        .returning({ id: payments.id });
      await tx.insert(ledgerEntries).values({
        tenantId: ctx.tenant.id,
        studentId: student.id,
        termId: term?.id ?? null,
        kind: "payment",
        description: `Payment, receipt ${receiptNumber} (${METHOD_LABELS[data.method]})`,
        amountPesewas: -data.amount,
        paymentId: payment!.id,
        effectiveOn: data.paidOn,
        recordedByUserId: ctx.userId,
      });
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "payment.recorded",
        entityType: "payment",
        entityId: payment!.id,
        metadata: { receipt: receiptNumber, amountPesewas: data.amount, method: data.method },
      });
      return { paymentId: payment!.id, receiptNumber, replayed: false };
    });
  } catch (error) {
    // Two submissions raced: the loser's transaction rolled back (and its receipt number with it).
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      const winner = await findByKey(database, ctx, data.idempotencyKey);
      if (winner) return replay(winner, data);
    }
    throw error;
  }
}

const voidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Say why this receipt is being voided.")
    .max(120, "Use 120 characters or fewer."),
});

/** Voids a receipt: the payment is marked void and its credit to the account reversed. */
export async function voidPayment(
  database: Database,
  ctx: TenantContext,
  paymentId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "payments.void");
  const { reason } = voidSchema.parse(input);
  if (!z.string().uuid().safeParse(paymentId).success)
    throw new DomainError("not_found", "Receipt not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, ctx.tenant.id), eq(payments.id, paymentId)));
    if (!payment || !(await loadFinanceStudent(tx, ctx, payment.studentId)))
      throw new DomainError("not_found", "Receipt not found.");
    const [entry] = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, ctx.tenant.id),
          eq(ledgerEntries.paymentId, paymentId),
          eq(ledgerEntries.kind, "payment"),
        ),
      );
    await tx
      .insert(paymentVoids)
      .values({ tenantId: ctx.tenant.id, paymentId, reason, voidedByUserId: ctx.userId });
    await tx.insert(ledgerEntries).values({
      tenantId: ctx.tenant.id,
      studentId: payment.studentId,
      termId: entry!.termId,
      kind: "reversal",
      description: `Receipt ${payment.receiptNumber} voided (${reason})`.slice(0, 200),
      amountPesewas: -entry!.amountPesewas,
      reversesEntryId: entry!.id,
      paymentId,
      effectiveOn: todayIn(ctx.tenant.timezone),
      recordedByUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "payment.voided",
      entityType: "payment",
      entityId: paymentId,
      metadata: { receipt: payment.receiptNumber, amountPesewas: payment.amountPesewas, reason },
    });
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError("already_voided", "This receipt has already been voided.");
    throw error;
  });
}

export interface Receipt {
  id: string;
  receiptNumber: string;
  amountPesewas: number;
  method: PaymentMethod;
  reference: string | null;
  payerName: string | null;
  paidOn: string;
  recordedBy: string | null;
  recordedAt: Date;
  student: { id: string; name: string; admissionNumber: string; className: string | null };
  /** The account balance straight after this payment was recorded. */
  balanceAfterPesewas: number;
  voided: { reason: string; at: Date; by: string | null } | null;
}

export async function getReceipt(
  database: Database,
  ctx: TenantContext,
  paymentId: string,
): Promise<Receipt | null> {
  assertCan(ctx.roles, "fees.view");
  if (!z.string().uuid().safeParse(paymentId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({ payment: payments, recordedBy: users.name })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.recordedByUserId))
      .where(and(eq(payments.tenantId, ctx.tenant.id), eq(payments.id, paymentId)));
    if (!row) return null;
    const student = await loadFinanceStudent(tx, ctx, row.payment.studentId);
    if (!student) return null;
    const [entry] = await tx
      .select({ entryNumber: ledgerEntries.entryNumber })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.paymentId, paymentId), eq(ledgerEntries.kind, "payment")));
    const [balance] = await tx
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, ctx.tenant.id),
          eq(ledgerEntries.studentId, student.id),
          sql`${ledgerEntries.entryNumber} <= ${entry!.entryNumber}`,
        ),
      );
    const [cls] = await tx
      .select({ name: classes.name })
      .from(enrolments)
      .innerJoin(terms, eq(terms.id, enrolments.termId))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .where(and(eq(enrolments.studentId, student.id), eq(terms.isCurrent, true)));
    const [voided] = await tx
      .select({ reason: paymentVoids.reason, at: paymentVoids.voidedAt, by: users.name })
      .from(paymentVoids)
      .leftJoin(users, eq(users.id, paymentVoids.voidedByUserId))
      .where(eq(paymentVoids.paymentId, paymentId));
    const p = row.payment;
    return {
      id: p.id,
      receiptNumber: p.receiptNumber,
      amountPesewas: p.amountPesewas,
      method: p.method,
      reference: p.reference,
      payerName: p.payerName,
      paidOn: p.paidOn,
      recordedBy: row.recordedBy,
      recordedAt: p.recordedAt,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber,
        className: cls?.name ?? null,
      },
      balanceAfterPesewas: Number(balance!.total),
      voided: voided ?? null,
    };
  });
}

/** Staff limited to some campuses see only students whose class this term is at those campuses. */
function campusFilter(
  ctx: TenantContext,
  studentId: typeof students.id | typeof payments.studentId,
): SQL | undefined {
  if (ctx.campusIds === null) return undefined;
  const campusIds = ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"];
  return sql`exists (
    select 1 from ${enrolments}
    join ${terms} on ${terms.id} = ${enrolments.termId} and ${terms.isCurrent}
    join ${classes} on ${classes.id} = ${enrolments.classId}
    where ${enrolments.studentId} = ${studentId} and ${inArray(classes.campusId, campusIds)}
  )`;
}

export interface DayPayment {
  id: string;
  receiptNumber: string;
  studentId: string;
  studentName: string;
  admissionNumber: string;
  method: PaymentMethod;
  reference: string | null;
  amountPesewas: number;
  voided: boolean;
}

export interface PaymentsDay {
  date: string;
  payments: DayPayment[];
  /** Totals of payments not voided, per method and overall. */
  byMethod: { method: PaymentMethod; count: number; totalPesewas: number }[];
  totalPesewas: number;
}

/** Payments received on one day, for counting the cash box and checking bank and Mobile Money records. */
export async function listPaymentsOn(
  database: Database,
  ctx: TenantContext,
  date: string,
): Promise<PaymentsDay> {
  assertCan(ctx.roles, "fees.view");
  const day = isoDate.safeParse(date).success ? date : todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        receiptNumber: payments.receiptNumber,
        studentId: payments.studentId,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
        method: payments.method,
        reference: payments.reference,
        amountPesewas: payments.amountPesewas,
        voided: sql<boolean>`${paymentVoids.paymentId} is not null`,
      })
      .from(payments)
      .innerJoin(students, eq(students.id, payments.studentId))
      .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
      .where(
        and(
          eq(payments.tenantId, ctx.tenant.id),
          eq(payments.paidOn, day),
          campusFilter(ctx, payments.studentId),
        ),
      )
      .orderBy(asc(payments.receiptNumber));
    const live = rows.filter((r) => !r.voided);
    return {
      date: day,
      payments: rows.map(({ firstName, lastName, ...r }) => ({
        ...r,
        studentName: `${firstName} ${lastName}`,
      })),
      byMethod: PAYMENT_METHODS.map((method) => {
        const of = live.filter((r) => r.method === method);
        return { method, count: of.length, totalPesewas: sumPesewas(of.map((r) => r.amountPesewas)) };
      }).filter((m) => m.count > 0),
      totalPesewas: sumPesewas(live.map((r) => r.amountPesewas)),
    };
  });
}

export const ACCOUNTS_PAGE_SIZE = 50;

export interface AccountRow {
  studentId: string;
  name: string;
  admissionNumber: string;
  className: string | null;
  status: "active" | "withdrawn" | "graduated";
  balancePesewas: number;
}

export interface AccountsPage {
  rows: AccountRow[];
  total: number;
  page: number;
  /** Across every matching student, not just this page. */
  owedPesewas: number;
  creditPesewas: number;
}

const accountsSchema = z.object({
  q: z.string().trim().max(60).optional(),
  classId: z.string().uuid().optional(),
  owing: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).optional(),
});

/** Balances of active students (and anyone else with money owed or in credit), largest debt first. */
export async function listAccounts(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<AccountsPage> {
  assertCan(ctx.roles, "fees.view");
  const filters = accountsSchema.parse(input);
  const page = filters.page ?? 1;
  return withTenant(database, scope(ctx), async (tx) => {
    const balances = tx
      .select({
        studentId: ledgerEntries.studentId,
        balance: sql<string>`sum(${ledgerEntries.amountPesewas})`.as("balance"),
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, ctx.tenant.id))
      .groupBy(ledgerEntries.studentId)
      .as("balances");
    const current = tx
      .select({ studentId: enrolments.studentId, classId: enrolments.classId, className: classes.name })
      .from(enrolments)
      .innerJoin(terms, and(eq(terms.id, enrolments.termId), eq(terms.isCurrent, true)))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .where(eq(enrolments.tenantId, ctx.tenant.id))
      .as("current");
    const balance = sql<number>`coalesce(${balances.balance}, 0)`;
    const conditions: (SQL | undefined)[] = [
      eq(students.tenantId, ctx.tenant.id),
      or(eq(students.status, "active"), sql`${balance} <> 0`),
      campusFilter(ctx, students.id),
      filters.classId ? eq(current.classId, filters.classId) : undefined,
      filters.owing ? sql`${balance} > 0` : undefined,
    ];
    if (filters.q) {
      const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(
          ilike(students.firstName, like),
          ilike(students.lastName, like),
          ilike(students.admissionNumber, like),
          ilike(sql`${students.firstName} || ' ' || ${students.lastName}`, like),
        ),
      );
    }
    const where = and(...conditions);
    const base = () =>
      tx
        .select({
          studentId: students.id,
          firstName: students.firstName,
          lastName: students.lastName,
          admissionNumber: students.admissionNumber,
          status: students.status,
          className: current.className,
          balance: sql<string>`${balance}`,
        })
        .from(students)
        .leftJoin(balances, eq(balances.studentId, students.id))
        .leftJoin(current, eq(current.studentId, students.id))
        .where(where);
    const rows = await base()
      .orderBy(desc(balance), asc(students.lastName), asc(students.firstName))
      .limit(ACCOUNTS_PAGE_SIZE)
      .offset((page - 1) * ACCOUNTS_PAGE_SIZE);
    const [totals] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        owed: sql<string>`coalesce(sum(greatest(${balance}, 0)), 0)`,
        credit: sql<string>`coalesce(sum(greatest(-${balance}, 0)), 0)`,
      })
      .from(students)
      .leftJoin(balances, eq(balances.studentId, students.id))
      .leftJoin(current, eq(current.studentId, students.id))
      .where(where);
    return {
      rows: rows.map((r) => ({
        studentId: r.studentId,
        name: `${r.firstName} ${r.lastName}`,
        admissionNumber: r.admissionNumber,
        className: r.className,
        status: r.status,
        balancePesewas: Number(r.balance),
      })),
      total: totals?.total ?? 0,
      page,
      owedPesewas: Number(totals?.owed ?? 0),
      creditPesewas: Number(totals?.credit ?? 0),
    };
  });
}
