import { parseCsv } from "./csv";

/**
 * School money beyond fees (2026-11-18): pure helpers for expenses, bank statements and matching. Kept free of the
 * database so the rules are tested on their own.
 */

/** Suggested spending categories for a Ghanaian private school; a school can type its own. Assumption to verify. */
export const EXPENSE_CATEGORIES = [
  "Salaries and allowances",
  "Feeding and kitchen",
  "Utilities",
  "Teaching and learning materials",
  "Repairs and maintenance",
  "Transport and fuel",
  "Rent",
  "Stationery and printing",
  "Cleaning and sanitation",
  "Internet and phone",
  "Taxes and levies",
  "Bank charges",
  "Other",
] as const;

export const EXPENSE_METHODS = ["cash", "bank_transfer", "cheque", "mobile_money"] as const;
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];
export const EXPENSE_METHOD_LABELS: Record<ExpenseMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  mobile_money: "Mobile Money",
};

export const ACCOUNT_KINDS = ["bank", "cash", "mobile_money"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  bank: "Bank account",
  cash: "Cash (office or safe)",
  mobile_money: "Mobile Money wallet",
};

/** Cash or cheques held longer than this many days without being banked are flagged in finance checks. */
export const UNBANKED_DAYS = 3;
/** How far apart a statement line and a deposit or expense may be dated and still match (days). */
export const MATCH_WINDOW_DAYS = 5;

export interface StatementLine {
  lineOn: string;
  description: string;
  reference: string | null;
  /** Money in is positive, money out negative (minor units). */
  amountPesewas: number;
}

export interface ParsedStatement {
  lines: StatementLine[];
  /** Rows that could not be read, with their row number in the file. */
  problems: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date as banks write it: 2026-11-05, 05/11/2026, 05-11-2026, 05-Nov-2026 or 5 Nov 2026 (day first). */
export function parseStatementDate(text: string): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t)))
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2}|\d{4})$/.exec(t))) {
    const month = MONTHS.indexOf(match[2]!.toLowerCase());
    if (month < 0) return null;
    [d, m, y] = [Number(match[1]), month + 1, Number(match[3])];
  } else return null;
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * An amount as banks write it, in minor units with its sign: "1,200.50", "-300", "(300.00)", "300.00 DR",
 * "GHS 1,000.00 CR". Two decimal places at most. Null when it is not an amount; 0 for a blank cell.
 */
