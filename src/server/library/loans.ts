import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { addDays, daysLate, DEFAULT_LOAN_DAYS, DEFAULT_MAX_LOANS, fineFor } from "../../lib/library";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Queryable, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  ledgerEntries,
  libraryCopies,
  libraryLoans,
  libraryReservations,
  librarySettings,
  libraryTitles,
  terms,
} from "../db/schema";
import { DomainError } from "../errors";
import { firstOpenDate } from "../fees/period-lock";
import {
  audit,
  optionalMoney,
  optionalText,
  requiredText,
  scopeOf,
  UUID,
  wholeNumber,
} from "../inventory/common";
import type { TenantContext } from "../tenancy/service";
import { borrowerNames, readBorrowerOptions, resolveBorrower, type Borrower } from "./borrowers";

/**
 * Loans, returns and reservations (R4-7 LIB-01c to LIB-01e), and fines (LIB-02). A copy has at most one open loan
 * (database); a closed loan never changes. A returned copy is held for the first reservation in the queue. A late
 * student's fine is charged to their fee account through the ledger, once per loan (billing key), and waived by
 * reversing it there like any charge.
 */

// ——— Rules ———

export interface LibraryRules {
  loanDays: number;
  maxLoans: number;
  finesEnabled: boolean;
  finePerDayMinor: number | null;
  fineCapMinor: number | null;
}

export async function readRules(tx: Queryable, tenantId: string): Promise<LibraryRules> {
  const [row] = await tx.select().from(librarySettings).where(eq(librarySettings.tenantId, tenantId));
  return row
    ? {
        loanDays: row.loanDays,
        maxLoans: row.maxLoans,
        finesEnabled: row.finesEnabled,
        finePerDayMinor: row.finePerDayMinor,
        fineCapMinor: row.fineCapMinor,
      }
    : {
        loanDays: DEFAULT_LOAN_DAYS,
        maxLoans: DEFAULT_MAX_LOANS,
        finesEnabled: false,
        finePerDayMinor: null,
        fineCapMinor: null,
      };
}

export async function getRules(database: Database, ctx: TenantContext): Promise<LibraryRules> {
  if (!allowed(ctx, "library.manage")) assertAllowed(ctx, "library.view");
  return withTenant(database, scopeOf(ctx), (tx) => readRules(tx, ctx.tenant.id));
}

async function upsertRules(
  tx: Transaction,
  ctx: TenantContext,
  values: Partial<typeof librarySettings.$inferInsert>,
) {
  const current = await readRules(tx, ctx.tenant.id);
  const next = { ...current, ...values, updatedByUserId: ctx.userId, updatedAt: new Date() };
  await tx
    .insert(librarySettings)
    .values({ tenantId: ctx.tenant.id, ...next })
    .onConflictDoUpdate({ target: librarySettings.tenantId, set: next });
}

/** How long loans last and how many books a borrower may have (LIB-01c). */
export async function saveLoanRules(database: Database, ctx: TenantContext, input: Record<string, unknown>) {
  assertAllowed(ctx, "library.manage");
  const data = z.object({ loanDays: wholeNumber(1, 365), maxLoans: wholeNumber(1, 50) }).parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await upsertRules(tx, ctx, data);
    await audit(tx, ctx, "library.rules_set", "tenant", ctx.tenant.id, data);
  });
}

/** Fines for late returns (LIB-02): a fee, so set by those who manage fees. */
export async function saveFineRules(database: Database, ctx: TenantContext, input: Record<string, unknown>) {
  assertAllowed(ctx, "fees.manage");
  assertAllowed(ctx, "library.view");
  const currency = ctx.tenant.currencyCode;
  const enabled = input.finesEnabled === "on" || input.finesEnabled === true;
  const perDay = optionalMoney(currency).safeParse(input.finePerDay);
  if (!perDay.success) throw new DomainError("invalid", "Enter an amount, e.g. 0.50.", "finePerDay");
  const cap = optionalMoney(currency).safeParse(input.fineCap);
  if (!cap.success) throw new DomainError("invalid", "Enter an amount, e.g. 10.00.", "fineCap");
  if (enabled && !perDay.data) throw new DomainError("invalid", "Enter the fine per day.", "finePerDay");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const values = {
      finesEnabled: enabled,
      finePerDayMinor: perDay.data || null,
      fineCapMinor: cap.data || null,
    };
    await upsertRules(tx, ctx, values);
    await audit(tx, ctx, "library.fines_set", "tenant", ctx.tenant.id, { ...values, currency });
  });
}

// ——— Loans ———

