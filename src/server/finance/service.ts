import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { parseMoney } from "@/lib/money";
import { ACCOUNT_KINDS, EXPENSE_METHODS, type AccountKind, type ExpenseMethod } from "@/lib/school-finance";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  bankDepositItems,
  bankDeposits,
  bankStatementLines,
  expenses,
  financeAccounts,
  payments,
  schoolPreferences,
  students,
  tenantCounters,
  users,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * School money beyond fees (2026-11-18). Accounts say where money is kept; deposits record cash and cheque receipts
 * taken to the bank, so a receipt's money can be followed from the family to the bank; expenses record what the
 * school spends, approved by the Proprietor at or above the school's amount. Income against spending reads the same
 * receipts as Fees. Every change is audited; nothing is deleted.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Deposits, accounts and expenses belong to the whole school, so changing them needs every campus. */
function assertSchoolWide(ctx: TenantContext): void {
  if (ctx.campusIds !== null)
    throw new DomainError(
      "campus_restricted",
      "The school's accounts and spending cover every campus. Ask a colleague with access to every campus.",
    );
}

async function nextNumber(tx: Transaction, tenantId: string, key: string, prefix: string): Promise<string> {
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, key, value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.key],
      set: { value: sql`${tenantCounters.value} + 1` },
    })
    .returning({ value: tenantCounters.value });
  return `${prefix}${String(row!.value).padStart(6, "0")}`;
}

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max, `Use ${max} characters or fewer.`).optional(),
  );
const amountIn = (currency: string) =>
  z.string().transform((text, c) => {
    const minor = parseMoney(text, currency);
    if (minor === null || minor === 0) {
      c.addIssue({ code: "custom", message: "Enter an amount, like 450 or 450.50." });
      return z.NEVER;
    }
    return minor;
  });

// Accounts ------------------------------------------------------------------------------------------------------------

export interface FinanceAccount {
  id: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  accountEnding: string | null;
  status: "active" | "closed";
}

export async function listFinanceAccounts(database: Database, ctx: TenantContext): Promise<FinanceAccount[]> {
  if (!allowed(ctx, "finance.view") && !allowed(ctx, "expenses.record")) assertAllowed(ctx, "finance.view");
  return withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: financeAccounts.id,
        name: financeAccounts.name,
        kind: financeAccounts.kind,
        institution: financeAccounts.institution,
        accountEnding: financeAccounts.accountEnding,
        status: financeAccounts.status,
      })
      .from(financeAccounts)
      .where(eq(financeAccounts.tenantId, ctx.tenant.id))
      .orderBy(asc(financeAccounts.status), asc(financeAccounts.name)),
  );
}

const accountSchema = z.object({
  name: z.string().trim().min(2, "Name the account.").max(80, "Use 80 characters or fewer."),
  kind: z.enum(ACCOUNT_KINDS, { message: "Choose the kind of account." }),
  institution: optionalText(80),
  accountEnding: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^\d{2,6}$/, "Enter only the last 2 to 6 digits, never the full number.")
      .optional(),
  ),
});

/** Adds an account, or changes one's name and details. */
export async function saveFinanceAccount(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  accountId?: string,
): Promise<string> {
  assertAllowed(ctx, "finance.manage");
  assertSchoolWide(ctx);
  const data = accountSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    let id = accountId;
    if (id) {
      if (!uuid.safeParse(id).success) throw new DomainError("not_found", "Account not found.");
      const [row] = await tx
        .update(financeAccounts)
        .set({
          name: data.name,
          institution: data.institution ?? null,
          accountEnding: data.accountEnding ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(financeAccounts.tenantId, ctx.tenant.id), eq(financeAccounts.id, id)))
        .returning({ id: financeAccounts.id });
      if (!row) throw new DomainError("not_found", "Account not found.");
    } else {
      const [row] = await tx
        .insert(financeAccounts)
        .values({
          tenantId: ctx.tenant.id,
          name: data.name,
          kind: data.kind,
          institution: data.institution ?? null,
          accountEnding: data.accountEnding ?? null,
          createdByUserId: ctx.userId,
        })
        .returning({ id: financeAccounts.id });
      id = row!.id;
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: accountId ? "finance_account.updated" : "finance_account.created",
      entityType: "finance_account",
      entityId: id,
      metadata: { name: data.name, kind: data.kind },
    });
    return id;
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError("duplicate", "Another account already has this name.", "name");
    throw error;
  });
}

