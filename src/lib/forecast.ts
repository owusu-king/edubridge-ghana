import { addDays } from "./attendance";
import { daysBetween, weekStart } from "./dashboard";

/**
 * Collection forecasting (R5-2, FCT-01, ADR 0004 §2). Pure, so the method is unit-tested on its own: no model and no
 * new library, only the school's own past terms. For each complete past term with fees billed, the share of those
 * fees collected by each day of term; the money expected from today is this term's billed amount times the share the
 * past terms went on to collect from the same day. The median past term is "likely", the lowest and highest the
 * range. Forecasts are for the school or a campus only (D-R5-4).
 */

/** Money collected on one day (payments by date, voided ones left out). */
export interface DayTotal {
  date: string;
  totalPesewas: number;
}

/** A term the forecast learns from, or the one it forecasts. */
export interface TermHistory {
  termId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  billedPesewas: number;
  /** Payments received within the term's dates. */
  days: readonly DayTotal[];
}

/** Days of term from its first day up to and including `date` (0 before it starts). */
export function dayOfTerm(startsOn: string, date: string): number {
  return Math.max(0, daysBetween(startsOn, date) + 1);
}

const termLength = (t: Pick<TermHistory, "startsOn" | "endsOn">) => dayOfTerm(t.startsOn, t.endsOn);

/** Collected within the first `n` days of a term (the whole term beyond its last day). */
export function collectedBy(term: TermHistory, n: number): number {
  const last = addDays(term.startsOn, Math.min(n, termLength(term)) - 1);
  return term.days
    .filter((d) => d.date >= term.startsOn && d.date <= last)
    .reduce((s, d) => s + d.totalPesewas, 0);
}

/** The share of a term's billed fees collected within its first `n` days (it may pass 1, with arrears paid). */
export function shareBy(term: TermHistory, n: number): number {
  return term.billedPesewas > 0 ? collectedBy(term, n) / term.billedPesewas : 0;
}