export async function listBorrowerOptions(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "library.manage");
  return withTenant(database, scopeOf(ctx), (tx) => readBorrowerOptions(tx, ctx.tenant.id));
}

const today = (ctx: TenantContext) => todayIn(ctx.tenant.timezone);

async function openLoanCount(tx: Transaction, tenantId: string, b: Borrower): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryLoans)
    .where(
      and(
        eq(libraryLoans.tenantId, tenantId),
        b.studentId
          ? eq(libraryLoans.studentId, b.studentId)
          : eq(libraryLoans.membershipId, b.membershipId!),
        isNull(libraryLoans.returnedAt),
        isNull(libraryLoans.lostAt),
      ),
    );
  return row!.n;
}

const sameBorrower = (r: { studentId: string | null; membershipId: string | null }, b: Borrower) =>
  (b.studentId !== null && r.studentId === b.studentId) ||
  (b.membershipId !== null && r.membershipId === b.membershipId);

/** Lends a copy (by its number) to a borrower, due after the school's loan period (LIB-01c). */
export async function lendCopy(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<{ title: string; borrower: string; dueOn: string }> {
  assertAllowed(ctx, "library.manage");
  const number = requiredText(1, 20, "Enter the copy number, e.g. B0012.").safeParse(input.copy);
  if (!number.success) throw new DomainError("invalid", "Enter the copy number, e.g. B0012.", "copy");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const borrower = await resolveBorrower(tx, ctx, input.borrower);
    const [copy] = await tx
      .select({
        id: libraryCopies.id,
        number: libraryCopies.number,
        status: libraryCopies.status,
        titleId: libraryCopies.titleId,
        title: libraryTitles.title,
      })
      .from(libraryCopies)
      .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
      .where(
        and(eq(libraryCopies.tenantId, ctx.tenant.id), eq(libraryCopies.number, number.data.toUpperCase())),
      )
      .for("update", { of: libraryCopies });
    if (!copy || copy.status !== "active")
      throw new DomainError("not_found", `No copy ${number.data.toUpperCase()} in the library.`, "copy");
    const [open] = await tx
      .select({ id: libraryLoans.id })
      .from(libraryLoans)
      .where(
        and(eq(libraryLoans.copyId, copy.id), isNull(libraryLoans.returnedAt), isNull(libraryLoans.lostAt)),
      );
    if (open) throw new DomainError("on_loan", `${copy.number} is already on loan. Return it first.`, "copy");

    // A copy held for a reservation goes only to that borrower; lending it to them fulfils the reservation.
    const held = await tx
      .select()
      .from(libraryReservations)
      .where(
        and(
          eq(libraryReservations.tenantId, ctx.tenant.id),
          eq(libraryReservations.heldCopyId, copy.id),
          eq(libraryReservations.status, "ready"),
        ),
      )
      .for("update");
    const hold = held[0];
    if (hold && !sameBorrower(hold, borrower)) {
      const names = await borrowerNames(tx, ctx.tenant.id, [hold]);
      throw new DomainError(
        "held",
        `${copy.number} is held for ${names.get(hold.studentId ?? hold.membershipId!) ?? "someone who reserved it"}.`,
        "copy",
      );
    }
    const rules = await readRules(tx, ctx.tenant.id);
    if ((await openLoanCount(tx, ctx.tenant.id, borrower)) >= rules.maxLoans)
      throw new DomainError(
        "limit",
        `${borrower.name} already has ${rules.maxLoans} ${rules.maxLoans === 1 ? "book" : "books"}. Return one first.`,
        "borrower",
      );
    const dueOn = addDays(today(ctx), rules.loanDays);
    const [loan] = await tx
      .insert(libraryLoans)
      .values({
        tenantId: ctx.tenant.id,
        copyId: copy.id,
        studentId: borrower.studentId,
        membershipId: borrower.membershipId,
        loanedByUserId: ctx.userId,
        dueOn,
      })
      .returning({ id: libraryLoans.id });
    const now = new Date();
    if (hold)
      await tx
        .update(libraryReservations)
        .set({ status: "fulfilled", closedAt: now, closedByUserId: ctx.userId })
        .where(eq(libraryReservations.id, hold.id));
    else {
      // The borrower may have been waiting for this title: they now have a copy.
      const [waiting] = await tx
        .select()
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.tenantId, ctx.tenant.id),
            eq(libraryReservations.titleId, copy.titleId),
            eq(libraryReservations.status, "waiting"),
            borrower.studentId
              ? eq(libraryReservations.studentId, borrower.studentId)
              : eq(libraryReservations.membershipId, borrower.membershipId!),
          ),
        );
      if (waiting) {
        await tx
          .update(libraryReservations)
          .set({ status: "ready", heldCopyId: copy.id, readyAt: now })
          .where(eq(libraryReservations.id, waiting.id));
        await tx
          .update(libraryReservations)
          .set({ status: "fulfilled", closedAt: now, closedByUserId: ctx.userId })
          .where(eq(libraryReservations.id, waiting.id));
      }
    }
    await audit(tx, ctx, "library.lent", "library_loan", loan!.id, { copy: copy.number, dueOn });
    return { title: copy.title, borrower: borrower.name, dueOn };
  });
}

