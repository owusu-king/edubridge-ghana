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
  // Voiding a receipt is a fraud-sensitive control: only the Proprietor may do it (assumption to verify).
  "payments.void": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof GRANTS;

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
