import { FEATURE_LABELS, type Feature } from "../../lib/plan";
import { DomainError } from "../errors";

/**
 * Role-based access control. Roles are assigned per school membership; permissions are code-defined
 * so every check is explicit, reviewable and testable. Custom per-school roles can be layered on later
 * without changing call sites, because callers only ever ask `can(roles, permission)`.
 */
/**
 * Role keys are stable identifiers stored in the database; labels are what people see.
 * "owner" is shown as Proprietor and "bursar" as Accountant (Ghanaian school usage).
 */
export const ROLES = ["owner", "headteacher", "admin", "bursar", "teacher", "parent", "student"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Proprietor",
  headteacher: "Head teacher",
  admin: "Administrator",
  bursar: "Accountant",
  teacher: "Teacher",
  parent: "Parent",
  student: "Student",
};

const STAFF: readonly Role[] = ["owner", "headteacher", "admin", "bursar", "teacher"];

const GRANTS = {
  "school.view": [...STAFF, "parent", "student"],
  "classes.view": STAFF,
  // Teachers see only students in their own classes; these roles see every student.
  "students.view": STAFF,
  "students.view_all": ["owner", "headteacher", "admin", "bursar"],
  "students.manage": ["owner", "headteacher", "admin"],
  "school.settings.manage": ["owner", "admin"],
  "academics.manage": ["owner", "headteacher", "admin"],
  // Scores and report-card remarks: teachers only for classes they are class teacher of (checked per class).
  "assessment.enter": ["owner", "headteacher", "admin", "teacher"],
  // Taking the register: teachers only for classes they are class teacher of (checked per class).
  "attendance.take": ["owner", "headteacher", "admin", "teacher"],
  // Attendance settings, such as when families get an SMS about absences.
  "attendance.manage": ["owner", "headteacher", "admin"],
  // Publishing report cards to families, and the head teacher's remark, are the head teacher's approval.
  "reports.publish": ["owner", "headteacher"],
  // Head teachers oversee staff and academics, and see school finances without changing them.
  "members.view": ["owner", "headteacher", "admin"],
  "members.manage": ["owner", "admin"],
  "campuses.manage": ["owner", "admin"],
  "plan.view": ["owner", "admin"],
  "audit.view": ["owner", "admin"],
  "security.manage": ["owner"],
  // Finance: the Proprietor and Accountant run fees; the Head teacher can look but not change anything.
  "fees.view": ["owner", "headteacher", "bursar"],
  "fees.manage": ["owner", "bursar"],
  "payments.record": ["owner", "bursar"],
  // Fee reminders cost the school an SMS each, so only finance staff send them.
  "fees.remind": ["owner", "bursar"],
  // Stopping a guardian using the parent view (e.g. a custody change) is a safeguarding decision.
  "parents.access.manage": ["owner", "headteacher", "admin"],
  // Voiding a receipt is a fraud-sensitive control: the Proprietor, and Accountants only if the Proprietor
  // allows it for the school (school_preferences.accountants_can_void, granted per request).
  "payments.void": ["owner"],
  // Announcements to families (and SMS when chosen).
  "communication.send": ["owner", "headteacher", "admin"],
  // Exporting the school's records: everything for the Proprietor; fee records also for the Accountant.
  "data.export": ["owner"],
  "fees.export": ["owner", "bursar"],
  "support.manage": ["owner"],
  "transfers.manage": ["owner", "headteacher", "admin"],
  "insights.view": ["owner", "headteacher", "admin", "bursar"],
  "assistant.use": ["owner", "headteacher", "admin", "bursar"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof GRANTS;

export const PERMISSIONS = Object.keys(GRANTS) as Permission[];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(roles: readonly Role[], permission: Permission): boolean {
  const allowed: readonly Role[] = GRANTS[permission];
  return roles.some((role) => allowed.includes(role));
}

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(roles: readonly Role[], permission: Permission): void {
  if (!can(roles, permission)) throw new ForbiddenError(permission);
}

/**
 * Permissions that belong to a module a school's plan may leave out. The rest (students, fees, staff,
 * settings) are in every plan.
 */
const FEATURE_FOR: Partial<Record<Permission, Feature>> = {
  "attendance.take": "attendance",
  "attendance.manage": "attendance",
  "assessment.enter": "assessment",
  "reports.publish": "assessment",
  "fees.remind": "fee_reminders",
  "parents.access.manage": "parent_view",
  "assistant.use": "assistant",
};

/** A member's access at one school: their roles there, and what the school's plan includes. */
export interface Access {
  roles: readonly Role[];
  features: readonly Feature[];
  /** Permissions the school has given this member beyond their roles (e.g. Accountants voiding receipts). */
  schoolGrants?: readonly Permission[];
  /** Present when EduBridge support is acting under the school's support grant. */
  support?: { grantId: string } | null;
}

/**
 * EduBridge support acts with the Proprietor's permissions while the school allows it (PLT-02), except
 * these: support access stays the school's decision, and bulk exports are not needed to help.
 */
const NOT_FOR_SUPPORT: readonly Permission[] = ["support.manage", "data.export", "fees.export"];

const hasRole = (access: Access, permission: Permission) =>
  !(access.support && NOT_FOR_SUPPORT.includes(permission)) &&
  (can(access.roles, permission) || (access.schoolGrants?.includes(permission) ?? false));

/** The role allows it and, where it belongs to a module, the school's plan includes that module. */
export function allowed(access: Access, permission: Permission): boolean {
  if (!hasRole(access, permission)) return false;
  const feature = FEATURE_FOR[permission];
  return !feature || access.features.includes(feature);
}

export function notIncluded(feature: Feature): DomainError {
  return new DomainError(
    "feature_not_included",
    `${FEATURE_LABELS[feature].name} is not included in this school's plan. Ask EduBridge to add it.`,
  );
}

/** Server-side check for every service: the role must allow it, and the plan must include its module. */
export function assertAllowed(access: Access, permission: Permission): void {
  if (!hasRole(access, permission)) throw new ForbiddenError(permission);
  const feature = FEATURE_FOR[permission];
  if (feature && !access.features.includes(feature)) throw notIncluded(feature);
}

/** For features without a permission of their own (e.g. Mobile Money, used with payments.record). */
export function assertFeature(access: Access, feature: Feature): void {
  if (!access.features.includes(feature)) throw notIncluded(feature);
}