/** Holds a copy for the first reservation waiting for its title, if any; returns who it is held for. */
async function holdForQueue(tx: Transaction, ctx: TenantContext, copyId: string, titleId: string) {
  const [next] = await tx
    .select()
    .from(libraryReservations)
    .where(
      and(
        eq(libraryReservations.tenantId, ctx.tenant.id),
        eq(libraryReservations.titleId, titleId),
        eq(libraryReservations.status, "waiting"),
      ),
    )
    .orderBy(asc(libraryReservations.reservedAt))
    .limit(1)
    .for("update");
  if (!next) return null;
  await tx
    .update(libraryReservations)
    .set({ status: "ready", heldCopyId: copyId, readyAt: new Date() })
    .where(eq(libraryReservations.id, next.id));
  const names = await borrowerNames(tx, ctx.tenant.id, [next]);
  return names.get(next.studentId ?? next.membershipId!) ?? null;
}

async function lockLoan(tx: Transaction, ctx: TenantContext, loanId: string) {
  if (!UUID.safeParse(loanId).success) throw new DomainError("not_found", "Loan not found.");
  const [loan] = await tx
    .select({
      l: libraryLoans,
      number: libraryCopies.number,
      titleId: libraryCopies.titleId,
      title: libraryTitles.title,
    })
    .from(libraryLoans)
    .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
    .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
    .where(and(eq(libraryLoans.tenantId, ctx.tenant.id), eq(libraryLoans.id, loanId)))
    .for("update", { of: libraryLoans });
  if (!loan) throw new DomainError("not_found", "Loan not found.");
  if (loan.l.returnedAt || loan.l.lostAt) throw new DomainError("closed", "This loan is already closed.");
  return loan;
}

/** The open loan of a copy number, for returning by number. */
export async function findOpenLoan(database: Database, ctx: TenantContext, number: unknown): Promise<string> {
  assertAllowed(ctx, "library.manage");
  const n = requiredText(1, 20, "Enter the copy number, e.g. B0012.").safeParse(number);
  if (!n.success) throw new DomainError("invalid", "Enter the copy number, e.g. B0012.", "copy");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({ id: libraryLoans.id })
      .from(libraryLoans)
      .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
      .where(
        and(
          eq(libraryLoans.tenantId, ctx.tenant.id),
          eq(libraryCopies.number, n.data.toUpperCase()),
          isNull(libraryLoans.returnedAt),
          isNull(libraryLoans.lostAt),
        ),
      );
    if (!row) throw new DomainError("not_found", `${n.data.toUpperCase()} is not on loan.`, "copy");
    return row.id;
  });
}

export interface ReturnResult {
  title: string;
  copy: string;
  daysLate: number;
  fineMinor: number;
  heldFor: string | null;
}

/**
 * Returns a book, once. A student returning late is charged the school's fine on their fee account (LIB-02), with
 * the loan as its billing key so it is never charged twice. The copy is then held for the next reservation.
 */
