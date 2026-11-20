import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { formatMoney } from "@/lib/money";
import {
  automaticMatch,
  parseBankStatement,
  rankCandidates,
  statementLineKeys,
  type MatchCandidate,
} from "@/lib/school-finance";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { bankStatementImports, bankStatementLines, financeAccounts } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Bank statements (2026-11-18): the bank's own record of an account, imported as CSV and matched line by line to what
 * EduBridge recorded. Money in matches a deposit of cash and cheques or a family's bank payment; money out matches an
 * expense paid from the account. A line nothing explains (a bank charge, interest) is explained with a note. What is
 * left unmatched, on either side, is what someone must look into.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

function assertManager(ctx: TenantContext) {
  assertAllowed(ctx, "finance.manage");
  if (ctx.campusIds !== null)
    throw new DomainError(
      "campus_restricted",
      "Bank statements cover the whole school. Ask a colleague with access to every campus.",
    );
}

const uuid = z.string().uuid();
/** Largest statement file read (about 10,000 lines). */
const MAX_FILE_CHARS = 2_000_000;

async function loadBankAccount(tx: Transaction, tenantId: string, accountId: string) {
  if (!uuid.safeParse(accountId).success) throw new DomainError("not_found", "Account not found.");
  const [account] = await tx
    .select()
    .from(financeAccounts)
    .where(and(eq(financeAccounts.tenantId, tenantId), eq(financeAccounts.id, accountId)));
  if (!account || account.kind !== "bank") throw new DomainError("not_found", "Bank account not found.");
  return account;
}

/** Records not yet matched that a line on this account could be. */
async function openCandidates(
  tx: Transaction,
  tenantId: string,
  accountId: string,
): Promise<MatchCandidate[]> {
  const rows = (
    await tx.execute<{
      kind: MatchCandidate["kind"];
      id: string;
      on: string;
      amount: string;
      reference: string | null;
      label: string;
    }>(sql`
      select 'deposit' as kind, d.id, d.deposited_on::text as on, d.amount_pesewas::text as amount,
        d.slip_reference as reference, 'Deposit ' || d.deposit_number as label
      from bank_deposits d
      where d.tenant_id = ${tenantId} and d.account_id = ${accountId} and d.cancelled_at is null
        and not exists (select 1 from bank_statement_lines l where l.matched_kind = 'deposit' and l.matched_id = d.id)
      union all
      select 'payment', p.id, p.paid_on::text, p.amount_pesewas::text, p.reference,
        'Receipt ' || p.receipt_number || ' (' || s.first_name || ' ' || s.last_name || ')'
      from payments p join students s on s.id = p.student_id
      where p.tenant_id = ${tenantId} and p.method in ('bank_transfer', 'bank_deposit')
        and not exists (select 1 from payment_voids v where v.payment_id = p.id)
        and not exists (select 1 from bank_statement_lines l where l.matched_kind = 'payment' and l.matched_id = p.id)
      union all
      select 'expense', e.id, e.spent_on::text, (-e.amount_pesewas)::text, e.reference,
        'Expense ' || e.expense_number || ' (' || e.payee || ')'
      from expenses e
      where e.tenant_id = ${tenantId} and e.account_id = ${accountId} and e.status = 'approved'
        and not exists (select 1 from bank_statement_lines l where l.matched_kind = 'expense' and l.matched_id = e.id)`)
  ).rows;
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    on: r.on,
    amountPesewas: Number(r.amount),
    reference: r.reference,
    label: r.label,
  }));
}

/** Matches every unmatched line of the account that has exactly one possible record. Returns how many it matched. */
async function autoMatch(tx: Transaction, ctx: TenantContext, accountId: string): Promise<number> {
  let candidates = await openCandidates(tx, ctx.tenant.id, accountId);
  const lines = await tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.tenantId, ctx.tenant.id),
        eq(bankStatementLines.accountId, accountId),
        isNull(bankStatementLines.matchedKind),
      ),
    )
    .orderBy(asc(bankStatementLines.lineOn));
  let matched = 0;
  for (const line of lines) {
    const found = automaticMatch(line, candidates);
    if (!found) continue;
    await tx
      .update(bankStatementLines)
      .set({ matchedKind: found.kind, matchedId: found.id, matchedAt: new Date(), matchedByUserId: null })
      .where(eq(bankStatementLines.id, line.id));
    candidates = candidates.filter((c) => !(c.kind === found.kind && c.id === found.id));
    matched++;
  }
  return matched;
}

