import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed, isRole, type Permission, type Role } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant, withUser } from "../db/context";
import {
  membershipCampuses,
  memberships,
  platformAdmins,
  tenantEntitlements,
  tenants,
  users,
} from "../db/schema";
import { readLiveGrant } from "../support/grants";
import { FEATURES, isFeature, type BillingState, type Feature } from "../../lib/plan";
import { readBillingState } from "../billing/state";
import { readPreferences } from "./preferences";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  countryCode: string;
  timezone: string;
  currencyCode: string;
  /** Roles that must use two-step verification at this school. */
  mfaRequiredRoles: Role[];
  /** A demonstration school with made-up data (sends no messages, not in the parent view). */
  isDemo: boolean;
}

/** The authenticated user acting inside one school. Every tenant-scoped service call takes this. */
export interface TenantContext {
  tenant: Tenant;
  userId: string;
  roles: Role[];
  /** Campuses this membership is limited to; null means every campus. */
  campusIds: string[] | null;
  /** True when one of the member's roles must use two-step verification here. */
  mfaRequired: boolean;
  /** Modules the school's plan includes (checked with `allowed` / `assertAllowed`). */
  features: Feature[];
  /** Whether an overdue EduBridge invoice has paused school-initiated SMS (or soon will). */
  billing: BillingState;
  /** Permissions the school's own settings give this member beyond their roles. */
  schoolGrants: Permission[];
  /**
   * Set when this is EduBridge support inside the school under the Proprietor's support grant (PLT-02):
   * the Proprietor's permissions except support access and exports, until the grant ends.
   */
  support?: { grantId: string; expiresAt: Date } | null;
}

const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  countryCode: tenants.countryCode,
  timezone: tenants.timezone,
  currencyCode: tenants.currencyCode,
  mfaRequiredRoles: tenants.mfaRequiredRoles,
  isDemo: tenants.isDemo,
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
  const [row] = await database
    .select(tenantColumns)
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.status, "active")))
    .limit(1);
  if (!row) return null;
  const tenant: Tenant = { ...row, mfaRequiredRoles: toRoles(row.mfaRequiredRoles) };

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
    const [plan] = await tx
      .select({ features: tenantEntitlements.features })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenant.id));
    return {
      roles: row.roles,
      campusIds: scope.length > 0 ? scope.map((r) => r.campusId) : null,
      // A school without a plan row (made outside platform onboarding) gets the column's default: everything.
      features: plan ? plan.features.filter(isFeature) : [...FEATURES],
      billing: await readBillingState(tx, tenant),
      preferences: await readPreferences(tx, tenant.id),
    };
  });
  if (!membership) return resolveSupportContext(database, tenant, userId);
  const roles = toRoles(membership.roles);
  if (roles.length === 0) return null;
  const mfaRequired = roles.some((r) => tenant.mfaRequiredRoles.includes(r));
  return {
    tenant,
    userId,
    roles,
    campusIds: membership.campusIds,
    mfaRequired,
    features: membership.features,
    billing: membership.billing,
    schoolGrants:
      membership.preferences.accountantsCanVoid && roles.includes("bursar") ? ["payments.void"] : [],
  };
}

/**
 * EduBridge platform staff who are not members reach a school only while its Proprietor allows support
 * access (PLT-02). Checked on every request, so ending the grant or its expiry applies on the next page.
 */
async function resolveSupportContext(
  database: Database,
  tenant: Tenant,
  userId: string,
): Promise<TenantContext | null> {
  const [admin] = await database
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);
  if (!admin) return null;
  const found = await withTenant(database, { tenantId: tenant.id, userId }, async (tx) => {
    const grant = await readLiveGrant(tx, tenant.id);
    if (!grant) return null;
    const [plan] = await tx
      .select({ features: tenantEntitlements.features })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenant.id));
    return {
      grant,
      features: plan ? plan.features.filter(isFeature) : [...FEATURES],
      billing: await readBillingState(tx, tenant),
    };
  });
  if (!found) return null;
  return {
    tenant,
    userId,
    roles: ["owner"],
    campusIds: null,
    // Platform staff can reach many schools, so two-step verification applies as on the admin pages.
    mfaRequired: process.env.PLATFORM_MFA_REQUIRED !== "false",
    features: found.features,
    billing: found.billing,
    schoolGrants: [],
    support: { grantId: found.grant.id, expiresAt: found.grant.expiresAt },
  };
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
  assertAllowed(ctx, "members.view");
  const { rows, scopes } = await withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
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
  assertAllowed(ctx, "members.view");
  const rows = await withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    (tx) =>
      tx
        .select({ role: sql<string>`r.role`, n: sql<number>`count(*)::int` })
        .from(sql`${memberships}, unnest(${memberships.roles}) as r(role)`)
        .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, "active")))
        .groupBy(sql`r.role`),
  );
  const counts: RoleCounts = {
    owner: 0,
    headteacher: 0,
    admin: 0,
    bursar: 0,
    teacher: 0,
    parent: 0,
    student: 0,
  };
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
): Promise<Omit<Tenant, "mfaRequiredRoles">> {
  assertAllowed(ctx, "school.settings.manage");
  const data = schoolProfileSchema.parse(input);
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
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
    },
  );
}

export const mfaPolicySchema = z.object({
  roles: z
    .array(z.enum(["owner", "headteacher", "admin", "bursar", "teacher"], { message: "Choose valid roles." }))
    .transform((r) => [...new Set(r)].sort()),
});

/** Proprietors choose which roles must use two-step verification at their school. Audited. */
export async function updateMfaPolicy(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  meta: { ipAddress?: string | null } = {},
): Promise<void> {
  assertAllowed(ctx, "security.manage");
  const { roles } = mfaPolicySchema.parse(input);
  await withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      await tx
        .update(tenants)
        .set({ mfaRequiredRoles: roles, updatedAt: new Date() })
        .where(eq(tenants.id, ctx.tenant.id));
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "school.mfa_policy.updated",
        entityType: "tenant",
        entityId: ctx.tenant.id,
        metadata: { changes: { roles: { from: ctx.tenant.mfaRequiredRoles, to: roles } } },
        ipAddress: meta.ipAddress ?? null,
      });
    },
  );
}