export async function returnLoan(
  database: Database,
  ctx: TenantContext,
  loanId: string,
): Promise<ReturnResult> {
  assertAllowed(ctx, "library.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const loan = await lockLoan(tx, ctx, loanId);
    const on = today(ctx);
    const late = daysLate(loan.l.dueOn, on);
    const rules = await readRules(tx, ctx.tenant.id);
    const fine = loan.l.studentId
      ? fineFor(late, {
          enabled: rules.finesEnabled,
          perDayMinor: rules.finePerDayMinor,
          capMinor: rules.fineCapMinor,
        })
      : 0;
    let ledgerEntryId: string | null = null;
    if (fine > 0) {
      const [term] = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
      const [entry] = await tx
        .insert(ledgerEntries)
        .values({
          tenantId: ctx.tenant.id,
          studentId: loan.l.studentId!,
          termId: term?.id ?? null,
          kind: "charge",
          description: `Library fine: ${loan.title}, ${late} ${late === 1 ? "day" : "days"} late`.slice(
            0,
            200,
          ),
          amountPesewas: fine,
          billingKey: `library:${loan.l.id}`,
          // In a closed period, the fine counts from the first open day (FIN-16).
          effectiveOn: await firstOpenDate(tx, ctx.tenant.id, on),
          recordedByUserId: ctx.userId,
        })
        .onConflictDoNothing({
          target: [ledgerEntries.tenantId, ledgerEntries.studentId, ledgerEntries.billingKey],
        })
        .returning({ id: ledgerEntries.id });
      ledgerEntryId = entry?.id ?? null;
    }
    await tx
      .update(libraryLoans)
      .set({
        returnedAt: new Date(),
        returnedByUserId: ctx.userId,
        fineMinor: fine > 0 ? fine : null,
        ledgerEntryId,
      })
      .where(eq(libraryLoans.id, loan.l.id));
    const heldFor = await holdForQueue(tx, ctx, loan.l.copyId, loan.titleId);
    await audit(tx, ctx, "library.returned", "library_loan", loan.l.id, {
      copy: loan.number,
      daysLate: late,
      ...(fine > 0 ? { fineMinor: fine, currency: ctx.tenant.currencyCode } : {}),
    });
    return { title: loan.title, copy: loan.number, daysLate: late, fineMinor: fine, heldFor };
  });
}

/** Renews an open loan from today. Not for an overdue book, nor one someone is waiting for. */
export async function renewLoan(database: Database, ctx: TenantContext, loanId: string): Promise<string> {
  assertAllowed(ctx, "library.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const loan = await lockLoan(tx, ctx, loanId);
    const on = today(ctx);
    const late = daysLate(loan.l.dueOn, on);
    if (late > 0)
      throw new DomainError(
        "overdue",
        `This book is ${late} ${late === 1 ? "day" : "days"} late. Return it first.`,
      );
    const [waiting] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(libraryReservations)
      .where(and(eq(libraryReservations.titleId, loan.titleId), eq(libraryReservations.status, "waiting")));
    if (waiting!.n > 0)
      throw new DomainError("reserved", "Someone is waiting for this title. Return it instead.");
    const rules = await readRules(tx, ctx.tenant.id);
    const dueOn = addDays(on, rules.loanDays);
    await tx
      .update(libraryLoans)
      .set({ dueOn, renewals: loan.l.renewals + 1 })
      .where(eq(libraryLoans.id, loan.l.id));
    await audit(tx, ctx, "library.renewed", "library_loan", loan.l.id, { copy: loan.number, dueOn });
    return dueOn;
  });
}

/** Closes a loan as lost and withdraws the copy. A charge for the book is added by the Accountant if wanted. */
export async function markLost(database: Database, ctx: TenantContext, loanId: string, noteInput: unknown) {
  assertAllowed(ctx, "library.manage");
  const note = optionalText(150).parse(noteInput ?? null) ?? null;
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const loan = await lockLoan(tx, ctx, loanId);
    const now = new Date();
    await tx
      .update(libraryLoans)
      .set({ lostAt: now, lostByUserId: ctx.userId })
      .where(eq(libraryLoans.id, loan.l.id));
    await tx
      .update(libraryCopies)
      .set({
        status: "withdrawn",
        withdrawnAt: now,
        withdrawnReason: `Lost on loan${note ? `: ${note}` : ""}`,
      })
      .where(eq(libraryCopies.id, loan.l.copyId));
    await audit(tx, ctx, "library.lost", "library_loan", loan.l.id, { copy: loan.number });
  });
}

export interface OpenLoan {
  id: string;
  copy: string;
  title: string;
  borrower: string;
  className: string | null;
  isStudent: boolean;
  loanedAt: Date;
  dueOn: string;
  daysLate: number;
  renewals: number;
}