/**
 * Imports a statement saved as CSV for a bank account. Lines already imported (same date, amount, reference and
 * description) are skipped, so importing an overlapping statement is safe. Then matches what it can.
 */
export async function importStatement(
  database: Database,
  ctx: TenantContext,
  input: { accountId: string; fileName: string; text: string },
): Promise<{ added: number; skipped: number; matched: number; problems: string[] }> {
  assertManager(ctx);
  if (input.text.length > MAX_FILE_CHARS)
    throw new DomainError("file_too_large", "The statement file is too large. Import a month at a time.");
  const parsed = parseBankStatement(input.text);
  if (parsed.lines.length === 0)
    throw new DomainError(
      "statement_empty",
      parsed.problems[0] ?? "No statement lines were found in the file.",
    );
  const keys = statementLineKeys(parsed.lines);
  return withTenant(database, scope(ctx), async (tx) => {
    await loadBankAccount(tx, ctx.tenant.id, input.accountId);
    const [batch] = await tx
      .insert(bankStatementImports)
      .values({
        tenantId: ctx.tenant.id,
        accountId: input.accountId,
        fileName: (input.fileName || "statement.csv").slice(0, 200),
        linesAdded: 0,
        linesSkipped: 0,
        importedByUserId: ctx.userId,
      })
      .returning({ id: bankStatementImports.id });
    const inserted = await tx
      .insert(bankStatementLines)
      .values(
        parsed.lines.map((l, i) => ({
          tenantId: ctx.tenant.id,
          importId: batch!.id,
          accountId: input.accountId,
          lineOn: l.lineOn,
          description: l.description,
          reference: l.reference,
          amountPesewas: l.amountPesewas,
          lineKey: keys[i]!,
        })),
      )
      .onConflictDoNothing({ target: [bankStatementLines.accountId, bankStatementLines.lineKey] })
      .returning({ id: bankStatementLines.id });
    const added = inserted.length;
    const skipped = parsed.lines.length - added;
    await tx
      .update(bankStatementImports)
      .set({ linesAdded: added, linesSkipped: skipped })
      .where(eq(bankStatementImports.id, batch!.id));
    const matched = await autoMatch(tx, ctx, input.accountId);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "bank_statement.imported",
      entityType: "finance_account",
      entityId: input.accountId,
      metadata: { added, skipped, matched, file: input.fileName.slice(0, 120) },
    });
    return { added, skipped, matched, problems: parsed.problems.slice(0, 20) };
  });
}

export interface StatementLineView {
  id: string;
  lineOn: string;
  description: string;
  reference: string | null;
  amountPesewas: number;
  match: { kind: "deposit" | "payment" | "expense" | "other"; label: string; automatic: boolean } | null;
  /** For an unmatched line: the records it could be, best first (at most three). */
  candidates: MatchCandidate[];
}

export interface Reconciliation {
  account: { id: string; name: string; institution: string | null; accountEnding: string | null };
  month: string;
  lines: StatementLineView[];
  summary: {
    inPesewas: number;
    outPesewas: number;
    unmatchedLines: number;
    unmatchedPesewas: number;
  };
  /** Deposits recorded in EduBridge but not yet seen on any statement line. */
  depositsNotOnStatement: { id: string; label: string; on: string; amountPesewas: number }[];
  /** Approved expenses paid from the account but not on any statement line. */
  expensesNotOnStatement: { id: string; label: string; on: string; amountPesewas: number }[];
}

