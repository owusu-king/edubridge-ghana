import { addDays } from "./attendance";

/**
 * Calculations behind the school overview. Pure, so the rules are unit-tested and the figures can be
 * checked against the reports they summarise.
 */

/** Whole days from one calendar date to another (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A whole-number percentage, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export const AGE_BUCKETS = [
  { label: "Up to 30 days", maxDays: 30 },
  { label: "31 to 60 days", maxDays: 60 },
  { label: "61 to 90 days", maxDays: 90 },
  { label: "Over 90 days", maxDays: Number.POSITIVE_INFINITY },
] as const;

export interface AgedLine {
  amountPesewas: number;
  /** The day the entry counts from. */
  effectiveOn: string;
}

/**
 * How old the unpaid part of a student's account is, in pesewas per AGE_BUCKETS. Credits (payments,
 * discounts, negative adjustments) settle the oldest debits first, so what is still owed is the most
 * recent debits. Pass entries in ledger order, leaving out reversed entries and their reversals (each
 * pair nets to zero). The buckets add up to the balance when it is owed, and to zero when it is not.
 */
export function ageOwed(lines: readonly AgedLine[], today: string): number[] {
  let credit = lines.reduce((sum, l) => (l.amountPesewas < 0 ? sum - l.amountPesewas : sum), 0);
  const buckets = AGE_BUCKETS.map(() => 0);
  // Stable: entries on the same day keep their ledger order.
  const debits = lines
    .filter((l) => l.amountPesewas > 0)
    .sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  for (const line of debits) {
    const settled = Math.min(credit, line.amountPesewas);
    credit -= settled;
    const unpaid = line.amountPesewas - settled;
    if (unpaid === 0) continue;
    // Charges dated ahead (a term billed early) count as new.
    const age = Math.max(0, daysBetween(line.effectiveOn, today));
    buckets[AGE_BUCKETS.findIndex((b) => age <= b.maxDays)]! += unpaid;
  }
  return buckets;
}

/** Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export interface WeekTotal {
  /** First and last day of the week counted (clipped to the period). */
  from: string;
  to: string;
  totalPesewas: number;
}

/**
 * Daily totals gathered into weeks (Monday to Sunday) covering `from` to `to`. Weeks with nothing are
 * kept, as zero, so a quiet week shows as a gap rather than disappearing.
 */
export function weeklyTotals(
  days: readonly { date: string; totalPesewas: number }[],
  from: string,
  to: string,
): WeekTotal[] {
  if (to < from) return [];
  const weeks: WeekTotal[] = [];
  for (let start = weekStart(from); start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    const clipped = { from: start < from ? from : start, to: end > to ? to : end };
    weeks.push({
      ...clipped,
      totalPesewas: days
        .filter((d) => d.date >= clipped.from && d.date <= clipped.to)
        .reduce((sum, d) => sum + d.totalPesewas, 0),
    });
  }
  return weeks;
}

/** A payment counts as following a reminder when it is made within this many days of it. */
export const REMINDER_WINDOW_DAYS = 7;

export interface ReminderOutcome {
  /** Students reminded. */
  reminded: number;
  /** Of those, students who paid within the window after a reminder. */
  paid: number;
  /** What those payments came to (each payment counted once). */
  paidPesewas: number;
}

/** What happened after fee reminders: who paid within a week of being reminded, and how much. */
export function reminderOutcome(
  reminders: readonly { studentId: string; sentOn: string }[],
  payments: readonly { id: string; studentId: string; paidOn: string; amountPesewas: number }[],
): ReminderOutcome {
  const followed = new Map<string, number>();
  const payers = new Set<string>();
  for (const r of reminders) {
    const until = addDays(r.sentOn, REMINDER_WINDOW_DAYS);
    for (const p of payments)
      if (p.studentId === r.studentId && p.paidOn >= r.sentOn && p.paidOn <= until) {
        followed.set(p.id, p.amountPesewas);
        payers.add(p.studentId);
      }
  }
  return {
    reminded: new Set(reminders.map((r) => r.studentId)).size,
    paid: payers.size,
    paidPesewas: [...followed.values()].reduce((a, b) => a + b, 0),
  };
}

/**
 * Clean axis ticks from 0 up to at least `max`, stepping by 1, 2, 2.5 or 5 times a power of ten
 * (in cedis, so pesewas never show on an axis). Takes and returns pesewas.
 */
export function niceTicks(maxPesewas: number, count = 4): number[] {
  const max = maxPesewas / 100;
  if (max <= 0) return [0];
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough)!;
  const ticks: number[] = [0];
  while (ticks[ticks.length - 1]! < max) ticks.push(ticks.length * step);
  return ticks.map((t) => Math.round(t * 100));
}

/**
 * Cedi amounts for a chart axis: in full (GH₵7,500) unless the axis reaches GH₵10,000, when every tick
 * is compact (GH₵2.5K, GH₵12K, GH₵1.5M), so one axis never mixes the two styles.
 */
export function axisCedis(pesewas: number, compact: boolean): string {
  const cedis = pesewas / 100;
  const short = (n: number) => String(Number(n.toFixed(1)));
  if (!compact) return `GH₵${Math.round(cedis).toLocaleString("en-GH")}`;
  if (Math.abs(cedis) >= 1_000_000) return `GH₵${short(cedis / 1_000_000)}M`;
  if (cedis === 0) return "GH₵0";
  return `GH₵${short(cedis / 1_000)}K`;
}