/** Books out now, most overdue first (LIB-01d). */
export async function listOpenLoans(database: Database, ctx: TenantContext): Promise<OpenLoan[]> {
  if (!allowed(ctx, "library.manage")) assertAllowed(ctx, "library.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const rows = await tx
      .select({
        l: libraryLoans,
        copy: libraryCopies.number,
        title: libraryTitles.title,
        className: classes.name,
      })
      .from(libraryLoans)
      .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
      .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
      .leftJoin(
        enrolments,
        and(
          eq(enrolments.studentId, libraryLoans.studentId),
          sql`${enrolments.termId} = (select id from terms where tenant_id = ${ctx.tenant.id} and is_current)`,
        ),
      )
      .leftJoin(classes, eq(classes.id, enrolments.classId))
      .where(
        and(
          eq(libraryLoans.tenantId, ctx.tenant.id),
          isNull(libraryLoans.returnedAt),
          isNull(libraryLoans.lostAt),
        ),
      )
      .orderBy(asc(libraryLoans.dueOn), asc(libraryLoans.loanedAt), asc(libraryLoans.id));
    const names = await borrowerNames(
      tx,
      ctx.tenant.id,
      rows.map((r) => r.l),
    );
    const on = today(ctx);
    return rows.map((r) => ({
      id: r.l.id,
      copy: r.copy,
      title: r.title,
      borrower: names.get(r.l.studentId ?? r.l.membershipId!) ?? "Unknown",
      className: r.className,
      isStudent: r.l.studentId !== null,
      loanedAt: r.l.loanedAt,
      dueOn: r.l.dueOn,
      daysLate: daysLate(r.l.dueOn, on),
      renewals: r.l.renewals,
    }));
  });
}

// ——— Reservations (LIB-01e) ———

/** Puts a borrower in the queue for a title when no copy is in. */
export async function reserveTitle(
  database: Database,
  ctx: TenantContext,
  titleId: string,
  borrowerKey: unknown,
): Promise<void> {
  assertAllowed(ctx, "library.manage");
  if (!UUID.safeParse(titleId).success) throw new DomainError("not_found", "Title not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const borrower = await resolveBorrower(tx, ctx, borrowerKey);
    const [title] = await tx
      .select({ id: libraryTitles.id, status: libraryTitles.status })
      .from(libraryTitles)
      .where(and(eq(libraryTitles.tenantId, ctx.tenant.id), eq(libraryTitles.id, titleId)))
      .for("update");
    if (!title || title.status !== "active") throw new DomainError("not_found", "Title not found.");
    const [free] = await tx
      .execute<{ n: number }>(
        sql`
      select count(*)::int as n from library_copies c
      where c.title_id = ${titleId} and c.status = 'active'
        and not exists (select 1 from library_loans l where l.copy_id = c.id and l.returned_at is null and l.lost_at is null)
        and not exists (select 1 from library_reservations r where r.held_copy_id = c.id and r.status = 'ready')`,
      )
      .then((r) => r.rows);
    if (free!.n > 0) throw new DomainError("available", "A copy is in: lend it instead.", "borrower");
    const inserted = await tx
      .insert(libraryReservations)
      .values({
        tenantId: ctx.tenant.id,
        titleId,
        studentId: borrower.studentId,
        membershipId: borrower.membershipId,
        reservedByUserId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: libraryReservations.id });
    if (!inserted.length)
      throw new DomainError("queued", `${borrower.name} is already waiting for this title.`, "borrower");
    await audit(tx, ctx, "library.reserved", "library_title", titleId);
  });
}

/** Cancels a reservation; a copy it held goes to the next in the queue. */
export async function cancelReservation(database: Database, ctx: TenantContext, reservationId: string) {
  assertAllowed(ctx, "library.manage");
  if (!UUID.safeParse(reservationId).success) throw new DomainError("not_found", "Reservation not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [r] = await tx
      .select()
      .from(libraryReservations)
      .where(and(eq(libraryReservations.tenantId, ctx.tenant.id), eq(libraryReservations.id, reservationId)))
      .for("update");
    if (!r || (r.status !== "waiting" && r.status !== "ready"))
      throw new DomainError("not_found", "This reservation is already closed.");
    await tx
      .update(libraryReservations)
      .set({ status: "cancelled", closedAt: new Date(), closedByUserId: ctx.userId })
      .where(eq(libraryReservations.id, r.id));
    if (r.status === "ready" && r.heldCopyId) await holdForQueue(tx, ctx, r.heldCopyId, r.titleId);
    await audit(tx, ctx, "library.reservation_cancelled", "library_title", r.titleId);
  });
}

// ——— The parent view ———

/** A child's books on loan, for the parent view (no user: the parent's tenant transaction). */
export async function readParentLibrary(tx: Transaction, tenantId: string, studentId: string, on: string) {
  const rows = await tx
    .select({ title: libraryTitles.title, dueOn: libraryLoans.dueOn })
    .from(libraryLoans)
    .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
    .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
    .where(
      and(
        eq(libraryLoans.tenantId, tenantId),
        eq(libraryLoans.studentId, studentId),
        isNull(libraryLoans.returnedAt),
        isNull(libraryLoans.lostAt),
      ),
    )
    .orderBy(asc(libraryLoans.dueOn));
  return rows.map((r) => ({ ...r, daysLate: daysLate(r.dueOn, on) }));
}