/** Closes (or reopens) an account: closed accounts take no new deposits or expenses; their history stays. */
export async function setFinanceAccountStatus(
  database: Database,
  ctx: TenantContext,
  accountId: string,
  status: "active" | "closed",
): Promise<void> {
  assertAllowed(ctx, "finance.manage");
  assertSchoolWide(ctx);
  if (!uuid.safeParse(accountId).success) throw new DomainError("not_found", "Account not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .update(financeAccounts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(financeAccounts.tenantId, ctx.tenant.id), eq(financeAccounts.id, accountId)))
      .returning({ id: financeAccounts.id });
    if (!row) throw new DomainError("not_found", "Account not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: status === "closed" ? "finance_account.closed" : "finance_account.reopened",
      entityType: "finance_account",
      entityId: accountId,
    });
  });
}

async function loadActiveAccount(
  tx: Transaction,
  tenantId: string,
  accountId: string,
  kinds?: AccountKind[],
) {
  const [account] = await tx
    .select()
    .from(financeAccounts)
    .where(and(eq(financeAccounts.tenantId, tenantId), eq(financeAccounts.id, accountId)));
  if (!account || account.status !== "active" || (kinds && !kinds.includes(account.kind)))
    throw new DomainError(
      "account_invalid",
      kinds?.length === 1 && kinds[0] === "bank" ? "Choose an open bank account." : "Choose an open account.",
      "accountId",
    );
  return account;
}

// Cash and cheques to the bank ----------------------------------------------------------------------------------------

export interface UndepositedReceipt {
  paymentId: string;
  receiptNumber: string;
  paidOn: string;
  amountPesewas: number;
  method: "cash" | "cheque";
  reference: string | null;
  studentName: string;
  recordedBy: string | null;
  /** Days since the receipt's date, as of today. */
  daysHeld: number;
}

/**
 * Cash and cheque receipts not yet in a deposit (and not voided), oldest first: the money someone in the school is
 * holding. Whole school only: cash in hand is counted for the school, not per campus.
 */
export async function listUndepositedReceipts(
  database: Database,
  ctx: TenantContext,
): Promise<UndepositedReceipt[]> {
  assertAllowed(ctx, "finance.view");
  assertSchoolWide(ctx);
  const today = todayIn(ctx.tenant.timezone);
  const recorder = alias(users, "recorder");
  const rows = await withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        paymentId: payments.id,
        receiptNumber: payments.receiptNumber,
        paidOn: payments.paidOn,
        amountPesewas: payments.amountPesewas,
        method: payments.method,
        reference: payments.reference,
        firstName: students.firstName,
        lastName: students.lastName,
        recordedBy: recorder.name,
      })
      .from(payments)
      .innerJoin(students, eq(students.id, payments.studentId))
      .leftJoin(recorder, eq(recorder.id, payments.recordedByUserId))
      .where(
        and(
          eq(payments.tenantId, ctx.tenant.id),
          inArray(payments.method, ["cash", "cheque"]),
          sql`not exists (select 1 from payment_voids v where v.payment_id = ${payments.id})`,
          sql`not exists (select 1 from ${bankDepositItems} i where i.payment_id = ${payments.id} and not i.released)`,
        ),
      )
      .orderBy(asc(payments.paidOn), asc(payments.receiptNumber))
      .limit(2000),
  );
  return rows.map(({ firstName, lastName, ...r }) => ({
    ...r,
    method: r.method as "cash" | "cheque",
    studentName: `${firstName} ${lastName}`,
    daysHeld: Math.max(0, Math.round((Date.parse(today) - Date.parse(r.paidOn)) / 86_400_000)),
  }));
}

const depositSchema = z.object({
  accountId: uuid,
  depositedOn: isoDate,
  slipReference: optionalText(60),
  paymentIds: z.array(uuid).min(1, "Choose the receipts going to the bank.").max(2000),
});

