/**
 * Admissions (R3-4): an applicant's path from first contact to enrolment, shared by the server and screens.
 * Applicants are kept apart from students (D-R3-1) until they are enrolled.
 */

export const APPLICATION_STATUSES = [
  "inquiry",
  "applied",
  "assessment",
  "offered",
  "enrolled",
  "declined",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  inquiry: "Inquiry",
  applied: "Applied",
  assessment: "Assessment",
  offered: "Offered",
  enrolled: "Enrolled",
  declined: "Declined by the school",
  withdrawn: "Withdrawn by the family",
};

/** Still in progress: shown in the pipeline and counted as open. */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "inquiry",
  "applied",
  "assessment",
  "offered",
];

/** Finished: an enrolled applicant became a student; declined and withdrawn ones are removed after 12 months. */
export const CLOSED_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "enrolled",
  "declined",
  "withdrawn",
];

/**
 * Which statuses each can move to by hand. Enrolling is its own step (it creates the student), and a closed
 * application never reopens: a family that comes back starts a new one, so history is never rewritten.
 */
export const NEXT_STATUSES: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  inquiry: ["applied", "declined", "withdrawn"],
  applied: ["assessment", "offered", "declined", "withdrawn"],
  assessment: ["offered", "declined", "withdrawn"],
  offered: ["declined", "withdrawn"],
  enrolled: [],
  declined: [],
  withdrawn: [],
};

export function canMove(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return NEXT_STATUSES[from].includes(to);
}

export const APPLICATION_SOURCES = ["walk_in", "phone", "referral", "event", "online", "other"] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

export const APPLICATION_SOURCE_LABELS: Record<ApplicationSource, string> = {
  walk_in: "Visited the school",
  phone: "Phone call",
  referral: "Referred by a family",
  event: "Open day or event",
  online: "Online application",
  other: "Other",
};

/** How long declined and withdrawn applications keep personal details (founder decision D-R3-2). */
export const APPLICATION_RETENTION_MONTHS = 12;

/** One charge posted to the new student's account on enrolment, as frozen in the offer. */
export interface AdmissionFee {
  description: string;
  amountPesewas: number;
}

export const MAX_ADMISSION_FEES = 8;

/** "A0042" from the school's counter. */
export const applicationReference = (n: number) => `A${String(n).padStart(4, "0")}`;
