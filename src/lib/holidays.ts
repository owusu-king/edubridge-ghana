import { addDays } from "./attendance";

/**
 * Suggested Ghanaian public holidays, from the Public Holidays and Commemorative Days Act (Act 601) as
 * amended in 2025 (Act 1142): July 1 restored, Founders' Day on 21 September, August 4 no longer a holiday.
 * Schools review the suggestions before adding them. Eid al-Fitr, Shaqq Day and Eid al-Adha follow the
 * moon and are announced each year, so schools add them themselves; the government can also move a
 * holiday that falls on a weekend. Assumption to verify each year against the Ministry of the Interior.
 */

const FIXED: [string, string][] = [
  ["01-01", "New Year's Day"],
  ["01-07", "Constitution Day"],
  ["03-06", "Independence Day"],
  ["05-01", "May Day"],
  ["07-01", "Republic Day"],
  ["09-21", "Founders' Day"],
  ["12-25", "Christmas Day"],
  ["12-26", "Boxing Day"],
];

/** Easter Sunday in the Gregorian calendar (anonymous Gregorian algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Farmers' Day: the first Friday of December. */
export function farmersDay(year: number): string {
  let date = `${year}-12-01`;
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 5) date = addDays(date, 1);
  return date;
}

export interface SuggestedHoliday {
  name: string;
  date: string;
}

/** Public holidays falling between two dates (inclusive), in date order. */
export function ghanaPublicHolidays(from: string, to: string): SuggestedHoliday[] {
  const found: SuggestedHoliday[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (const [md, name] of FIXED) found.push({ name, date: `${year}-${md}` });
    const easter = easterSunday(year);
    found.push(
      { name: "Good Friday", date: addDays(easter, -2) },
      { name: "Easter Monday", date: addDays(easter, 1) },
    );
    found.push({ name: "Farmers' Day", date: farmersDay(year) });
  }
  return found.filter((h) => h.date >= from && h.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}