/**
 * Records cash and cheque receipts taken to the bank together. Each receipt goes into one deposit only (the database
 * refuses a second), must stand (not voided) and be dated on or before the deposit.
 */
export async function createDeposit(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ depositId: string; depositNumber: string; amountPesewas: number }> {
  assertAllowed(ctx, "finance.manage");
  assertSchoolWide(ctx);
  const data = depositSchema.parse(input);
  if (data.depositedOn > todayIn(ctx.tenant.timezone))
    throw new DomainError("future_date", "The deposit date cannot be in the future.", "depositedOn");
  const ids = [...new Set(data.paymentIds)];
  return withTenant(database, scope(ctx), async (tx) => {
    await loadActiveAccount(tx, ctx.tenant.id, data.accountId, ["bank"]);
    const chosen = await tx
      .select({
        id: payments.id,
        amount: payments.amountPesewas,
        method: payments.method,
        paidOn: payments.paidOn,
        receipt: payments.receiptNumber,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, ctx.tenant.id), inArray(payments.id, ids)));
    // No row lock (payments are insert-only for the app): the database's one-live-deposit index and the items'
    // trigger refuse a receipt deposited twice, voided, or not cash or cheque, whatever runs at the same time.
    if (chosen.length !== ids.length) throw new DomainError("not_found", "A chosen receipt was not found.");
    const late = chosen.find((p) => p.paidOn > data.depositedOn);
    if (late)
      throw new DomainError(
        "deposit_before_receipt",
        `Receipt ${late.receipt} is dated after the deposit. Check the deposit date.`,
        "depositedOn",
      );
    const amount = chosen.reduce((sum, p) => sum + p.amount, 0);
    const depositNumber = await nextNumber(tx, ctx.tenant.id, "deposit_number", "D");
    const [deposit] = await tx
      .insert(bankDeposits)
      .values({
        tenantId: ctx.tenant.id,
        depositNumber,
        accountId: data.accountId,
        depositedOn: data.depositedOn,
        slipReference: data.slipReference ?? null,
        amountPesewas: amount,
        recordedByUserId: ctx.userId,
      })
      .returning({ id: bankDeposits.id });
    await tx.insert(bankDepositItems).values(
      chosen.map((p) => ({
        tenantId: ctx.tenant.id,
        depositId: deposit!.id,
        paymentId: p.id,
        amountPesewas: p.amount,
      })),
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "deposit.recorded",
      entityType: "bank_deposit",
      entityId: deposit!.id,
      metadata: {
        depositNumber,
        amountPesewas: amount,
        receipts: chosen.length,
        slip: data.slipReference ?? null,
      },
    });
    return { depositId: deposit!.id, depositNumber, amountPesewas: amount };
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError(
        "already_deposited",
        "One of these receipts is already in a deposit. Reload the page.",
      );
    if (pgErrorCode(error) === "23514")
      throw new DomainError(
        "not_depositable",
        "Only cash and cheque receipts that have not been voided go to the bank.",
      );
    throw error;
  });
}

const reasonSchema = z.object({
  reason: z.string().trim().min(3, "Say why.").max(200, "Use 200 characters or fewer."),
});

/**
 * Cancels a deposit recorded in error (wrong receipts or account): its receipts become undeposited again. A deposit
 * already matched to the bank statement must be unmatched first. The Proprietor's decision, like voiding a receipt.
 */
