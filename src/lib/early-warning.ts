import type { AttendanceStatus } from "./attendance";
import { addDays } from "./attendance";

/**
 * Early-warning indicators (R5-3, EWS-01, ADR 0004 §2): rules with thresholds the school sets, applied to the records.
 * They are not scores and do not rank children: each says what the records show, with the evidence, and a teacher
 * decides what it means. Pure, so the rules are unit-tested on their own.
 */

export const EARLY_WARNING_RULES = [
  "attendance_low",
  "absent_in_a_row",
  "average_down",
  "subjects_below",
] as const;
export type EarlyWarningRule = (typeof EARLY_WARNING_RULES)[number];

export const RULE_LABELS: Record<EarlyWarningRule, string> = {
  attendance_low: "Attendance below the school's level",
  absent_in_a_row: "Absent several days in a row",
  average_down: "Report-card average down",
  subjects_below: "Subjects below the pass mark",
};

/** The school's rules (one row per school); the suggested defaults are D-R5-8's. */
export interface EarlyWarningSettings {
  attendanceOn: boolean;
  /** Below this percentage... */
  attendancePercent: number;
  /** ...over this many days. */
  attendanceDays: number;
  absencesOn: boolean;
  /** This many unexplained absences in a row. */
  absencesInARow: number;
  averageOn: boolean;
  /** The average fell by at least this many points. */
  averageDrop: number;
  subjectsOn: boolean;
  /** At least this many subjects... */
  subjectsCount: number;
  /** ...below this mark. */
  passMark: number;
}

export const DEFAULT_SETTINGS: EarlyWarningSettings = {
  attendanceOn: true,
  attendancePercent: 85,
  attendanceDays: 28,
  absencesOn: true,
  absencesInARow: 3,
  averageOn: true,
  averageDrop: 10,
  subjectsOn: true,
  subjectsCount: 2,
  passMark: 50,
};

/** Allowed ranges for each threshold (validated on save). */
export const SETTING_RANGES = {
  attendancePercent: { min: 50, max: 100 },
  attendanceDays: { min: 7, max: 90 },
  absencesInARow: { min: 2, max: 10 },
  averageDrop: { min: 3, max: 50 },
  subjectsCount: { min: 1, max: 10 },
  passMark: { min: 20, max: 80 },
} as const;

/** The attendance rule needs at least this many registers in its window, so one bad day is not a pattern. */
export const MIN_REGISTERS = 5;

/** Indicators waiting longer than this many days are shown to the Head teacher. */
export const REVIEW_WITHIN_DAYS = 7;

export const REVIEW_OUTCOMES = ["no_action", "support_plan", "referred"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export const OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  no_action: "No action needed",
  support_plan: "Support plan opened",
  referred: "Referred to the Head teacher",
};

export interface Mark {
  date: string;
  status: AttendanceStatus;
}

const attends = (s: AttendanceStatus) => s === "present" || s === "late";

/** Attendance over the `days` days ending on `end`: registers open, attended, and the rate (whole percent). */
export function windowRate(marks: readonly Mark[], end: string, days: number) {
  const from = addDays(end, -(days - 1));
  const inWindow = marks.filter((m) => m.date >= from && m.date <= end);
  const attended = inWindow.filter((m) => attends(m.status)).length;
  return {
    from,
    open: inWindow.length,
    attended,
    excused: inWindow.filter((m) => m.status === "excused").length,
    absent: inWindow.filter((m) => m.status === "absent").length,
    rate: inWindow.length ? Math.round((attended / inWindow.length) * 100) : null,
  };
}

export interface AttendanceLow {
  from: string;
  to: string;
  open: number;
  attended: number;
  absent: number;
  excused: number;
  rate: number;
  /** The first register day of the current stretch with the window below the level. */
  raisedOn: string;
}

/** Attendance below the level over the last `days` days to `today`, or null. */
export function attendanceLow(
  marks: readonly Mark[],
  today: string,
  percent: number,
  days: number,
): AttendanceLow | null {
  const below = (end: string) => {
    const w = windowRate(marks, end, days);
    return w.open >= MIN_REGISTERS && w.rate !== null && w.rate < percent ? w : null;
  };
  const now = below(today);
  if (!now) return null;
  // Walk back over register days while the window ending on each was also below the level.
  const dates = [...new Set(marks.map((m) => m.date))]
    .filter((d) => d <= today)
    .sort()
    .reverse();
  let raisedOn = dates[0] ?? today;
  for (const d of dates) {
    if (!below(d)) break;
    raisedOn = d;
  }
  return {
    from: now.from,
    to: today,
    open: now.open,
    attended: now.attended,
    absent: now.absent,
    excused: now.excused,
    rate: now.rate!,
    raisedOn,
  };
}

/** The run of unexplained absences up to the latest register, if it is at least `n` long. */
export function absentInARow(
  marks: readonly Mark[],
  n: number,
): { dates: string[]; raisedOn: string } | null {
  const sorted = [...marks].sort((a, b) => b.date.localeCompare(a.date));
  const run: string[] = [];
  for (const m of sorted) {
    if (m.status !== "absent") break;
    run.push(m.date);
  }
  if (run.length < n) return null;
  const dates = run.reverse();
  return { dates, raisedOn: dates[n - 1]! };
}

/** The fall from the previous published average, if it is at least `drop` points. */
export function averageDown(previous: number | null, latest: number | null, drop: number): number | null {
  if (previous === null || latest === null) return null;
  const change = Math.round((latest - previous) * 10) / 10;
  return change <= -drop ? change : null;
}

/** Subjects with a total below the pass mark, if there are at least `count`. */
export function subjectsBelow(
  subjects: readonly { name: string; total: number | null }[],
  passMark: number,
  count: number,
): { name: string; total: number }[] | null {
  const below = subjects
    .filter((s): s is { name: string; total: number } => s.total !== null && s.total < passMark)
    .map((s) => ({ name: s.name, total: s.total }));
  return below.length >= count ? below : null;
}

/** Whether a raised indicator has waited too long for a review. */
export function waitingTooLong(raisedOn: string, today: string): boolean {
  return addDays(raisedOn, REVIEW_WITHIN_DAYS) < today;
}
