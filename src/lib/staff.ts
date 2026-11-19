import { addDays, isWeekend } from "./attendance";

/** Staff and HR (R4-1): values shared by the server, the pages and the tests. */

export const EMPLOYMENT_TYPES = [
  "permanent",
  "contract",
  "part_time",
  "national_service",
  "volunteer",
  "casual",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  permanent: "Permanent",
  contract: "Contract",
  part_time: "Part-time",
  national_service: "National service",
  volunteer: "Volunteer",
  casual: "Casual",
};

export const EMPLOYMENT_EVENT_KINDS = ["started", "changed", "left", "returned"] as const;
export type EmploymentEventKind = (typeof EMPLOYMENT_EVENT_KINDS)[number];

export const EMPLOYMENT_EVENT_LABELS: Record<EmploymentEventKind, string> = {
  started: "Started",
  changed: "Changed",
  left: "Left",
  returned: "Returned",
};

export const LEAVE_STATUSES = ["pending", "approved", "declined", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Marks a person can be given; "on leave" comes only from approved leave. */
export const STAFF_ATTENDANCE_MARKS = ["present", "late", "absent", "off_duty"] as const;
export type StaffAttendanceMark = (typeof STAFF_ATTENDANCE_MARKS)[number];

export const STAFF_ATTENDANCE_LABELS: Record<StaffAttendanceMark | "on_leave", string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  off_duty: "Off duty",
  on_leave: "On leave",
};

/**
 * Suggested leave types for a Ghanaian school, to be checked with pilot schools (HR-03a): annual leave is the
 * Labour Act 2003 minimum of 15 working days; maternity leave is 12 weeks (60 working days). The school changes
 * any of them.
 */
export const SUGGESTED_LEAVE_TYPES: readonly { name: string; daysPerYear: number | null; paid: boolean }[] = [
  { name: "Annual leave", daysPerYear: 15, paid: true },
  { name: "Sick leave", daysPerYear: null, paid: true },
  { name: "Maternity leave", daysPerYear: 60, paid: true },
  { name: "Paternity leave", daysPerYear: 5, paid: true },
  { name: "Compassionate leave", daysPerYear: 5, paid: true },
  { name: "Study leave", daysPerYear: null, paid: false },
];

/** Working days from `from` to `to` (inclusive): Monday to Friday, less the school's holidays. */
export function workingDays(from: string, to: string, holidays: ReadonlySet<string> = new Set()): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d) && !holidays.has(d)) days.push(d);
  return days;
}

/** The working days of a leave period that fall in a calendar year (the leave year, HR-03d). */
export function leaveDaysInYear(
  leave: { startsOn: string; endsOn: string },
  year: number,
  holidays: ReadonlySet<string> = new Set(),
): number {
  const from = leave.startsOn > `${year}-01-01` ? leave.startsOn : `${year}-01-01`;
  const to = leave.endsOn < `${year}-12-31` ? leave.endsOn : `${year}-12-31`;
  return from > to ? 0 : workingDays(from, to, holidays).length;
}

export interface LeaveBalance {
  leaveTypeId: string;
  name: string;
  /** Days a year; null when the type has no limit. */
  allowed: number | null;
  taken: number;
  /** Days still to take; null when there is no limit. */
  left: number | null;
}

/** Each leave type's balance for one person in one year, from their approved leave. */
export function leaveBalances(
  types: readonly { id: string; name: string; daysPerYear: number | null }[],
  approved: readonly { leaveTypeId: string; startsOn: string; endsOn: string }[],
  year: number,
  holidays: ReadonlySet<string> = new Set(),
): LeaveBalance[] {
  return types.map((t) => {
    const taken = approved
      .filter((l) => l.leaveTypeId === t.id)
      .reduce((sum, l) => sum + leaveDaysInYear(l, year, holidays), 0);
    return {
      leaveTypeId: t.id,
      name: t.name,
      allowed: t.daysPerYear,
      taken,
      left: t.daysPerYear === null ? null : t.daysPerYear - taken,
    };
  });
}

/** Two date ranges (inclusive) share at least one day. */
export const overlaps = (a: { startsOn: string; endsOn: string }, b: { startsOn: string; endsOn: string }) =>
  a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;

export const formatStaffNumber = (n: number) => `S${String(n).padStart(4, "0")}`;