export async function cancelDeposit(
  database: Database,
  ctx: TenantContext,
  depositId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "expenses.approve");
  assertSchoolWide(ctx);
  const { reason } = reasonSchema.parse(input);
  if (!uuid.safeParse(depositId).success) throw new DomainError("not_found", "Deposit not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [deposit] = await tx
      .select()
      .from(bankDeposits)
      .where(and(eq(bankDeposits.tenantId, ctx.tenant.id), eq(bankDeposits.id, depositId)))
      .for("update");
    if (!deposit) throw new DomainError("not_found", "Deposit not found.");
    if (deposit.cancelledAt) throw new DomainError("already_cancelled", "This deposit is already cancelled.");
    const [matched] = await tx
      .select({ id: bankStatementLines.id })
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.matchedKind, "deposit"), eq(bankStatementLines.matchedId, depositId)));
    if (matched)
      throw new DomainError(
        "deposit_matched",
        "This deposit is matched to a bank statement line. Unmatch it under Bank statements first.",
      );
    await tx
      .update(bankDeposits)
      .set({ cancelledAt: new Date(), cancelledByUserId: ctx.userId, cancelReason: reason })
      .where(eq(bankDeposits.id, depositId));
    await tx
      .update(bankDepositItems)
      .set({ released: true })
      .where(and(eq(bankDepositItems.tenantId, ctx.tenant.id), eq(bankDepositItems.depositId, depositId)));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "deposit.cancelled",
      entityType: "bank_deposit",
      entityId: depositId,
      metadata: { depositNumber: deposit.depositNumber, amountPesewas: deposit.amountPesewas, reason },
    });
  });
}

export interface DepositRow {
  id: string;
  depositNumber: string;
  accountName: string;
  depositedOn: string;
  slipReference: string | null;
  amountPesewas: number;
  receipts: number;
  recordedBy: string | null;
  cancelled: { reason: string; at: Date } | null;
  /** Found on the bank's statement. */
  onStatement: boolean;
}

export async function listDeposits(
  database: Database,
  ctx: TenantContext,
  limit = 100,
): Promise<DepositRow[]> {
  assertAllowed(ctx, "finance.view");
  assertSchoolWide(ctx);
  const recorder = alias(users, "recorder");
  const rows = await withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: bankDeposits.id,
        depositNumber: bankDeposits.depositNumber,
        accountName: financeAccounts.name,
        depositedOn: bankDeposits.depositedOn,
        slipReference: bankDeposits.slipReference,
        amountPesewas: bankDeposits.amountPesewas,
        receipts: sql<number>`(select count(*)::int from ${bankDepositItems} i where i.deposit_id = ${bankDeposits.id})`,
        recordedBy: recorder.name,
        cancelledAt: bankDeposits.cancelledAt,
        cancelReason: bankDeposits.cancelReason,
        onStatement: sql<boolean>`exists (select 1 from ${bankStatementLines} l where l.matched_kind = 'deposit' and l.matched_id = ${bankDeposits.id})`,
      })
      .from(bankDeposits)
      .innerJoin(financeAccounts, eq(financeAccounts.id, bankDeposits.accountId))
      .leftJoin(recorder, eq(recorder.id, bankDeposits.recordedByUserId))
      .where(eq(bankDeposits.tenantId, ctx.tenant.id))
      .orderBy(desc(bankDeposits.depositedOn), desc(bankDeposits.depositNumber))
      .limit(limit),
  );
  return rows.map(({ cancelledAt, cancelReason, ...r }) => ({
    ...r,
    cancelled: cancelledAt && cancelReason ? { reason: cancelReason, at: cancelledAt } : null,
  }));
}

// Expenses ------------------------------------------------------------------------------------------------------------

export async function readExpenseApprovalMinor(tx: Transaction, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ minor: schoolPreferences.expenseApprovalMinor })
    .from(schoolPreferences)
    .where(eq(schoolPreferences.tenantId, tenantId));
  return row?.minor ?? 100_000;
}

export async function getExpenseApprovalAmount(database: Database, ctx: TenantContext): Promise<number> {
  assertAllowed(ctx, "finance.view");
  return withTenant(database, scope(ctx), (tx) => readExpenseApprovalMinor(tx, ctx.tenant.id));
}

/** The Proprietor sets the amount from which an expense waits for their approval (0: every expense). */
export async function setExpenseApprovalAmount(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "expenses.approve");
  const { amount } = z
    .object({
      amount: z.string().transform((text, c) => {
        const minor = text.trim() === "0" ? 0 : parseMoney(text, ctx.tenant.currencyCode);
        if (minor === null) {
          c.addIssue({ code: "custom", message: "Enter an amount, like 1000." });
          return z.NEVER;
        }
        return minor;
      }),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    await tx
      .insert(schoolPreferences)
      .values({ tenantId: ctx.tenant.id, expenseApprovalMinor: amount })
      .onConflictDoUpdate({ target: schoolPreferences.tenantId, set: { expenseApprovalMinor: amount } });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "expenses.approval_amount_set",
      entityType: "school",
      entityId: ctx.tenant.id,
      metadata: { amountMinor: amount },
    });
  });
}

