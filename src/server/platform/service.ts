import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import type { Database } from "../db/client";
import { setTenantContext, withTenant, withUser } from "../db/context";
import { campuses, invitations, platformAdmins, tenantEntitlements, tenants } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { issueInvitation, type IssuedInvitation } from "../invitations/service";
import { isValidSlug } from "../tenancy/slug";
import { SUPPORTED_TIMEZONES } from "../tenancy/service";

/**
 * Platform administration: EduBridge staff operating schools. Every function re-checks the platform
 * administrator flag; the database independently refuses tenant creation, status changes and plan edits
 * from anyone else (see drizzle/0003_platform_campuses_rls.sql). Every action is audited in the school's log.
 */

export const SUPPORTED_COUNTRIES = ["GH", "NG", "KE", "RW", "ZA"] as const;
export const SUPPORTED_CURRENCIES = ["GHS", "USD", "NGN", "KES", "RWF", "ZAR", "GBP", "EUR"] as const;

export class NotPlatformAdminError extends Error {
  constructor() {
    super("Platform administrator required");
    this.name = "NotPlatformAdminError";
  }
}

export async function isPlatformAdmin(database: Database, userId: string): Promise<boolean> {
  const [row] = await database
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);
  return Boolean(row);
}

async function assertPlatformAdmin(database: Database, userId: string): Promise<void> {
  if (!(await isPlatformAdmin(database, userId))) throw new NotPlatformAdminError();
}

const optionalLimit = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
  z.number().int("Use a whole number.").min(1, "Use 1 or more.").max(1_000_000, "Too large.").nullable(),
);

export const entitlementsSchema = z.object({
  planName: z.string().trim().min(2, "Enter a plan name.").max(60, "Use 60 characters or fewer."),
  maxCampuses: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 or more.")
    .max(1000, "Use 1000 or fewer."),
  maxStudents: optionalLimit,
});

export const createSchoolSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the school's name.").max(120, "Use 120 characters or fewer."),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isValidSlug, "Use 3–48 lowercase letters, numbers and single hyphens."),
    countryCode: z.enum(SUPPORTED_COUNTRIES, { message: "Choose a country." }),
    currencyCode: z.enum(SUPPORTED_CURRENCIES, { message: "Choose a currency." }),
    timezone: z.enum(SUPPORTED_TIMEZONES, { message: "Choose a time zone." }),
    ownerEmail: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  })
  .and(entitlementsSchema);

export interface CreatedSchool {
  tenantId: string;
  slug: string;
  ownerInvitation: IssuedInvitation;
}

/** Creates a school with its plan, a first campus, and a single-use invitation for its owner. */
export async function createSchool(
  database: Database,
  actorUserId: string,
  /** Unvalidated input, e.g. form data; parsed here. */
  input: unknown,
): Promise<CreatedSchool> {
  await assertPlatformAdmin(database, actorUserId);
  const data = createSchoolSchema.parse(input);
  try {
    return await withUser(database, actorUserId, async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`select platform_create_tenant(${data.slug}, ${data.name}, ${data.countryCode}, ${data.currencyCode}, ${data.timezone}) as id`,
      );
      const tenantId = result.rows[0]!.id;
      await setTenantContext(tx, { tenantId, userId: actorUserId });
      await tx.insert(tenantEntitlements).values({
        tenantId,
        planName: data.planName,
        maxCampuses: data.maxCampuses,
        maxStudents: data.maxStudents,
      });
      await tx.insert(campuses).values({ tenantId, name: "Main campus" });
      await recordAudit(tx, {
        tenantId,
        actorUserId,
        action: "school.created",
        entityType: "tenant",
        entityId: tenantId,
        metadata: {
          slug: data.slug,
          plan: data.planName,
          maxCampuses: data.maxCampuses,
          maxStudents: data.maxStudents,
        },
      });
      const ownerInvitation = await issueInvitation(tx, {
        tenantId,
        email: data.ownerEmail,
        roles: ["owner"],
        invitedByUserId: actorUserId,
      });
      return { tenantId, slug: data.slug, ownerInvitation };
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DomainError("slug_taken", "This address is already used by another school.", "slug");
    }
    throw error;
  }
}

