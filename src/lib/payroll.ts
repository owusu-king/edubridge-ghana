/**
 * Payroll records (R4-2): the arithmetic, kept pure so it can be tested on its own. Money is integer minor
 * units (pesewas for GHS); percentages are basis points (1% = 100). Each line is rounded half up to a whole
 * minor unit. No statutory rates live here: the school enters its own components (PRL-01a).
 */

export const COMPONENT_KINDS = ["earning", "deduction", "employer"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = {
  earning: "Earning",
  deduction: "Deduction",
  employer: "Employer contribution",
};

/** fixed: an amount; percent_basic / percent_gross: basis points of basic salary or of gross pay. */
export const COMPONENT_BASES = ["fixed", "percent_basic", "percent_gross"] as const;
export type ComponentBasis = (typeof COMPONENT_BASES)[number];

export const COMPONENT_BASIS_LABELS: Record<ComponentBasis, string> = {
  fixed: "Fixed amount",
  percent_basic: "Percentage of basic salary",
  percent_gross: "Percentage of gross pay",
};

/** Earnings cannot depend on gross pay, which they make up. */
export const basisAllowed = (kind: ComponentKind, basis: ComponentBasis) =>
  !(kind === "earning" && basis === "percent_gross");

/** Names schools commonly use, without rates: each school sets its own amounts or percentages. */
export const SUGGESTED_COMPONENTS: readonly { name: string; kind: ComponentKind; basis: ComponentBasis }[] = [
  { name: "Transport allowance", kind: "earning", basis: "fixed" },
  { name: "Responsibility allowance", kind: "earning", basis: "fixed" },
  { name: "SSNIT (employee)", kind: "deduction", basis: "percent_basic" },
  { name: "Income tax (PAYE)", kind: "deduction", basis: "fixed" },
  { name: "Welfare dues", kind: "deduction", basis: "fixed" },
  { name: "SSNIT (employer)", kind: "employer", basis: "percent_basic" },
];

export interface PayComponentInput {
  name: string;
  kind: ComponentKind;
  basis: ComponentBasis;
  /** Minor units for fixed amounts; basis points for percentages. */
  value: number;
}

export interface PayAdjustmentInput {
  description: string;
  kind: "earning" | "deduction";
  /** Minor units, positive. */
  amount: number;
}

export interface PayItem {
  name: string;
  kind: ComponentKind;
  /** How it was worked out, for the payslip: "5.5% of basic", or null for a fixed amount. */
  basis: string | null;
  amount: number;
  adjustment?: boolean;
}

export interface PayLine {
  basic: number;
  items: PayItem[];
  gross: number;
  deductions: number;
  net: number;
  employer: number;
}

/** amount × basis points / 10,000, rounded half up (amounts are never negative here). */
export function percentOf(amount: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(basisPoints) || amount < 0 || basisPoints < 0)
    throw new Error("Amounts and percentages must be whole, non-negative numbers.");
  return Math.floor((amount * basisPoints + 5000) / 10000);
}

export const formatBasisPoints = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/**
 * One person's pay for a month: basic plus earnings (fixed, or a share of basic) and earning adjustments make
 * gross pay; deductions (fixed, a share of basic or of gross) and deduction adjustments come off it; employer
 * contributions are the school's cost and do not reduce net pay.
 */
export function calculatePay(
  basic: number,
  components: readonly PayComponentInput[],
  adjustments: readonly PayAdjustmentInput[] = [],
): PayLine {
  if (!Number.isSafeInteger(basic) || basic < 0)
    throw new Error("Basic salary must be a whole, non-negative amount.");
  const items: PayItem[] = [];
  const amountOf = (c: PayComponentInput, gross: number) => {
    if (!basisAllowed(c.kind, c.basis))
      throw new Error(`${c.name}: an earning cannot be a share of gross pay.`);
    if (c.basis === "fixed") {
      if (!Number.isSafeInteger(c.value) || c.value < 0)
        throw new Error(`${c.name}: amount must be whole and not negative.`);
      return c.value;
    }
    return percentOf(c.basis === "percent_basic" ? basic : gross, c.value);
  };
  const describe = (c: PayComponentInput) =>
    c.basis === "fixed"
      ? null
      : `${formatBasisPoints(c.value)} of ${c.basis === "percent_basic" ? "basic" : "gross"}`;

  let gross = basic;
  for (const c of components.filter((c) => c.kind === "earning")) {
    const amount = amountOf(c, 0);
    items.push({ name: c.name, kind: "earning", basis: describe(c), amount });
    gross += amount;
  }
  for (const a of adjustments.filter((a) => a.kind === "earning")) {
    items.push({ name: a.description, kind: "earning", basis: null, amount: a.amount, adjustment: true });
    gross += a.amount;
  }
  let deductions = 0;
  for (const c of components.filter((c) => c.kind === "deduction")) {
    const amount = amountOf(c, gross);
    items.push({ name: c.name, kind: "deduction", basis: describe(c), amount });
    deductions += amount;
  }
  for (const a of adjustments.filter((a) => a.kind === "deduction")) {
    items.push({ name: a.description, kind: "deduction", basis: null, amount: a.amount, adjustment: true });
    deductions += a.amount;
  }
  let employer = 0;
  for (const c of components.filter((c) => c.kind === "employer")) {
    const amount = amountOf(c, gross);
    items.push({ name: c.name, kind: "employer", basis: describe(c), amount });
    employer += amount;
  }
  return { basic, items, gross, deductions, net: gross - deductions, employer };
}

/** Totals of a run's lines. */
export interface PayrollTotals {
  people: number;
  basic: number;
  gross: number;
  deductions: number;
  net: number;
  employer: number;
}

export function payrollTotals(
  lines: readonly Pick<PayLine, "basic" | "gross" | "deductions" | "net" | "employer">[],
): PayrollTotals {
  return lines.reduce<PayrollTotals>(
    (t, l) => ({
      people: t.people + 1,
      basic: t.basic + l.basic,
      gross: t.gross + l.gross,
      deductions: t.deductions + l.deductions,
      net: t.net + l.net,
      employer: t.employer + l.employer,
    }),
    { people: 0, basic: 0, gross: 0, deductions: 0, net: 0, employer: 0 },
  );
}

/** "2026-11" → first and last day of the month. */
export function monthBounds(month: string): { first: string; last: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Use a month like 2026-11.");
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, "0")}` };
}

export const PAYROLL_STATUSES = ["draft", "approved", "cancelled"] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const PAYROLL_STATUS_LABELS: Record<PayrollStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  cancelled: "Cancelled",
};
