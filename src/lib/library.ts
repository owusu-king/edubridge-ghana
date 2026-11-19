/** Library (R4-7): values and rules shared by the server, the pages and the tests. */

export const RESERVATION_STATUSES = ["waiting", "ready", "fulfilled", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  waiting: "Waiting",
  ready: "Ready to collect",
  fulfilled: "Collected",
  cancelled: "Cancelled",
};

export const DEFAULT_LOAN_DAYS = 14;
export const DEFAULT_MAX_LOANS = 3;

/** An ISBN as digits (and a final X for ISBN-10), if its check digit is right; otherwise null (LIB-01a). */
export function normalizeIsbn(input: string): string | null {
  const v = input.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(v)) {
    const sum = [...v].reduce((s, c, i) => s + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? v : null;
  }
  if (/^\d{13}$/.test(v)) {
    const sum = [...v].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? v : null;
  }
  return null;
}

/** Calendar days from one date (YYYY-MM-DD) to another; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days late on a day (0 when not late). */
export function daysLate(dueOn: string, on: string): number {
  return Math.max(0, daysBetween(dueOn, on));
}

/** The fine for a late return (LIB-02): per day, up to the maximum; 0 when fines are off or nothing is set. */
export function fineFor(
  late: number,
  rules: { enabled: boolean; perDayMinor: number | null; capMinor: number | null },
): number {
  if (!rules.enabled || !rules.perDayMinor || late <= 0) return 0;
  const fine = late * rules.perDayMinor;
  return rules.capMinor !== null ? Math.min(fine, rules.capMinor) : fine;
}

export const copyNumber = (n: number) => `B${String(n).padStart(4, "0")}`;

/** "student:<id>" or "member:<id>", as borrower pickers send it. */
export type BorrowerKey = `student:${string}` | `member:${string}`;