/** One account's statement lines for a month (YYYY-MM), with what each matches and what is still open. */
export async function getReconciliation(
  database: Database,
  ctx: TenantContext,
  accountId: string,
  month: string,
): Promise<Reconciliation> {
  assertAllowed(ctx, "finance.view");
  if (ctx.campusIds !== null)
    throw new DomainError("campus_restricted", "Bank statements cover the whole school.");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new DomainError("month_invalid", "Choose a month.");
  return withTenant(database, scope(ctx), async (tx) => {
    const account = await loadBankAccount(tx, ctx.tenant.id, accountId);
    const lines = (
      await tx.execute<{
        id: string;
        line_on: string;
        description: string;
        reference: string | null;
        amount: string;
        matched_kind: "deposit" | "payment" | "expense" | "other" | null;
        match_note: string | null;
        matched_by: string | null;
        label: string | null;
      }>(sql`
        select l.id, l.line_on::text, l.description, l.reference, l.amount_pesewas::text as amount, l.matched_kind,
          l.match_note, l.matched_by_user_id as matched_by,
          case l.matched_kind
            when 'deposit' then (select 'Deposit ' || d.deposit_number from bank_deposits d where d.id = l.matched_id)
            when 'payment' then (select 'Receipt ' || p.receipt_number from payments p where p.id = l.matched_id)
            when 'expense' then (select 'Expense ' || e.expense_number || ' (' || e.payee || ')' from expenses e where e.id = l.matched_id)
            else l.match_note end as label
        from bank_statement_lines l
        where l.tenant_id = ${ctx.tenant.id} and l.account_id = ${accountId}
          and to_char(l.line_on, 'YYYY-MM') = ${month}
        order by l.line_on, l.id`)
    ).rows;
    const candidates = lines.some((l) => !l.matched_kind)
      ? await openCandidates(tx, ctx.tenant.id, accountId)
      : [];
    const views: StatementLineView[] = lines.map((l) => {
      const line = {
        lineOn: l.line_on,
        description: l.description,
        reference: l.reference,
        amountPesewas: Number(l.amount),
      };
      return {
        id: l.id,
        ...line,
        match: l.matched_kind
          ? {
              kind: l.matched_kind,
              label: l.label ?? "",
              automatic: l.matched_by === null && l.matched_kind !== "other",
            }
          : null,
        candidates: l.matched_kind ? [] : rankCandidates(line, candidates).slice(0, 3),
      };
    });
    const outstanding = (
      await tx.execute<{ kind: string; id: string; label: string; on: string; amount: string }>(sql`
        select 'deposit' as kind, d.id, 'Deposit ' || d.deposit_number as label, d.deposited_on::text as on,
          d.amount_pesewas::text as amount
        from bank_deposits d
        where d.tenant_id = ${ctx.tenant.id} and d.account_id = ${accountId} and d.cancelled_at is null
          and to_char(d.deposited_on, 'YYYY-MM') <= ${month}
          and not exists (select 1 from bank_statement_lines l where l.matched_kind = 'deposit' and l.matched_id = d.id)
        union all
        select 'expense', e.id, 'Expense ' || e.expense_number || ' (' || e.payee || ')', e.spent_on::text,
          e.amount_pesewas::text
        from expenses e
        where e.tenant_id = ${ctx.tenant.id} and e.account_id = ${accountId} and e.status = 'approved'
          and to_char(e.spent_on, 'YYYY-MM') <= ${month}
          and not exists (select 1 from bank_statement_lines l where l.matched_kind = 'expense' and l.matched_id = e.id)
        order by 4`)
    ).rows;
    const pick = (kind: string) =>
      outstanding
        .filter((o) => o.kind === kind)
        .map((o) => ({ id: o.id, label: o.label, on: o.on, amountPesewas: Number(o.amount) }));
    const unmatched = views.filter((v) => !v.match);
    return {
      account: {
        id: account.id,
        name: account.name,
        institution: account.institution,
        accountEnding: account.accountEnding,
      },
      month,
      lines: views,
      summary: {
        inPesewas: views.filter((v) => v.amountPesewas > 0).reduce((s, v) => s + v.amountPesewas, 0),
        outPesewas: views.filter((v) => v.amountPesewas < 0).reduce((s, v) => s - v.amountPesewas, 0),
        unmatchedLines: unmatched.length,
        unmatchedPesewas: unmatched.reduce((s, v) => s + Math.abs(v.amountPesewas), 0),
      },
      depositsNotOnStatement: pick("deposit"),
      expensesNotOnStatement: pick("expense"),
    };
  });
}

