import type { BillingPeriod } from "./plan";
import type { PlanModuleId } from "./modules";

/**
 * EduBridge's prices for schools (founder, 2026-11-18): a plan is priced per term by school size, in bands of
 * active students; yearly costs less than three terms and monthly a little more than a third of a term. Students
 * are counted once a term, on the census day, whatever the billing period. Pure, so the rules are tested alone.
 */

/** The largest school each band covers. Above the last band the price is agreed with the school. */
export const SIZE_BANDS = [150, 300, 600, 1000] as const;

export interface PriceBand {
  /** The band covers schools with up to this many active students. */
  upTo: number;
  /** The plan's price for one term for a school in this band, in minor units. */
  termlyMinor: number;
}

export interface PricingRules {
  /** Off a year's terms when a school pays yearly, in basis points (1200 = 12%). */
  annualDiscountBp: number;
  /** On a month's share of the year when a school pays monthly, in basis points (1000 = 10%). */
  monthlySurchargeBp: number;
}

export const DEFAULT_PRICING_RULES: PricingRules = { annualDiscountBp: 1200, monthlySurchargeBp: 1000 };

/** True when bands are complete and sensible: one per size, rising with size. */
export function validBands(bands: readonly PriceBand[]): boolean {
  if (bands.length !== SIZE_BANDS.length) return false;
  return bands.every(
    (b, i) =>
      b.upTo === SIZE_BANDS[i] &&
      Number.isSafeInteger(b.termlyMinor) &&
      b.termlyMinor > 0 &&
      (i === 0 || b.termlyMinor >= bands[i - 1]!.termlyMinor),
  );
}

/** The band for a school this size: the smallest that covers it (a school of 0 or 1 is in the first). */
export function bandFor(students: number, bands: readonly PriceBand[]): PriceBand | null {
  return bands.find((b) => Math.max(1, students) <= b.upTo) ?? null;
}

/** "Up to 150 students", "151 to 300 students". */
export function bandLabel(band: PriceBand, bands: readonly PriceBand[]): string {
  const i = bands.findIndex((b) => b.upTo === band.upTo);
  const from = i > 0 ? bands[i - 1]!.upTo + 1 : null;
  return from === null
    ? `up to ${band.upTo.toLocaleString("en-GH")} students`
    : `${from.toLocaleString("en-GH")} to ${band.upTo.toLocaleString("en-GH")} students`;
}

/** Rounds to a whole unit of currency (100 minor units), so prices read cleanly. */
const whole = (minor: number) => Math.round(minor / 100) * 100;

/**
 * The price of a period from a termly price.
 *  termly:  the term's price;
 *  annual:  `terms` terms (the rest of the school year) less the yearly discount;
 *  monthly: a twelfth of the year's terms plus the monthly surcharge.
 */
export function periodPrice(
  termlyMinor: number,
  period: BillingPeriod,
  rules: PricingRules,
  terms: { inYear: number; covered: number },
): number {
  if (period === "termly") return termlyMinor;
  if (period === "annual") return whole(termlyMinor * terms.covered * (1 - rules.annualDiscountBp / 10_000));
  return whole(((termlyMinor * terms.inYear) / 12) * (1 + rules.monthlySurchargeBp / 10_000));
}

/** A termly-equivalent price for an add-on priced for another period, so it can be billed for any period. */
export function termlyEquivalent(minor: number, period: BillingPeriod, termsInYear: number): number {
  if (period === "termly") return minor;
  if (period === "annual") return Math.round(minor / termsInYear);
  return Math.round((minor * 12) / termsInYear);
}

/** The discount on an amount, in minor units (positive; shown as a negative line). */
export function discountOf(amountMinor: number, discountBp: number): number {
  return Math.round((amountMinor * discountBp) / 10_000);
}

/** "12%" from basis points. */
export function percentLabel(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

// ——— The suggested plans and add-on prices (starting points; the founder changes them on the Plans page) ———

export interface SuggestedPlan {
  name: string;
  description: string;
  features: PlanModuleId[];
  maxCampuses: number;
  maxSmsPerMonth: number;
  /** Termly price per band in Ghana cedis, smallest band first. */
  termlyCedis: [number, number, number, number];
}

const STARTER: PlanModuleId[] = ["parent_view", "fee_reminders", "mobile_money", "attendance", "assessment"];
const STANDARD: PlanModuleId[] = [
  ...STARTER,
  "admissions",
  "visitors_pickup",
  "command_center",
  "forecasting",
  "early_warning",
  "finance",
];
const PREMIUM: PlanModuleId[] = [...STANDARD, "staff_hr", "payroll", "whatsapp", "assistant", "ai_drafting"];

export const SUGGESTED_PLANS: readonly SuggestedPlan[] = [
  {
    name: "Starter",
    description: "Fees and families, Mobile Money, attendance and report cards.",
    features: STARTER,
    maxCampuses: 1,
    maxSmsPerMonth: 300,
    termlyCedis: [1200, 2100, 3600, 5500],
  },
  {
    name: "Standard",
    description:
      "Starter, plus admissions, visitors and pickup, school finances, the Command Center, forecasting and early warning.",
    features: STANDARD,
    maxCampuses: 2,
    maxSmsPerMonth: 800,
    termlyCedis: [1800, 3200, 5600, 8500],
  },
  {
    name: "Premium",
    description:
      "Standard, plus staff and HR, payroll, WhatsApp, the assistant and AI drafting, and more campuses.",
    features: PREMIUM,
    maxCampuses: 5,
    maxSmsPerMonth: 2000,
    termlyCedis: [2700, 4800, 8400, 12500],
  },
];

/** Add-ons on any plan, per term in Ghana cedis. */
export const SUGGESTED_ADD_ONS: readonly { module: PlanModuleId; termlyCedis: number }[] = [
  { module: "transport", termlyCedis: 450 },
  { module: "finance", termlyCedis: 400 },
  { module: "boarding", termlyCedis: 750 },
  { module: "library", termlyCedis: 300 },
  { module: "inventory_assets", termlyCedis: 300 },
  { module: "staff_hr", termlyCedis: 400 },
  { module: "payroll", termlyCedis: 400 },
];

export const bandsFromCedis = (cedis: readonly number[]): PriceBand[] =>
  SIZE_BANDS.map((upTo, i) => ({ upTo, termlyMinor: Math.round(cedis[i]! * 100) }));