function expenseSchema(currency: string) {
  return z.object({
    spentOn: isoDate,
    category: z.string().trim().min(2, "Choose or type a category.").max(60, "Use 60 characters or fewer."),
    payee: z.string().trim().min(2, "Say who was paid.").max(120, "Use 120 characters or fewer."),
    description: optionalText(500),
    amount: amountIn(currency),
    accountId: uuid,
    method: z.enum(EXPENSE_METHODS, { message: "Choose how it was paid." }),
    reference: optionalText(60),
  });
}

/**
 * Records money the school spent. Below the school's approval amount (or when the Proprietor records it) it counts at
 * once; at or above it, it waits for the Proprietor. Dates in a closed period are refused by the database.
 */
export async function recordExpense(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ expenseId: string; expenseNumber: string; status: "pending" | "approved" }> {
  assertAllowed(ctx, "expenses.record");
  assertSchoolWide(ctx);
  const data = expenseSchema(ctx.tenant.currencyCode).parse(input);
  if (data.spentOn > todayIn(ctx.tenant.timezone))
    throw new DomainError("future_date", "The date cannot be in the future.", "spentOn");
  return withTenant(database, scope(ctx), async (tx) => {
    await loadActiveAccount(tx, ctx.tenant.id, data.accountId);
    const threshold = await readExpenseApprovalMinor(tx, ctx.tenant.id);
    const approver = allowed(ctx, "expenses.approve");
    const status = approver || data.amount < threshold ? "approved" : "pending";
    const expenseNumber = await nextNumber(tx, ctx.tenant.id, "expense_number", "E");
    const [row] = await tx
      .insert(expenses)
      .values({
        tenantId: ctx.tenant.id,
        expenseNumber,
        spentOn: data.spentOn,
        category: data.category,
        payee: data.payee,
        description: data.description ?? null,
        amountPesewas: data.amount,
        accountId: data.accountId,
        method: data.method,
        reference: data.reference ?? null,
        status,
        recordedByUserId: ctx.userId,
        ...(status === "approved"
          ? {
              decidedAt: new Date(),
              decidedByUserId: approver ? ctx.userId : null,
              decisionNote: approver ? null : "Below the approval amount",
            }
          : {}),
      })
      .returning({ id: expenses.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "expense.recorded",
      entityType: "expense",
      entityId: row!.id,
      metadata: { expenseNumber, amountPesewas: data.amount, category: data.category, status },
    });
    return { expenseId: row!.id, expenseNumber, status };
  });
}

/** The Proprietor approves or rejects an expense waiting for them. */
export async function decideExpense(
  database: Database,
  ctx: TenantContext,
  expenseId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "expenses.approve");
  const data = z.object({ approve: z.boolean(), note: optionalText(200) }).parse(input);
  if (!data.approve && !data.note)
    throw new DomainError("note_required", "Say why the expense is rejected.", "note");
  if (!uuid.safeParse(expenseId).success) throw new DomainError("not_found", "Expense not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .update(expenses)
      .set({
        status: data.approve ? "approved" : "rejected",
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        decisionNote: data.note ?? null,
      })
      .where(
        and(eq(expenses.tenantId, ctx.tenant.id), eq(expenses.id, expenseId), eq(expenses.status, "pending")),
      )
      .returning({ id: expenses.id, number: expenses.expenseNumber, amount: expenses.amountPesewas });
    if (!row) throw new DomainError("not_pending", "This expense is not waiting for a decision.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: data.approve ? "expense.approved" : "expense.rejected",
      entityType: "expense",
      entityId: expenseId,
      metadata: { expenseNumber: row.number, amountPesewas: row.amount, note: data.note ?? null },
    });
  });
}

