/**
 * Student lifecycle (SIS-03), shared by server and screens: active, suspended (temporarily not attending;
 * still placed and billed), and the statuses of students who have left. Applicants belong to admissions (R3).
 */
export const STUDENT_STATUSES = ["active", "suspended", "withdrawn", "transferred", "graduated"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  withdrawn: "Withdrawn",
  transferred: "Transferred",
  graduated: "Graduated",
};

/** Which status changes make sense; a reason is recorded for every change away from active. */
export const STATUS_CHANGES: Record<StudentStatus, readonly StudentStatus[]> = {
  active: ["suspended", "withdrawn", "transferred", "graduated"],
  suspended: ["active", "withdrawn", "transferred"],
  withdrawn: ["active"],
  transferred: ["active"],
  graduated: ["active"],
};

/** Students still at the school (placed in classes and billed). */
export const ENROLLED_STATUSES: readonly StudentStatus[] = ["active", "suspended"];
