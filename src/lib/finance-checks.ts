/**
 * Finance checks (R5-2, FCT-02): rules applied to the fee records that point out what someone should look at. They
 * are not accusations: each flag says what the records show and links to them, and a person reviews it with a note.
 * The thresholds are fixed for now (an assumption to verify with pilot schools); school settings come later.
 */

export const FINANCE_CHECK_RULES = [
  "duplicate_reference",
  "many_voids",
  "out_of_hours",
  "momo_unmatched",
  "large_refund",
  "period_reopened",
  "cash_not_banked",
] as const;
export type FinanceCheckRule = (typeof FINANCE_CHECK_RULES)[number];

export const FINANCE_CHECK_LABELS: Record<FinanceCheckRule, { title: string; why: string }> = {
  duplicate_reference: {
    title: "The same reference on two receipts",
    why: "A bank slip or transfer reference should be used once; a repeat can mean one payment entered twice.",
  },
  many_voids: {
    title: "Many receipts voided by one person",
    why: "Voids are normal, but several by one person in a term are worth a look.",
  },
  out_of_hours: {
    title: "Receipts recorded out of hours",
    why: "Receipts entered by a person late at night or early in the morning, school time.",
  },
  momo_unmatched: {
    title: "Mobile Money differences open over a day",
    why: "The provider and EduBridge disagree about a payment, and nobody has looked at it yet.",
  },
  large_refund: {
    title: "Large refunds",
    why: "Refunds of 1,000 or more in the school's currency.",
  },
  period_reopened: {
    title: "A closed period reopened",
    why: "Days the accounts were closed to were opened again for changes.",
  },
  cash_not_banked: {
    title: "Cash and cheques not banked",
    why: "Cash or cheques received more than three days ago are not in a deposit yet: someone is still holding them.",
  },
};

/** Three or more voids by one person in the term's dates. */
export const VOIDS_THRESHOLD = 3;
/** Refunds of this many minor units or more (1,000 in the school's currency). */
export const LARGE_REFUND_MINOR = 100_000;
/** Receipts recorded by a person from this hour (school time)... */
export const LATE_FROM_HOUR = 20;
/** ...until this hour. */
export const EARLY_UNTIL_HOUR = 6;

/** A review note: what was found, or why the flag is fine. */
export const REVIEW_NOTE = { min: 3, max: 500 } as const;
