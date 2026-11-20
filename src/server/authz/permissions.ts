import { isPlanModule, type ModuleId } from "../../lib/modules";
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
export const ROLES = [
  "owner",
  "headteacher",
  "admin",
  "bursar",
  "teacher",
  "parent",
  "student",
  "cashier",
  "librarian",
  "storekeeper",
  "transport_officer",
  "front_desk",
  "nurse",
  "admissions_officer",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Proprietor",
  headteacher: "Head teacher",
  admin: "Administrator",
  bursar: "Accountant",
  teacher: "Teacher",
  parent: "Parent",
  student: "Student",
  cashier: "Cashier",
  librarian: "Librarian",
  storekeeper: "Storekeeper",
  transport_officer: "Transport officer",
  front_desk: "Front desk",
  nurse: "School nurse",
  admissions_officer: "Admissions officer",
};

/**
 * Operational roles (2026-11-18): staff who run one part of the school and nothing else. Before them, a librarian
 * or storekeeper had to be made an Administrator, which also manages members and settings. Each sees only its own
 * module, plus what every member of staff can do (ask for leave, see their payslips, report a concern).
 */
export const OPERATIONAL_ROLES = [
  "cashier",
  "librarian",
  "storekeeper",
  "transport_officer",
  "front_desk",
  "nurse",
  "admissions_officer",
] as const satisfies readonly Role[];

/** Leaders, the office, finance and teachers: the roles that see classes and students. */
const STAFF: readonly Role[] = ["owner", "headteacher", "admin", "bursar", "teacher"];
/** Everyone on staff, including the operational roles: for what any employee may do. */
const ALL_STAFF: readonly Role[] = [...STAFF, ...OPERATIONAL_ROLES];

