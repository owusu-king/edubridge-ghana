import "server-only";
import { and, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import { parseCedis, sumPesewas } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { ledgerEntries, students, terms } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { ParsedFile, RowProblem } from "../imports/students";
import type { TenantContext } from "../tenancy/service";
import { assertCanManageSchoolFees, loadFinanceStudent } from "./access";

/**
 * Opening balances carry each family's position over from a school's previous records (paper ledger,
 * spreadsheet or another system) as one ledger entry per student. Adjustments are one-off charges or
 * credits with a stated reason. Neither edits anything: a mistake is reversed and recorded again.
 */

/** First opening balance: `opening`; after a reversal, a new one is `opening:2`, `opening:3`, … */
const OPENING_KEY = "opening";
const openingKey = (attempt: number) => (attempt > 1 ? `${OPENING_KEY}:${attempt}` : OPENING_KEY);

/** Per student: whether a live (unreversed) opening balance exists, and how many were ever recorded. */
async function openingState(tx: Transaction, ctx: TenantContext, studentId?: string) {
  const rows = await tx
    .select({
      studentId: ledgerEntries.studentId,
      reversed: sql<boolean>`exists (select 1 from ledger_entries r where r.reverses_entry_id = ledger_entries.id)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, ctx.tenant.id),
        eq(ledgerEntries.kind, "opening_balance"),
        like(ledgerEntries.billingKey, `${OPENING_KEY}%`),
        studentId ? eq(ledgerEntries.studentId, studentId) : undefined,
      ),
    );
  const state = new Map<string, { live: boolean; count: number }>();
  for (const row of rows) {
    const so = state.get(row.studentId) ?? { live: false, count: 0 };
    state.set(row.studentId, { live: so.live || !row.reversed, count: so.count + 1 });
  }
  return state;
}
const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");

/**
 * Reads a balance as written in school records: "1,200.50" or "GH₵ 1200" is owed; "-300", "(300)",
 * "300 CR" or "CR 300" is a credit (paid in advance). Returns signed pesewas, or null if unreadable.
 */
export function parseBalance(text: string): number | null {
  let value = text.trim().replace(/\s+/g, " ");
  let credit = false;
  if (/^\(.*\)$/.test(value)) {
    credit = true;
    value = value.slice(1, -1);
  }
  if (/^-/.test(value)) {
    credit = true;
    value = value.slice(1);
  }
  if (/\bCR\.?$/i.test(value) || /^CR\b/i.test(value)) {
    credit = true;
    value = value.replace(/\bCR\.?$/i, "").replace(/^CR\b/i, "");
  }
  value = value.replace(/^(GH₵|GHS|GH¢|₵|¢)\s*-?/i, (m) => {
    if (m.trim().endsWith("-")) credit = true;
    return "";
  });
  const pesewas = parseCedis(value.trim());
  if (pesewas === null) return null;
  return credit ? -pesewas : pesewas;
}

/** The day before the current term starts, so brought-forward balances come first on statements. */
async function defaultAsOf(tx: Transaction, ctx: TenantContext): Promise<string> {
  const [term] = await tx
    .select({ startsOn: terms.startsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
  if (!term) return todayIn(ctx.tenant.timezone);
  const day = new Date(`${term.startsOn}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export async function suggestedAsOf(database: Database, ctx: TenantContext): Promise<string> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), (tx) => defaultAsOf(tx, ctx));
}

function openingDescription(amount: number): string {
  return amount < 0
    ? "Credit brought forward from previous records"
    : "Balance brought forward from previous records";
}

const ADMISSION_HEADERS = [
  "admission number",
  "admission no",
  "admission no.",
  "adm no",
  "adm. no.",
  "student id",
  "admission",
];
const BALANCE_HEADERS = ["balance", "opening balance", "amount owed", "arrears", "balance owed", "amount"];
const norm = (h: string) => h.toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ").trim();

export function findBalanceColumns(headers: string[]): { admission: number; balance: number } {
  const normalised = headers.map(norm);
  const admission = normalised.findIndex((h) => ADMISSION_HEADERS.includes(h));
  const balance = normalised.findIndex((h) => BALANCE_HEADERS.includes(h));
  if (admission === -1 || balance === -1)
    throw new DomainError(
      "columns_missing",
      "The file needs an “Admission number” column and a “Balance” column. Download the template to see the layout.",
      "file",
    );
  return { admission, balance };
}

export interface BalanceRow {
  row: number;
  studentId: string;
  admissionNumber: string;
  name: string;
  amountPesewas: number;
  billingKey: string;
}

export interface BalanceCheck {
  ready: BalanceRow[];
  problems: RowProblem[];
  /** Students who already have an opening balance (left unchanged). */
  alreadySet: number;
  /** Rows with a zero balance (nothing to bring forward). */
  zero: number;
  owedPesewas: number;
  creditPesewas: number;
}

async function checkRows(tx: Transaction, ctx: TenantContext, parsed: ParsedFile): Promise<BalanceCheck> {
  const columns = findBalanceColumns(parsed.headers);
  const known = await tx
    .select({
      id: students.id,
      admissionNumber: students.admissionNumber,
      firstName: students.firstName,
      lastName: students.lastName,
    })
    .from(students)
    .where(eq(students.tenantId, ctx.tenant.id));
  const byNumber = new Map(known.map((s) => [s.admissionNumber.toLowerCase(), s]));
  const opening = await openingState(tx, ctx);
  const ready: BalanceRow[] = [];
  const problems: RowProblem[] = [];
  const seen = new Set<string>();
  let alreadySet = 0;
  let zero = 0;
  parsed.rows.forEach((cells, i) => {
    const row = i + 2; // Row 1 is the header, as numbered in Excel.
    const admissionNumber = cells[columns.admission] ?? "";
    const amountText = cells[columns.balance] ?? "";
    if (!admissionNumber && !amountText) return;
    const student = byNumber.get(admissionNumber.toLowerCase());
    if (!admissionNumber) {
      problems.push({ row, field: "Admission number", message: "Missing." });
      return;
    }
    if (!student) {
      problems.push({
        row,
        field: "Admission number",
        message: `No student with admission number ${admissionNumber}.`,
      });
      return;
    }
    if (seen.has(student.id)) {
      problems.push({
        row,
        field: "Admission number",
        message: `${admissionNumber} appears more than once.`,
      });
      return;
    }
    seen.add(student.id);
    const amount = parseBalance(amountText);
    if (amount === null) {
      problems.push({
        row,
        field: "Balance",
        message: `“${amountText}” is not an amount. Use 450, 450.50, or -450 for a credit.`,
      });
      return;
    }
    if (amount === 0) {
      zero++;
      return;
    }
    if (opening.get(student.id)?.live) {
      alreadySet++;
      return;
    }
    ready.push({
      row,
      studentId: student.id,
      admissionNumber: student.admissionNumber,
      name: `${student.firstName} ${student.lastName}`,
      amountPesewas: amount,
      billingKey: openingKey((opening.get(student.id)?.count ?? 0) + 1),
    });
  });
  return {
    ready,
    problems,
    alreadySet,
    zero,
    owedPesewas: sumPesewas(ready.filter((r) => r.amountPesewas > 0).map((r) => r.amountPesewas)),
    creditPesewas: sumPesewas(ready.filter((r) => r.amountPesewas < 0).map((r) => -r.amountPesewas)),
  };
}

export async function checkOpeningBalances(
  database: Database,
  ctx: TenantContext,
  parsed: ParsedFile,
): Promise<BalanceCheck> {
  assertCanManageSchoolFees(ctx);
  return withTenant(database, scope(ctx), (tx) => checkRows(tx, ctx, parsed));
}

/**
 * Records the file's balances in one transaction. Rows with problems, zero balances and students who
 * already have an opening balance are skipped, so importing the same file twice changes nothing.
 */
export async function importOpeningBalances(
  database: Database,
  ctx: TenantContext,
  parsed: ParsedFile,
  input: unknown,
): Promise<BalanceCheck & { imported: number }> {
  assertCanManageSchoolFees(ctx);
  const { asOf } = z.object({ asOf: isoDate }).parse(input);
  if (asOf > todayIn(ctx.tenant.timezone))
    throw new DomainError("future_date", "The date cannot be in the future.", "asOf");
  return withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`opening-balances:${ctx.tenant.id}`}))`);
    const check = await checkRows(tx, ctx, parsed);
    if (check.ready.length === 0)
      throw new DomainError("nothing_to_import", "There are no new balances to import in this file.");
    for (let i = 0; i < check.ready.length; i += 500) {
      await tx
        .insert(ledgerEntries)
        .values(
          check.ready.slice(i, i + 500).map((r) => ({
            tenantId: ctx.tenant.id,
            studentId: r.studentId,
            kind: "opening_balance" as const,
            description: openingDescription(r.amountPesewas),
            amountPesewas: r.amountPesewas,
            billingKey: r.billingKey,
            effectiveOn: asOf,
            recordedByUserId: ctx.userId,
          })),
        )
        .onConflictDoNothing({
          target: [ledgerEntries.tenantId, ledgerEntries.studentId, ledgerEntries.billingKey],
        });
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.opening_balances_imported",
      entityType: "student",
      metadata: {
        students: check.ready.length,
        owedPesewas: check.owedPesewas,
        creditPesewas: check.creditPesewas,
        asOf,
      },
    });
    return { ...check, imported: check.ready.length };
  });
}

const openingSchema = z.object({
  amount: z.string().transform((text, ctx) => {
    const pesewas = parseBalance(text);
    if (pesewas === null || pesewas === 0) {
      ctx.addIssue({ code: "custom", message: "Enter the amount owed, or a negative amount for a credit." });
      return z.NEVER;
    }
    return pesewas;
  }),
  asOf: isoDate,
});

const OPENING_EXISTS =
  "This student already has an opening balance. Reverse it on the statement first to enter a new one.";

/** Sets one student's opening balance. Each student has at most one; to change it, reverse it first. */
export async function setOpeningBalance(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "fees.manage");
  const { amount, asOf } = openingSchema.parse(input);
  if (asOf > todayIn(ctx.tenant.timezone))
    throw new DomainError("future_date", "The date cannot be in the future.", "asOf");
  await withTenant(database, scope(ctx), async (tx) => {
    const student = await loadFinanceStudent(tx, ctx, studentId);
    if (!student) throw new DomainError("student_not_found", "Student not found.");
    const state = (await openingState(tx, ctx, student.id)).get(student.id);
    if (state?.live) throw new DomainError("opening_exists", OPENING_EXISTS);
    await tx.insert(ledgerEntries).values({
      tenantId: ctx.tenant.id,
      studentId: student.id,
      kind: "opening_balance",
      description: openingDescription(amount),
      amountPesewas: amount,
      billingKey: openingKey((state?.count ?? 0) + 1),
      effectiveOn: asOf,
      recordedByUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.opening_balance_set",
      entityType: "student",
      entityId: student.id,
      metadata: { amountPesewas: amount, asOf },
    });
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DomainError("opening_exists", OPENING_EXISTS);
    throw error;
  });
}

/** Whether a student still has a live (unreversed) opening balance. */
export async function hasOpeningBalance(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<boolean> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), async (tx) =>
    Boolean((await openingState(tx, ctx, studentId)).get(studentId)?.live),
  );
}

const adjustmentSchema = z.object({
  direction: z.enum(["charge", "credit"], { message: "Choose charge or credit." }),
  amount: z.string().transform((text, ctx) => {
    const pesewas = parseCedis(text);
    if (pesewas === null || pesewas === 0) {
      ctx.addIssue({ code: "custom", message: "Enter an amount, like 50 or 50.00." });
      return z.NEVER;
    }
    return pesewas;
  }),
  description: z.string().trim().min(3, "Say what this is for.").max(120, "Use 120 characters or fewer."),
});

/** A one-off charge (lost book, excursion) or credit (refund owed, goodwill) on one student's account. */
export async function recordAdjustment(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "fees.manage");
  const { direction, amount, description } = adjustmentSchema.parse(input);
  const signed = direction === "charge" ? amount : -amount;
  await withTenant(database, scope(ctx), async (tx) => {
    const student = await loadFinanceStudent(tx, ctx, studentId);
    if (!student) throw new DomainError("student_not_found", "Student not found.");
    const [term] = await tx
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
    await tx.insert(ledgerEntries).values({
      tenantId: ctx.tenant.id,
      studentId: student.id,
      termId: term?.id ?? null,
      kind: "adjustment",
      description,
      amountPesewas: signed,
      effectiveOn: todayIn(ctx.tenant.timezone),
      recordedByUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: direction === "charge" ? "fees.charge_added" : "fees.credit_added",
      entityType: "student",
      entityId: student.id,
      metadata: { description, amountPesewas: amount },
    });
  });
}