/** Voids an approved expense recorded in error; it then counts nowhere. Refused while matched to the bank statement. */
export async function voidExpense(
  database: Database,
  ctx: TenantContext,
  expenseId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "expenses.approve");
  const { reason } = reasonSchema.parse(input);
  if (!uuid.safeParse(expenseId).success) throw new DomainError("not_found", "Expense not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [matched] = await tx
      .select({ id: bankStatementLines.id })
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.matchedKind, "expense"), eq(bankStatementLines.matchedId, expenseId)));
    if (matched)
      throw new DomainError(
        "expense_matched",
        "This expense is matched to a bank statement line. Unmatch it under Bank statements first.",
      );
    const [row] = await tx
      .update(expenses)
      .set({ status: "voided", voidedAt: new Date(), voidedByUserId: ctx.userId, voidReason: reason })
      .where(
        and(
          eq(expenses.tenantId, ctx.tenant.id),
          eq(expenses.id, expenseId),
          eq(expenses.status, "approved"),
        ),
      )
      .returning({ number: expenses.expenseNumber, amount: expenses.amountPesewas });
    if (!row) throw new DomainError("not_voidable", "Only an approved expense can be voided.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "expense.voided",
      entityType: "expense",
      entityId: expenseId,
      metadata: { expenseNumber: row.number, amountPesewas: row.amount, reason },
    });
  });
}

export interface ExpenseRow {
  id: string;
  expenseNumber: string;
  spentOn: string;
  category: string;
  payee: string;
  description: string | null;
  amountPesewas: number;
  accountName: string;
  method: ExpenseMethod;
  reference: string | null;
  status: "pending" | "approved" | "rejected" | "voided";
  recordedBy: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  voidReason: string | null;
}

/** Expenses dated in a range, newest first; waiting ones first of all. */
export async function listExpenses(
  database: Database,
  ctx: TenantContext,
  range: { from: string; to: string },
): Promise<ExpenseRow[]> {
  assertAllowed(ctx, "finance.view");
  assertSchoolWide(ctx);
  const recorder = alias(users, "recorder");
  const decider = alias(users, "decider");
  const rows = await withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: expenses.id,
        expenseNumber: expenses.expenseNumber,
        spentOn: expenses.spentOn,
        category: expenses.category,
        payee: expenses.payee,
        description: expenses.description,
        amountPesewas: expenses.amountPesewas,
        accountName: financeAccounts.name,
        method: expenses.method,
        reference: expenses.reference,
        status: expenses.status,
        recordedBy: recorder.name,
        decidedBy: decider.name,
        decisionNote: expenses.decisionNote,
        voidReason: expenses.voidReason,
      })
      .from(expenses)
      .innerJoin(financeAccounts, eq(financeAccounts.id, expenses.accountId))
      .leftJoin(recorder, eq(recorder.id, expenses.recordedByUserId))
      .leftJoin(decider, eq(decider.id, expenses.decidedByUserId))
      .where(
        and(
          eq(expenses.tenantId, ctx.tenant.id),
          sql`(${expenses.status} = 'pending' or ${expenses.spentOn} between ${range.from} and ${range.to})`,
        ),
      )
      .orderBy(sql`${expenses.status} = 'pending' desc`, desc(expenses.spentOn), desc(expenses.expenseNumber))
      .limit(1000),
  );
  return rows;
}

// Income against spending ---------------------------------------------------------------------------------------------

export interface IncomeAndSpending {
  from: string;
  to: string;
  months: { month: string; incomePesewas: number; refundsPesewas: number; spendingPesewas: number }[];
  incomeByMethod: { method: string; amountPesewas: number }[];
  spendingByCategory: { category: string; amountPesewas: number }[];
  totals: { incomePesewas: number; refundsPesewas: number; spendingPesewas: number; netPesewas: number };
  /** Cash and cheques received but not yet in a deposit, as of today (all dates). */
  undepositedPesewas: number;
  /** Expenses waiting for the Proprietor (not counted in spending). */
  pending: { count: number; amountPesewas: number };
}

/**
 * Money in and money out for a date range, by month: receipts that stand (as on Fees, Payments), less refunds paid
 * out, against approved expenses. A cash view of the school's money, not accounts drawn up by an accountant.
 */