const GRANTS = {
  "school.view": [...ALL_STAFF, "parent", "student"],
  "classes.view": STAFF,
  // Teachers see only students in their own classes; these roles see every student.
  "students.view": [...STAFF, "nurse"],
  "students.view_all": ["owner", "headteacher", "admin", "bursar", "nurse"],
  "students.manage": ["owner", "headteacher", "admin"],
  "students.medical": ["owner", "headteacher", "admin", "nurse"],
  "school.settings.manage": ["owner", "admin"],
  "academics.manage": ["owner", "headteacher", "admin"],
  // Timetables: academic staff see every class's (and plan them with academics.manage); teachers see their
  // own lessons and their classes' timetables.
  "timetable.view": ["owner", "headteacher", "admin", "teacher"],
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
  // Asking EduBridge to change the plan (SUB-02): the Proprietor's decision; EduBridge staff approve it.
  "plan.request": ["owner"],
  "audit.view": ["owner", "admin"],
  "security.manage": ["owner"],
  // Finance: the Proprietor and Accountant run fees; the Head teacher can look but not change anything.
  "fees.view": ["owner", "headteacher", "bursar", "cashier"],
  "fees.manage": ["owner", "bursar"],
  "payments.record": ["owner", "bursar", "cashier"],
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
  "fees.approve_discounts": ["owner"],
  "fees.close_periods": ["owner", "bursar"],
  "fees.reopen_periods": ["owner"],
  "fees.refund": ["owner", "bursar"],
  // School money beyond fees (2026-11-18): accounts, deposits, bank statements, income against spending. The Head
  // teacher sees them; the Proprietor and Accountant keep them. Expenses at or above the school's amount wait for the
  // Proprietor's approval.
  "finance.view": ["owner", "headteacher", "bursar"],
  "finance.manage": ["owner", "bursar"],
  "expenses.record": ["owner", "bursar"],
  "expenses.approve": ["owner"],
  "support.manage": ["owner"],
  "transfers.manage": ["owner", "headteacher", "admin"],
  "insights.view": ["owner", "headteacher", "admin", "bursar"],
  "assistant.use": ["owner", "headteacher", "admin", "bursar"],
  "assistant.manage": ["owner"],
  // Admissions (R3-4): academic and office staff run the pipeline; the Accountant sees it (fees on enrolment).
  "admissions.view": ["owner", "headteacher", "admin", "bursar", "admissions_officer"],
  "admissions.manage": ["owner", "headteacher", "admin", "admissions_officer"],
  // Events and consent forms (R3-3): every member sees the calendar; leaders and the office run it.
  "events.view": ALL_STAFF,
  "events.manage": ["owner", "headteacher", "admin"],
  // Consent answers: teachers see those of their own classes' students (checked per class).
  "consent.view": ["owner", "headteacher", "admin", "teacher"],
  "consent.manage": ["owner", "headteacher", "admin"],
  // Staff and HR (R4-1): staff records are personal, so the school's leaders and office only.
  "staff.view": ["owner", "headteacher", "admin"],
  "staff.manage": ["owner", "headteacher", "admin"],
  // Contracts and certificates: every download recorded.
  "staff.documents": ["owner", "admin"],
  "staff.attendance": ["owner", "headteacher", "admin"],
  // Approving leave, and recording leave for anyone; never one's own.
  "leave.approve": ["owner", "headteacher", "admin"],
  // Asking for one's own leave (members with a staff record).
  "leave.request": ALL_STAFF,
  // Payroll records (R4-2): salaries are confidential, so the Proprietor and Accountant only; the
  // Proprietor approves each month. Everyone with a staff record sees their own payslips.
  "payroll.view": ["owner", "bursar"],
  "payroll.manage": ["owner", "bursar"],
  "payroll.approve": ["owner"],
  "payroll.own": ALL_STAFF,
  // Safeguarding (R4-3): anyone on staff reports a concern; only the school's designated leads, appointed by
  // the Proprietor, handle cases (a school grant, never a role). The database enforces the same rule.
  "safeguarding.report": ALL_STAFF,
  "safeguarding.manage": [],
  "safeguarding.appoint": ["owner"],
  // Visitors and pickup (R4-4): the office signs visitors in and out; anyone on gate duty releases a child
  // (teachers for every class at their campuses); the office decides who may collect each child.
  "visitors.view": ["owner", "headteacher", "admin", "front_desk"],
  "visitors.manage": ["owner", "headteacher", "admin", "front_desk"],
  "pickup.view": ["owner", "headteacher", "admin", "teacher", "front_desk"],
  "pickup.record": ["owner", "headteacher", "admin", "teacher", "front_desk"],
  "pickup.manage": ["owner", "headteacher", "admin"],
  // Transport (R4-5): the office runs routes; the Accountant sees them (transport fees); staff on the bus,
  // teachers too, mark trips. Fares are fees: set with fees.manage.
  "transport.view": ["owner", "headteacher", "admin", "bursar", "transport_officer"],
  "transport.manage": ["owner", "headteacher", "admin", "transport_officer"],
  "transport.trips": ["owner", "headteacher", "admin", "teacher", "transport_officer"],
  // Inventory, assets and procurement (R4-6): the office and the Accountant keep stock and the register; the
  // Proprietor approves purchases; anyone on staff reports what needs fixing.
  "inventory.view": ["owner", "headteacher", "admin", "bursar", "storekeeper"],
  "inventory.manage": ["owner", "admin", "bursar", "storekeeper"],
  "purchases.request": ["owner", "headteacher", "admin", "bursar", "storekeeper"],
  "purchases.approve": ["owner"],
  "maintenance.report": ALL_STAFF,
  "maintenance.manage": ["owner", "headteacher", "admin"],
  // Library (R4-7): every member of staff sees the catalogue; the office runs loans. Fines are fees.
  "library.view": [...STAFF, "librarian"],
  "library.manage": ["owner", "headteacher", "admin", "librarian"],
  // Boarding (R4-8): the office runs houses and places boarders; house staff (a school grant, like safeguarding
  // leads) see their house and sign its boarders out and in on exeat.
  "boarding.view": ["owner", "headteacher", "admin", "bursar"],
  "boarding.manage": ["owner", "headteacher", "admin"],
  "boarding.exeat": ["owner", "headteacher", "admin"],
  // Collection forecasting and finance checks (R5-2): the forecast for those who see the school's money; checks for
  // the Proprietor and the Accountant, who answer for the books.
  "forecasting.view": ["owner", "headteacher", "bursar"],
  "finance_checks.review": ["owner", "bursar"],
  // Early warning (R5-3): academic leads see every class (at their campuses); teachers only the classes they are
  // class teacher of, which the service enforces. Never families, students or EduBridge support (NOT_FOR_SUPPORT).
  "early_warning.view": ["owner", "headteacher", "admin", "teacher"],
  "early_warning.review": ["headteacher", "teacher"],
  "early_warning.manage": ["owner", "headteacher"],
  // AI drafting (R5-5): staff, for work they may already do (checked by each draft); the board report is the
  // Proprietor's.
  "drafting.use": STAFF,
  "drafting.board_report": ["owner"],
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
 * The module every permission belongs to (MOD-02). Exhaustive on purpose: a new permission does not compile
 * until it names its module. Core modules are in every school; the others must be active for the school
 * (its plan, add-ons, release and dependencies, worked out by the entitlement resolver).
 */
export const PERMISSION_MODULES: Record<Permission, ModuleId> = {
  "school.view": "school_core",
  "classes.view": "academic_structure",
  "students.view": "students",
  "students.view_all": "students",
  "students.manage": "students",
  "students.medical": "students",
  "school.settings.manage": "school_core",
  "academics.manage": "academic_structure",
  "timetable.view": "timetable",
  "assessment.enter": "assessment",
  "attendance.take": "attendance",
  "attendance.manage": "attendance",
  "reports.publish": "assessment",
  "members.view": "school_core",
  "members.manage": "school_core",
  "campuses.manage": "school_core",
  "plan.view": "school_core",
  "plan.request": "school_core",
  "audit.view": "school_core",
  "security.manage": "school_core",
  "fees.view": "fees",
  "fees.manage": "fees",
  "payments.record": "fees",
  "fees.remind": "fee_reminders",
  "parents.access.manage": "parent_view",
  "payments.void": "fees",
  "communication.send": "communication",
  "data.export": "school_core",
  "fees.export": "fees",
  "fees.approve_discounts": "fees",
  "fees.close_periods": "fees",
  "fees.reopen_periods": "fees",
  "fees.refund": "fees",
  "finance.view": "finance",
  "finance.manage": "finance",
  "expenses.record": "finance",
  "expenses.approve": "finance",
  "support.manage": "school_core",
  "transfers.manage": "transfer_passport",
  "insights.view": "insights",
  "assistant.use": "assistant",
  "assistant.manage": "assistant",
  "admissions.view": "admissions",
  "admissions.manage": "admissions",
  "events.view": "communication",
  "events.manage": "communication",
  "consent.view": "communication",
  "consent.manage": "communication",
  "staff.view": "staff_hr",
  "staff.manage": "staff_hr",
  "staff.documents": "staff_hr",
  "staff.attendance": "staff_hr",
  "leave.approve": "staff_hr",
  "leave.request": "staff_hr",
  "payroll.view": "payroll",
  "payroll.manage": "payroll",
  "payroll.approve": "payroll",
  "payroll.own": "payroll",
  "safeguarding.report": "safeguarding",
  "safeguarding.manage": "safeguarding",
  "safeguarding.appoint": "safeguarding",
  "visitors.view": "visitors_pickup",
  "visitors.manage": "visitors_pickup",
  "pickup.view": "visitors_pickup",
  "pickup.record": "visitors_pickup",
  "pickup.manage": "visitors_pickup",
  "transport.view": "transport",
  "transport.manage": "transport",
  "transport.trips": "transport",
  "inventory.view": "inventory_assets",
  "inventory.manage": "inventory_assets",
  "purchases.request": "inventory_assets",
  "purchases.approve": "inventory_assets",
  "maintenance.report": "inventory_assets",
  "maintenance.manage": "inventory_assets",
  "library.view": "library",
  "library.manage": "library",
  "boarding.view": "boarding",
  "boarding.manage": "boarding",
  "boarding.exeat": "boarding",
  "forecasting.view": "forecasting",
  "finance_checks.review": "forecasting",
  "early_warning.view": "early_warning",
  "early_warning.review": "early_warning",
  "early_warning.manage": "early_warning",
  "drafting.use": "ai_drafting",
  "drafting.board_report": "ai_drafting",
};

/**
 * Permissions that only read (ENT-08): still allowed while a module is read-only after an add-on, trial or
 * promotion ends, so the school can see and export its records but not change them.
 */
export const READ_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "staff.view",
  "staff.documents",
  "payroll.view",
  "payroll.own",
  "visitors.view",
  "pickup.view",
  "transport.view",
  "inventory.view",
  "library.view",
  "boarding.view",
  "forecasting.view",
  "early_warning.view",
  "finance.view",
]);