/** The terms a forecast may learn from: complete (ended before `today`) and with fees billed. */
export function usableHistory(terms: readonly TermHistory[], today: string): TermHistory[] {
  return terms.filter((t) => t.endsOn < today && t.billedPesewas > 0);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Expected further share between day `from` and day `to` of term, across the past terms. */
function furtherShares(history: readonly TermHistory[], from: number, to: number): number[] {
  return history.map((t) => Math.max(0, shareBy(t, to) - shareBy(t, from)));
}

export interface Expected {
  likelyPesewas: number;
  lowPesewas: number;
  highPesewas: number;
}

/** Expected receipts from the day after `from` to day `to`, for a term that billed `billedPesewas`. */
export function expectedBetween(
  history: readonly TermHistory[],
  billedPesewas: number,
  from: number,
  to: number,
): Expected {
  const shares = furtherShares(history, from, to);
  const money = (share: number) => Math.round(billedPesewas * share);
  return {
    likelyPesewas: money(median(shares)),
    lowPesewas: money(Math.min(...shares)),
    highPesewas: money(Math.max(...shares)),
  };
}

export interface ForecastWeek {
  /** First and last day of the week within the term. */
  from: string;
  to: string;
  /** Collected in the week up to today; null for a week that has not started. */
  actualPesewas: number | null;
  /** Expected in the rest of the week after today; null for a week that is over. */
  expected: Expected | null;
  /** Instalments of active payment plans due in the rest of the week (scheduled, not added to the forecast). */
  instalmentsPesewas: number;
}

export type Forecast =
  | { status: "not_billed" }
  | { status: "no_history" }
  | { status: "ended"; collectedPesewas: number; billedPesewas: number }
  | {
      status: "forecast";
      billedPesewas: number;
      collectedPesewas: number;
      /** Collected so far plus what is expected to the end of term. */
      endOfTerm: Expected;
      weeks: ForecastWeek[];
      /** The past terms it rests on, newest first. */
      basedOn: { termId: string; label: string }[];
    };

/**
 * The forecast for a term as of `today`, from the past terms. `current.days` holds the term's payments so far;
 * `instalments` the dated amounts of active payment plans.
 */
export function forecastTerm(
  current: TermHistory,
  past: readonly TermHistory[],
  today: string,
  instalments: readonly DayTotal[] = [],
): Forecast {
  const elapsed = Math.min(dayOfTerm(current.startsOn, today), termLength(current));
  const collected = collectedBy(current, elapsed);
  if (current.endsOn < today)
    return { status: "ended", collectedPesewas: collected, billedPesewas: current.billedPesewas };
  if (current.billedPesewas <= 0) return { status: "not_billed" };
  const history = usableHistory(past, today).filter((t) => t.termId !== current.termId);
  if (!history.length) return { status: "no_history" };

  const fromToday = (day: number) => expectedBetween(history, current.billedPesewas, elapsed, day);
  const weekOf = (from: number, to: number): Expected => {
    const [a, b] = [fromToday(from), fromToday(to)];
    return {
      likelyPesewas: b.likelyPesewas - a.likelyPesewas,
      lowPesewas: b.lowPesewas - a.lowPesewas,
      highPesewas: b.highPesewas - a.highPesewas,
    };
  };
  const weeks: ForecastWeek[] = [];
  for (let start = weekStart(current.startsOn); start <= current.endsOn; start = addDays(start, 7)) {
    const from = start < current.startsOn ? current.startsOn : start;
    const end = addDays(start, 6);
    const to = end > current.endsOn ? current.endsOn : end;
    const dayFrom = dayOfTerm(current.startsOn, from);
    const dayTo = dayOfTerm(current.startsOn, to);
    const actualTo = Math.min(dayTo, elapsed);
    weeks.push({
      from,
      to,
      actualPesewas:
        dayFrom > elapsed ? null : collectedBy(current, actualTo) - collectedBy(current, dayFrom - 1),
      // Cumulative from today, differenced, so the weeks add up exactly to the end-of-term forecast.
      expected: dayTo <= elapsed ? null : weekOf(Math.max(elapsed, dayFrom - 1), dayTo),
      instalmentsPesewas: instalments
        .filter((i) => i.date >= (from > today ? from : addDays(today, 1)) && i.date <= to)
        .reduce((s, i) => s + i.totalPesewas, 0),
    });
  }
  const rest = expectedBetween(history, current.billedPesewas, elapsed, termLength(current));
  return {
    status: "forecast",
    billedPesewas: current.billedPesewas,
    collectedPesewas: collected,
    endOfTerm: {
      likelyPesewas: collected + rest.likelyPesewas,
      lowPesewas: collected + rest.lowPesewas,
      highPesewas: collected + rest.highPesewas,
    },
    weeks,
    basedOn: history.map((t) => ({ termId: t.termId, label: t.label })),
  };
}

export interface Backtest {
  termId: string;
  label: string;
  /** The day of term the check was made at (the same day as this term's forecast). */
  day: number;
  /** What the forecast at that day would have said the term would end with (likely). */
  forecastPesewas: number;
  /** What the term did collect. */
  collectedPesewas: number;
  /** (forecast − collected) ÷ collected, as a whole percentage; null when nothing was collected. */
  errorPercent: number | null;
}

/**
 * Last term's forecast checked against what happened (FCT-01d): made the same way, at the same day of term, from
 * the terms before it. Null when last term had no earlier term to learn from.
 */
export function backtestLastTerm(past: readonly TermHistory[], today: string, day: number): Backtest | null {
  const usable = usableHistory(past, today).sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  const [last, ...earlier] = usable;
  if (!last || !earlier.length) return null;
  const at = Math.min(Math.max(day, 0), termLength(last));
  const soFar = collectedBy(last, at);
  const forecast = soFar + expectedBetween(earlier, last.billedPesewas, at, termLength(last)).likelyPesewas;
  const collected = collectedBy(last, termLength(last));
  return {
    termId: last.termId,
    label: last.label,
    day: at,
    forecastPesewas: forecast,
    collectedPesewas: collected,
    errorPercent: collected > 0 ? Math.round(((forecast - collected) / collected) * 100) : null,
  };
}
