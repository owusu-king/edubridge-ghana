/**
 * What a school's plan includes. EduBridge staff choose per school (no packages are built in), and the
 * server checks every feature on each request (TEN-05).
 */

export const FEATURES = [
  "attendance",
  "assessment",
  "parent_view",
  "fee_reminders",
  "mobile_money",
  "assistant",
] as const;
export type Feature = (typeof FEATURES)[number];

/** What a new plan includes unless EduBridge staff choose otherwise: everything but paid add-ons. */
export const DEFAULT_PLAN_FEATURES: readonly Feature[] = FEATURES.filter((f) => f !== "assistant");

export const FEATURE_LABELS: Record<Feature, { name: string; description: string }> = {
  attendance: { name: "Attendance", description: "Daily class registers, including without a connection." },
  assessment: {
    name: "Assessment and report cards",
    description: "Score sheets, report cards and printing.",
  },
  parent_view: { name: "Parent view", description: "Families sign in by SMS code to see fees and reports." },
  fee_reminders: { name: "SMS fee reminders", description: "Reminders to families who owe, by SMS." },
  mobile_money: { name: "Mobile Money", description: "Payment prompts to a payer's phone." },
  assistant: {
    name: "School assistant (AI)",
    description: "Questions about the school answered from its own records, for leaders and the accountant.",
  },
};

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

export const SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "grace"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trial: "Trial",
  active: "Active",
  past_due: "Payment overdue",
  grace: "Grace period",
};

export const BILLING_PERIODS = ["termly", "annual", "monthly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  termly: "Per term",
  annual: "Per year",
  monthly: "Per month",
};

/** One line of an EduBridge invoice to a school. */
export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPesewas: number;
  amountPesewas: number;
}

/** A month as "2026-11", for usage reports. */
export const monthOf = (isoDate: string) => isoDate.slice(0, 7);

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-GH", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

/** The month before "2026-11" is "2026-10". */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** How an overdue EduBridge invoice affects a school right now. */
export interface BillingState {
  /** ok: nothing overdue; grace: overdue but within the grace days; limited: SMS to families paused. */
  state: "ok" | "grace" | "limited";
  /** Due date of the oldest unpaid invoice that is overdue. */
  overdueSince: string | null;
  /** The last day of the grace period (SMS pause the day after). */
  graceEndsOn: string | null;
}

export const BILLING_OK: BillingState = { state: "ok", overdueSince: null, graceEndsOn: null };

/**
 * Worked out from the school's unpaid invoices every time (never stored, so it cannot drift): an invoice
 * unpaid after its due date gives `graceDays` days of grace, then school-initiated SMS pause until it is
 * paid. Platform staff can also set the status to "payment overdue" by hand, which pauses SMS at once.
 */
export function billingState(input: {
  manualStatus: SubscriptionStatus;
  unpaidDueDates: readonly string[];
  today: string;
  graceDays: number;
}): BillingState {
  const overdue = input.unpaidDueDates.filter((d) => d < input.today).sort()[0] ?? null;
  if (!overdue)
    return input.manualStatus === "past_due"
      ? { state: "limited", overdueSince: null, graceEndsOn: null }
      : BILLING_OK;
  const graceEndsOn = addDaysIso(overdue, input.graceDays);
  return { state: input.today > graceEndsOn ? "limited" : "grace", overdueSince: overdue, graceEndsOn };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
