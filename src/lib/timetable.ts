/**
 * Timetable arithmetic shared by the server and screens: school days, period times and clashes.
 * Framework-free and browser-safe.
 */

/** ISO weekdays a timetable covers: Monday (1) to Friday (5). */
export const SCHOOL_WEEKDAYS = [1, 2, 3, 4, 5] as const;
export type SchoolWeekday = (typeof SCHOOL_WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

export function isSchoolWeekday(value: number): value is SchoolWeekday {
  return (SCHOOL_WEEKDAYS as readonly number[]).includes(value);
}

/** The ISO weekday (1 Monday … 7 Sunday) of a calendar date "YYYY-MM-DD". */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** "8:05" or "08:05" → "08:05"; null when it is not a time of day. */
export function normaliseTime(input: string): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  if (!match) return null;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

export interface PeriodTimes {
  id?: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

/** The first other period whose times overlap these, or null (touching end to start is fine). */
export function overlappingPeriod<T extends PeriodTimes>(
  period: PeriodTimes,
  others: readonly T[],
): T | null {
  return (
    others.find((o) => o.id !== period.id && o.startsAt < period.endsAt && period.startsAt < o.endsAt) ?? null
  );
}

/** Periods in the order of the school day. */
export function sortPeriods<T extends PeriodTimes>(periods: readonly T[]): T[] {
  return [...periods].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
