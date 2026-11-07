import { addDays, isWeekend } from "./attendance";

/**
 * Pure helpers for school insights (server and tests).
 */

/** School days (Monday to Friday, outside holidays) from `from` to `to`, inclusive, oldest first. */
export function schoolDaysBetween(
  from: string,
  to: string,
  holidays: readonly { startsOn: string; endsOn: string }[] = [],
): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    if (holidays.some((h) => d >= h.startsOn && d <= h.endsOn)) continue;
    days.push(d);
  }
  return days;
}

/** A change between two averages, rounded to one decimal place (negative when it fell). */
export function change(previous: number, latest: number): number {
  return Math.round((latest - previous) * 10) / 10;
}

/** A share as a percentage with one decimal place, or null without a base. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}