async function loadLine(tx: Transaction, tenantId: string, lineId: string) {
  if (!uuid.safeParse(lineId).success) throw new DomainError("not_found", "Statement line not found.");
  const [line] = await tx
    .select()
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, lineId)))
    .for("update");
  if (!line) throw new DomainError("not_found", "Statement line not found.");
  return line;
}

const matchSchema = z.union([
  z.object({ kind: z.enum(["deposit", "payment", "expense"]), id: uuid }),
  z.object({ kind: z.literal("other"), note: z.string().trim().min(3, "Say what this line is.").max(200) }),
]);

/**
 * Matches a line by hand: to a record it could be (same amount and direction; any date), or explains it with a note
 * (bank charges, interest). A record is matched to one line at most.
 */
export async function matchStatementLine(
  database: Database,
  ctx: TenantContext,
  lineId: string,
  input: unknown,
): Promise<void> {
  assertManager(ctx);
  const data = matchSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const line = await loadLine(tx, ctx.tenant.id, lineId);
    if (line.matchedKind)
      throw new DomainError("already_matched", "This line is already matched. Unmatch it first.");
    if (data.kind !== "other") {
      const candidate = (await openCandidates(tx, ctx.tenant.id, line.accountId)).find(
        (c) => c.kind === data.kind && c.id === data.id,
      );
      if (!candidate)
        throw new DomainError("not_found", "That record is not open for matching on this account.");
      if (candidate.amountPesewas !== line.amountPesewas)
        throw new DomainError(
          "amount_differs",
          `The line is for ${formatMoney(Math.abs(line.amountPesewas), ctx.tenant.currencyCode)}; ${candidate.label} is for ${formatMoney(Math.abs(candidate.amountPesewas), ctx.tenant.currencyCode)}.`,
        );
    }
    await tx
      .update(bankStatementLines)
      .set({
        matchedKind: data.kind,
        matchedId: data.kind === "other" ? null : data.id,
        matchNote: data.kind === "other" ? data.note : null,
        matchedAt: new Date(),
        matchedByUserId: ctx.userId,
      })
      .where(eq(bankStatementLines.id, line.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "bank_statement.matched",
      entityType: "bank_statement_line",
      entityId: line.id,
      metadata: data.kind === "other" ? { kind: "other", note: data.note } : { kind: data.kind, id: data.id },
    });
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError("already_matched", "That record is already matched to another line.");
    throw error;
  });
}

/** Undoes a match (made by hand or automatically), so the line and its record can be matched again. */
export async function unmatchStatementLine(
  database: Database,
  ctx: TenantContext,
  lineId: string,
): Promise<void> {
  assertManager(ctx);
  await withTenant(database, scope(ctx), async (tx) => {
    const line = await loadLine(tx, ctx.tenant.id, lineId);
    if (!line.matchedKind) return;
    await tx
      .update(bankStatementLines)
      .set({ matchedKind: null, matchedId: null, matchNote: null, matchedAt: null, matchedByUserId: null })
      .where(eq(bankStatementLines.id, line.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "bank_statement.unmatched",
      entityType: "bank_statement_line",
      entityId: line.id,
      metadata: { kind: line.matchedKind, id: line.matchedId, note: line.matchNote },
    });
  });
}

/** Runs automatic matching again (after deposits or expenses were recorded since the import). */
export async function rematchAccount(
  database: Database,
  ctx: TenantContext,
  accountId: string,
): Promise<number> {
  assertManager(ctx);
  return withTenant(database, scope(ctx), async (tx) => {
    await loadBankAccount(tx, ctx.tenant.id, accountId);
    return autoMatch(tx, ctx, accountId);
  });
}
