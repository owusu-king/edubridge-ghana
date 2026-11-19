/**
 * A statement for a date range (FIN-12): the opening balance before the range, the entries in it, and
 * the closing balance at its end, so that opening + charges − payments ± adjustments = closing. Worked
 * out from the same ledger entries as the account on screen. Shared by server and PDFs.
 */

export interface PeriodEntry {
  kind: string;
  effectiveOn: string;
  amountPesewas: number;
}

export interface StatementPeriod<E extends PeriodEntry> {
  from: string | null;
  to: string | null;
  openingPesewas: number;
  entries: E[];
  chargesPesewas: number;
  /** Payments received in the range, as a positive amount. */
  paymentsPesewas: number;
  /** Everything else: discounts, reversals, voided receipts, refunds, opening balances, adjustments. */
  adjustmentsPesewas: number;
  closingPesewas: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD date, or null. */
export function parseStatementDate(value: string | null | undefined): string | null {
  if (!value || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

export function statementPeriod<E extends PeriodEntry>(
  entries: E[],
  from: string | null,
  to: string | null,
): StatementPeriod<E> {
  let opening = 0;
  let charges = 0;
  let payments = 0;
  let adjustments = 0;
  const inRange: E[] = [];
  for (const e of entries) {
    if (from && e.effectiveOn < from) {
      opening += e.amountPesewas;
      continue;
    }
    if (to && e.effectiveOn > to) continue;
    inRange.push(e);
    if (e.kind === "charge") charges += e.amountPesewas;
    else if (e.kind === "payment") payments -= e.amountPesewas;
    else adjustments += e.amountPesewas;
  }
  return {
    from,
    to,
    openingPesewas: opening,
    entries: inRange,
    chargesPesewas: charges,
    paymentsPesewas: payments,
    adjustmentsPesewas: adjustments,
    closingPesewas: opening + charges - payments + adjustments,
  };
}