export function parseStatementAmount(text: string): number | null {
  let t = text.trim().toUpperCase();
  if (t === "" || t === "-") return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  if (/\bDR\.?$/.test(t)) {
    sign = -1;
    t = t.replace(/\bDR\.?$/, "");
  } else t = t.replace(/\bCR\.?$/, "");
  t = t.replace(/^[A-Z₵$€£₦]+\.?\s*/, "").replace(/[\s,]/g, "");
  if (t.startsWith("-")) {
    sign = -sign;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(minor) ? sign * minor : null;
}

const has = (header: string, words: readonly string[]) => words.some((w) => header.includes(w));
/** Short words ("dr", "cr") must be the whole header, or "description" would count as a credit column. */
const isColumn = (header: string, words: readonly string[]) =>
  !header.includes("balance") && words.some((w) => (w.length <= 2 ? header === w : header.includes(w)));
const HEADERS = {
  date: ["date", "value date", "posting date", "txn date", "transaction date"],
  description: ["description", "narration", "details", "particulars", "remarks", "transaction"],
  reference: ["reference", "ref", "cheque", "chq", "document"],
  amount: ["amount"],
  debit: ["debit", "withdrawal", "money out", "paid out", "dr"],
  credit: ["credit", "deposit", "money in", "paid in", "lodgement", "cr"],
};

/**
 * Reads a bank statement saved as CSV. It finds the header row (the first row with a date column and either an
 * amount or debit and credit columns) and reads the lines below it. Balance columns are ignored.
 */
export function parseBankStatement(text: string): ParsedStatement {
  const rows = parseCsv(text);
  const problems: string[] = [];
  const headerIndex = rows.findIndex((r) => {
    const h = r.map((c) => c.trim().toLowerCase());
    return (
      h.some((c) => has(c, HEADERS.date)) &&
      (h.some((c) => has(c, HEADERS.amount)) ||
        (h.some((c) => isColumn(c, HEADERS.debit)) && h.some((c) => isColumn(c, HEADERS.credit))))
    );
  });
  if (headerIndex < 0)
    return {
      lines: [],
      problems: [
        "No header row found. The file needs a Date column and an Amount column, or Debit and Credit.",
      ],
    };
  const header = rows[headerIndex]!.map((c) => c.trim().toLowerCase());
  const find = (words: readonly string[], except: readonly string[] = []) =>
    header.findIndex((c) => has(c, words) && !has(c, except) && !c.includes("balance"));
  const col = {
    date: find(HEADERS.date),
    description: find(HEADERS.description, ["date"]),
    reference: find(HEADERS.reference, ["date", "description", "narration"]),
    amount: find(HEADERS.amount),
    debit: header.findIndex((c) => isColumn(c, HEADERS.debit)),
    credit: header.findIndex((c) => isColumn(c, HEADERS.credit)),
  };
  const lines: StatementLine[] = [];
  rows.slice(headerIndex + 1).forEach((row, i) => {
    const at = headerIndex + i + 2;
    const cell = (index: number) => (index >= 0 ? (row[index] ?? "").trim() : "");
    const lineOn = parseStatementDate(cell(col.date));
    if (!lineOn) {
      // Totals and closing-balance rows have no date: skip them quietly unless they look like a transaction.
      if (cell(col.date) !== "") problems.push(`Row ${at}: "${cell(col.date)}" is not a date.`);
      return;
    }
    let amount: number | null;
    if (col.amount >= 0 && cell(col.amount) !== "") amount = parseStatementAmount(cell(col.amount));
    else {
      const debit = parseStatementAmount(cell(col.debit));
      const credit = parseStatementAmount(cell(col.credit));
      amount = debit === null || credit === null ? null : credit - Math.abs(debit);
    }
    if (amount === null) {
      problems.push(`Row ${at}: the amount could not be read.`);
      return;
    }
    if (amount === 0) return;
    const description = (cell(col.description) || cell(col.reference) || "Statement line").slice(0, 300);
    const reference = cell(col.reference).slice(0, 120) || null;
    lines.push({ lineOn, description, reference, amountPesewas: amount });
  });
  return { lines, problems };
}

/**
 * A stable key per line so the same statement imported twice adds nothing: its date, amount, reference and
 * description, and how many identical lines came before it in the file (two GH₵50 charges on one day are two lines).
 */
export function statementLineKeys(lines: readonly StatementLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [
      l.lineOn,
      l.amountPesewas,
      (l.reference ?? "").toLowerCase(),
      l.description.toLowerCase(),
    ].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`.slice(0, 500);
  });
}

export interface MatchCandidate {
  kind: "deposit" | "payment" | "expense";
  id: string;
  on: string;
  /** Signed as the statement shows it: deposits and family bank payments in (+), expenses out (-). */
  amountPesewas: number;
  /** A deposit slip, transfer or cheque reference, to compare with the statement's. */
  reference: string | null;
  label: string;
}

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const norm = (text: string | null) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whether a candidate's reference appears in the statement line's reference or description. */
function referenceMatches(line: StatementLine, c: MatchCandidate): boolean {
  const ref = norm(c.reference);
  return ref.length >= 4 && (norm(line.reference).includes(ref) || norm(line.description).includes(ref));
}

/**
 * The records a statement line could be: same amount and direction, dated within the window (or any date when the
 * references agree), best first: matching reference, then the nearest date.
 */
export function rankCandidates(line: StatementLine, candidates: readonly MatchCandidate[]): MatchCandidate[] {
  return candidates
    .filter(
      (c) =>
        c.amountPesewas === line.amountPesewas &&
        (days(c.on, line.lineOn) <= MATCH_WINDOW_DAYS || referenceMatches(line, c)),
    )
    .map((c) => ({ c, ref: referenceMatches(line, c), gap: days(c.on, line.lineOn) }))
    .sort((a, b) => Number(b.ref) - Number(a.ref) || a.gap - b.gap)
    .map(({ c }) => c);
}

/**
 * The one record a line can be matched to without a person: a single candidate, or a single one whose reference
 * agrees. Anything less certain is left for someone to choose.
 */
export function automaticMatch(
  line: StatementLine,
  candidates: readonly MatchCandidate[],
): MatchCandidate | null {
  const ranked = rankCandidates(line, candidates);
  if (ranked.length === 1) return ranked[0]!;
  const byRef = ranked.filter((c) => referenceMatches(line, c));
  return byRef.length === 1 ? byRef[0]! : null;
}
