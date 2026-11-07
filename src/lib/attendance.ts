/**
 * Attendance rules shared by the server and the register screen (which keeps working offline). Pure.
 *
 * Every mark carries a version. A change says which version it was made from; it applies only if the mark is
 * still at that version. If someone else changed the mark in the meantime the change is a conflict, shown to
 * the person to decide, never applied silently (last-write-wins is not allowed for attendance).
 */

export const ATTENDANCE_STATUSES = ["present", "late", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  excused: "Excused",
};

/** Present and late both count as attending school that day. */
export const ATTENDED: readonly AttendanceStatus[] = ["present", "late"];

export const REASON_MAX = 120;
/** Teachers can take or correct a register up to this many days back; academic leads, any day in a term. */
export const TEACHER_EDIT_DAYS = 7;

export interface MarkState {
  status: AttendanceStatus;
  reason: string | null;
  version: number;
}

export interface MarkChange {
  status: AttendanceStatus;
  reason: string | null;
  /** The version the change was made from; 0 for a student who had no mark yet. */
  baseVersion: number;
}

export type MarkDecision = "insert" | "update" | "unchanged" | "conflict";

const same = (a: { status: string; reason: string | null }, b: { status: string; reason: string | null }) =>
  a.status === b.status && (a.reason ?? "") === (b.reason ?? "");

/** What to do with one change, given the mark as it is now. */
export function decideMark(current: MarkState | null, change: MarkChange): MarkDecision {
  if (!current) return "insert";
  // Already what the change wants (e.g. a retried sync, or two people agreeing): nothing to do.
  if (same(current, change)) return "unchanged";
  return current.version === change.baseVersion ? "update" : "conflict";
}

/** Reasons only go with absences; trimmed, and empty means none. */
export function normaliseReason(status: AttendanceStatus, reason: string | null | undefined): string | null {
  if (status !== "absent" && status !== "excused") return null;
  const trimmed = (reason ?? "").trim().slice(0, REASON_MAX);
  return trimmed || null;
}

export interface AttendanceTotals {
  /** Registers the student was on: days the school was open for them. */
  open: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
}

export const NO_ATTENDANCE: AttendanceTotals = { open: 0, present: 0, late: 0, absent: 0, excused: 0 };

/** Days attended (present or late). */
export const attended = (t: AttendanceTotals) => t.present + t.late;

/** Attendance as a whole percentage, or null before any register. */
export function attendanceRate(t: AttendanceTotals): number | null {
  return t.open === 0 ? null : Math.round((attended(t) * 100) / t.open);
}

/** "2026-11-05" plus n days, as a calendar date (no time zone involved). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True for Saturday and Sunday. */
export function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** The nearest weekday before (step -1) or after (step 1) a date. */
export function nearestWeekday(iso: string, step: 1 | -1): string {
  let d = addDays(iso, step);
  while (isWeekend(d)) d = addDays(d, step);
  return d;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
