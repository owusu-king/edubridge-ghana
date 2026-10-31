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
  "school.settings.manage": ["owner", "admin"],
  // Head teachers oversee staff and academics; finance access (read-only) arrives with the fees module.
  "members.view": ["owner", "headteacher", "admin"],
  "members.manage": ["owner", "admin"],
  "campuses.manage": ["owner", "admin"],
  "plan.view": ["owner", "admin"],
  "audit.view": ["owner", "admin"],
  "security.manage": ["owner"],
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