export interface SchoolSummary {
  id: string;
  slug: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  status: "active" | "suspended";
  planName: string | null;
  createdAt: Date;
}

export async function listSchools(database: Database, actorUserId: string): Promise<SchoolSummary[]> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, (tx) =>
    tx
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        countryCode: tenants.countryCode,
        currencyCode: tenants.currencyCode,
        status: tenants.status,
        planName: tenantEntitlements.planName,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .leftJoin(tenantEntitlements, eq(tenantEntitlements.tenantId, tenants.id))
      .orderBy(asc(tenants.name)),
  );
}

export interface SchoolDetail extends SchoolSummary {
  timezone: string;
  entitlements: { planName: string; maxCampuses: number; maxStudents: number | null } | null;
  activeCampuses: number;
  invitations: {
    id: string;
    email: string;
    roles: string[];
    expiresAt: Date;
    createdAt: Date;
    state: "pending" | "accepted" | "revoked" | "expired";
  }[];
}

export async function getSchool(
  database: Database,
  actorUserId: string,
  tenantId: string,
): Promise<SchoolDetail | null> {
  await assertPlatformAdmin(database, actorUserId);
  if (!z.string().uuid().safeParse(tenantId).success) return null;
  const [tenant] = await database.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [entitlements] = await tx
      .select({
        planName: tenantEntitlements.planName,
        maxCampuses: tenantEntitlements.maxCampuses,
        maxStudents: tenantEntitlements.maxStudents,
      })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenantId));
    const [campusCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(campuses)
      .where(sql`${campuses.tenantId} = ${tenantId} and ${campuses.status} = 'active'`);
    const invites = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tenantId, tenantId))
      .orderBy(desc(invitations.createdAt))
      .limit(20);
    const now = Date.now();
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      countryCode: tenant.countryCode,
      currencyCode: tenant.currencyCode,
      timezone: tenant.timezone,
      status: tenant.status,
      planName: entitlements?.planName ?? null,
      createdAt: tenant.createdAt,
      entitlements: entitlements ?? null,
      activeCampuses: campusCount?.n ?? 0,
      invitations: invites.map((i) => ({
        id: i.id,
        email: i.email,
        roles: i.roles,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        state: i.acceptedAt
          ? "accepted"
          : i.revokedAt
            ? "revoked"
            : i.expiresAt.getTime() <= now
              ? "expired"
              : "pending",
      })),
    };
  });
}

export async function setSchoolStatus(
  database: Database,
  actorUserId: string,
  tenantId: string,
  status: "active" | "suspended",
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    await tx.execute(sql`select platform_set_tenant_status(${tenantId}::uuid, ${status})`);
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: status === "suspended" ? "school.suspended" : "school.reactivated",
      entityType: "tenant",
      entityId: tenantId,
    });
  });
}

export async function updateEntitlements(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = entitlementsSchema.parse(input);
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const [before] = await tx
      .select()
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenantId));
    await tx
      .insert(tenantEntitlements)
      .values({ tenantId, ...data })
      .onConflictDoUpdate({ target: tenantEntitlements.tenantId, set: { ...data, updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: "entitlements.updated",
      entityType: "tenant",
      entityId: tenantId,
      metadata: {
        from: before
          ? { planName: before.planName, maxCampuses: before.maxCampuses, maxStudents: before.maxStudents }
          : null,
        to: data,
      },
    });
  });
}

/** Issues a fresh owner invitation link (revoking any pending one for that email). */
export async function reissueOwnerInvitation(
  database: Database,
  actorUserId: string,
  tenantId: string,
  email: string,
): Promise<IssuedInvitation> {
  await assertPlatformAdmin(database, actorUserId);
  const parsed = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254).parse(email);
  return withTenant(database, { tenantId, userId: actorUserId }, (tx) =>
    issueInvitation(tx, { tenantId, email: parsed, roles: ["owner"], invitedByUserId: actorUserId }),
  );
}
