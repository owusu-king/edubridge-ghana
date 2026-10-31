import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan, isRole, type Role } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant, withUser } from "../db/context";
import { membershipCampuses, memberships, tenants, users } from "../db/schema";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  countryCode: string;
  timezone: string;
  currencyCode: string;
}

/** The authenticated user acting inside one school. Every tenant-scoped service call takes this. */
export interface TenantContext {
  tenant: Tenant;
  userId: string;
  roles: Role[];
  /** Campuses this membership is limited to; null means every campus. */
  campusIds: string[] | null;
}

const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  countryCode: tenants.countryCode,
  timezone: tenants.timezone,
  currencyCode: tenants.currencyCode,
};

function toRoles(values: string[]): Role[] {
  return values.filter(isRole);
}

/**
 * Resolves the user's access to a school by slug. Returns null when the school does not exist,
 * is suspended, or the user has no active membership — callers must not distinguish these cases.
 */
export async function resolveTenantContext(
  database: Database,
  slug: string,
  userId: string,
): Promise<TenantContext | null> {
  const [tenant] = await database
    .select(tenantColumns)
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.status, "active")))
    .limit(1);
  if (!tenant) return null;

  const membership = await withTenant(database, { tenantId: tenant.id, userId }, async (tx) => {
    const [row] = await tx
      .select({ id: memberships.id, roles: memberships.roles })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenant.id),
          eq(memberships.userId, userId),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    const scope = await tx
      .select({ campusId: membershipCampuses.campusId })
      .from(membershipCampuses)
      .where(and(eq(membershipCampuses.tenantId, tenant.id), eq(membershipCampuses.membershipId, row.id)));
    return { roles: row.roles, campusIds: scope.length > 0 ? scope.map((r) => r.campusId) : null };
  });
  if (!membership) return null;
  const roles = toRoles(membership.roles);
  if (roles.length === 0) return null;
  return { tenant, userId, roles, campusIds: membership.campusIds };
}

export interface UserSchool {
  slug: string;
  name: string;
  roles: Role[];
}

/** Schools the user can access, across tenants. */
export async function listUserSchools(database: Database, userId: string): Promise<UserSchool[]> {
  const rows = await withUser(database, userId, (tx) =>
    tx
      .select({ slug: tenants.slug, name: tenants.name, roles: memberships.roles })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(eq(memberships.userId, userId), eq(memberships.status, "active"), eq(tenants.status, "active")),
      )
      .orderBy(asc(tenants.name)),
  );
  return rows.map((r) => ({ ...r, roles: toRoles(r.roles) }));
}

export interface Member {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  roles: Role[];
  /** Campuses the membership is limited to; null means every campus. */
  campusIds: string[] | null;
  status: "active" | "suspended";
  joinedAt: Date;
  lastLoginAt: Date | null;
}

export async function listMembers(database: Database, ctx: TenantContext): Promise<Member[]> {
  assertCan(ctx.roles, "members.view");
  const { rows, scopes } = await withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId },
    async (tx) => {
      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          roles: memberships.roles,
          status: memberships.status,
          joinedAt: memberships.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        // Explicit tenant filter: RLS also lets a user see their own memberships in other schools.
        .where(eq(memberships.tenantId, ctx.tenant.id))
        .orderBy(asc(users.name));
      const scopes = await tx
        .select({ membershipId: membershipCampuses.membershipId, campusId: membershipCampuses.campusId })
        .from(membershipCampuses)
        .where(eq(membershipCampuses.tenantId, ctx.tenant.id));
      return { rows, scopes };
    },
  );
  const byMembership = new Map<string, string[]>();
  for (const s of scopes)
    byMembership.set(s.membershipId, [...(byMembership.get(s.membershipId) ?? []), s.campusId]);
  return rows.map((r) => ({
    ...r,
    roles: toRoles(r.roles),
    campusIds: byMembership.get(r.membershipId) ?? null,
  }));
}

export type RoleCounts = Record<Role, number>;

export async function countMembersByRole(database: Database, ctx: TenantContext): Promise<RoleCounts> {
  assertCan(ctx.roles, "members.view");
  const rows = await withTenant(database, { tenantId: ctx.tenant.id, userId: ctx.userId }, (tx) =>
    tx
      .select({ role: sql<string>`r.role`, n: sql<number>`count(*)::int` })
      .from(sql`${memberships}, unnest(${memberships.roles}) as r(role)`)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, "active")))
      .groupBy(sql`r.role`),
  );
  const counts: RoleCounts = { owner: 0, admin: 0, bursar: 0, teacher: 0, parent: 0, student: 0 };
  for (const row of rows) if (isRole(row.role)) counts[row.role] = row.n;
  return counts;
}

/** Whether the context may act on a campus (unrestricted memberships cover every campus). */
export function canAccessCampus(ctx: TenantContext, campusId: string): boolean {
  return ctx.campusIds === null || ctx.campusIds.includes(campusId);
}

export const SUPPORTED_TIMEZONES = [
  "Africa/Accra",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "UTC",
] as const;

export const schoolProfileSchema = z.object({
  name: z.string().trim().min(2, "Enter the school's name.").max(120, "Use 120 characters or fewer."),
  timezone: z.enum(SUPPORTED_TIMEZONES, { message: "Choose a supported time zone." }),
});
export type SchoolProfileInput = z.infer<typeof schoolProfileSchema>;

export async function updateSchoolProfile(
  database: Database,
  ctx: TenantContext,
  /** Unvalidated input, e.g. form data; parsed here. */
  input: unknown,
  meta: { ipAddress?: string | null } = {},
): Promise<Tenant> {
  assertCan(ctx.roles, "school.settings.manage");
  const data = schoolProfileSchema.parse(input);
  return withTenant(database, { tenantId: ctx.tenant.id, userId: ctx.userId }, async (tx) => {
    const [updated] = await tx
      .update(tenants)
      .set({ name: data.name, timezone: data.timezone, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenant.id))
      .returning(tenantColumns);
    if (!updated) throw new Error("School not found.");

    const changes: Record<string, { from: string; to: string }> = {};
    if (ctx.tenant.name !== data.name) changes.name = { from: ctx.tenant.name, to: data.name };
    if (ctx.tenant.timezone !== data.timezone)
      changes.timezone = { from: ctx.tenant.timezone, to: data.timezone };
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "school.profile.updated",
        entityType: "tenant",
        entityId: ctx.tenant.id,
        metadata: { changes },
        ipAddress: meta.ipAddress ?? null,
      });
    }
    return updated;
  });
}