export async function getIncomeAndSpending(
  database: Database,
  ctx: TenantContext,
  range: { from: string; to: string },
): Promise<IncomeAndSpending> {
  assertAllowed(ctx, "finance.view");
  assertSchoolWide(ctx);
  const { from, to } = z.object({ from: isoDate, to: isoDate }).parse(range);
  if (from > to) throw new DomainError("range_invalid", "The start date is after the end date.");
  const t = ctx.tenant.id;
  return withTenant(database, scope(ctx), async (tx) => {
    const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
      (await tx.execute<T>(query)).rows;
    const income = await q<{ month: string; method: string; amount: string }>(sql`
      select to_char(p.paid_on, 'YYYY-MM') as month, p.method, sum(p.amount_pesewas)::text as amount
      from payments p
      where p.tenant_id = ${t} and p.paid_on between ${from} and ${to}
        and not exists (select 1 from payment_voids v where v.payment_id = p.id)
      group by 1, 2`);
    const refunds = await q<{ month: string; amount: string }>(sql`
      select to_char(r.paid_on, 'YYYY-MM') as month, sum(r.amount_pesewas)::text as amount
      from refunds r
      where r.tenant_id = ${t} and r.status = 'paid' and r.paid_on between ${from} and ${to}
      group by 1`);
    const spending = await q<{ month: string; category: string; amount: string }>(sql`
      select to_char(e.spent_on, 'YYYY-MM') as month, e.category, sum(e.amount_pesewas)::text as amount
      from expenses e
      where e.tenant_id = ${t} and e.status = 'approved' and e.spent_on between ${from} and ${to}
      group by 1, 2`);
    const [cash] = await q<{ amount: string }>(sql`
      select coalesce(sum(p.amount_pesewas), 0)::text as amount from payments p
      where p.tenant_id = ${t} and p.method in ('cash', 'cheque')
        and not exists (select 1 from payment_voids v where v.payment_id = p.id)
        and not exists (select 1 from bank_deposit_items i where i.payment_id = p.id and not i.released)`);
    const [pending] = await q<{ n: number; amount: string }>(sql`
      select count(*)::int as n, coalesce(sum(amount_pesewas), 0)::text as amount
      from expenses where tenant_id = ${t} and status = 'pending'`);

    const months = new Map<
      string,
      { incomePesewas: number; refundsPesewas: number; spendingPesewas: number }
    >();
    const month = (m: string) => {
      let row = months.get(m);
      if (!row) months.set(m, (row = { incomePesewas: 0, refundsPesewas: 0, spendingPesewas: 0 }));
      return row;
    };
    const byMethod = new Map<string, number>();
    const byCategory = new Map<string, number>();
    for (const r of income) {
      month(r.month).incomePesewas += Number(r.amount);
      byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + Number(r.amount));
    }
    for (const r of refunds) month(r.month).refundsPesewas += Number(r.amount);
    for (const r of spending) {
      month(r.month).spendingPesewas += Number(r.amount);
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + Number(r.amount));
    }
    const list = [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, v]) => ({ month: m, ...v }));
    const sum = (key: "incomePesewas" | "refundsPesewas" | "spendingPesewas") =>
      list.reduce((s, r) => s + r[key], 0);
    const totals = {
      incomePesewas: sum("incomePesewas"),
      refundsPesewas: sum("refundsPesewas"),
      spendingPesewas: sum("spendingPesewas"),
      netPesewas: 0,
    };
    totals.netPesewas = totals.incomePesewas - totals.refundsPesewas - totals.spendingPesewas;
    return {
      from,
      to,
      months: list,
      incomeByMethod: [...byMethod.entries()]
        .map(([method, amountPesewas]) => ({ method, amountPesewas }))
        .sort((a, b) => b.amountPesewas - a.amountPesewas),
      spendingByCategory: [...byCategory.entries()]
        .map(([category, amountPesewas]) => ({ category, amountPesewas }))
        .sort((a, b) => b.amountPesewas - a.amountPesewas),
      totals,
      undepositedPesewas: Number(cash?.amount ?? 0),
      pending: { count: pending?.n ?? 0, amountPesewas: Number(pending?.amount ?? 0) },
    };
  });
}