/** The plan module a permission needs, or null when it belongs to a core module (in every school). */
export function moduleOf(permission: Permission): Feature | null {
  const id = PERMISSION_MODULES[permission];
  return isPlanModule(id) ? id : null;
}

/** A member's access at one school: their roles there, and what the school's plan includes. */
export interface Access {
  roles: readonly Role[];
  features: readonly Feature[];
  /** Permissions the school has given this member beyond their roles (e.g. Accountants voiding receipts). */
  schoolGrants?: readonly Permission[];
  /** Present when EduBridge support is acting under the school's support grant. */
  support?: { grantId: string } | null;
  /** Each module's state for the school (the tenant context has it), for read-only access after an end. */
  modules?: Readonly<Record<string, { state: "active" | "read_only" | "off" }>>;
}

/** The module is active, or read-only and the permission only reads (ENT-08). */
function moduleAllows(access: Access, feature: Feature, permission: Permission): boolean {
  if (access.features.includes(feature)) return true;
  return READ_PERMISSIONS.has(permission) && access.modules?.[feature]?.state === "read_only";
}

/**
 * EduBridge support acts with the Proprietor's permissions while the school allows it (PLT-02), except
 * these: support access stays the school's decision, and bulk exports are not needed to help.
 */
const NOT_FOR_SUPPORT: readonly Permission[] = [
  "support.manage",
  "data.export",
  "fees.export",
  "assistant.manage",
  "plan.request",
  // D-R4-6: EduBridge support never sees or handles safeguarding.
  "safeguarding.report",
  "safeguarding.manage",
  "safeguarding.appoint",
  // ADR 0004: early-warning indicators and support plans are never for EduBridge support.
  "early_warning.view",
  "early_warning.review",
  "early_warning.manage",
];

const hasRole = (access: Access, permission: Permission) =>
  !(access.support && NOT_FOR_SUPPORT.includes(permission)) &&
  (can(access.roles, permission) || (access.schoolGrants?.includes(permission) ?? false));

/** The role allows it and, where it belongs to a module, that module is active for the school. */
export function allowed(access: Access, permission: Permission): boolean {
  if (!hasRole(access, permission)) return false;
  const feature = moduleOf(permission);
  return !feature || moduleAllows(access, feature, permission);
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
  const feature = moduleOf(permission);
  if (feature && !moduleAllows(access, feature, permission)) {
    if (access.modules?.[feature]?.state === "read_only")
      throw new DomainError(
        "module_read_only",
        `${FEATURE_LABELS[feature].name} has ended for this school: its records can be viewed and exported, not changed.`,
      );
    throw notIncluded(feature);
  }
}

/** For features without a permission of their own (e.g. Mobile Money, used with payments.record). */
export function assertFeature(access: Access, feature: Feature): void {
  if (!access.features.includes(feature)) throw notIncluded(feature);
}
