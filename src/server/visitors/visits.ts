import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { localToUtc } from "../../lib/format";
import { normalizePhone } from "../../lib/phone";
import { VISIT_PURPOSES, type VisitPurpose } from "../../lib/visitors";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { campuses, memberships, users, visitorVisits } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Visitors (R4-4 VIS-01; module visitors_pickup). The office signs visitors in and out. A visit is signed out
 * once; nothing else about it changes and it is never deleted (database). Staff limited to some campuses see
 * and sign in visitors at those campuses only (and visits recorded without a campus).
 */

const UUID = z.string().uuid();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable().optional());

const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Visits this member may see: at their campuses, or recorded without a campus. */
function campusScope(ctx: TenantContext): SQL | undefined {
  if (ctx.campusIds === null) return undefined;
  return ctx.campusIds.length
    ? or(isNull(visitorVisits.campusId), inArray(visitorVisits.campusId, ctx.campusIds))
    : isNull(visitorVisits.campusId);
}

const signInSchema = (country: string) =>
  z.object({
    fullName: z
      .string({ message: "Enter the visitor's name." })
      .trim()
      .min(2, "Enter the visitor's name.")
      .max(120, "Use 120 characters or fewer."),
    phone: z.preprocess(
      blank,
      z
        .string()
        .transform((v, c) => {
          const phone = normalizePhone(v, country);
          if (!phone) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
          return phone ?? "";
        })
        .nullable()
        .optional(),
    ),
    organisation: optionalText(120),
    purpose: z.enum(VISIT_PURPOSES, { message: "Choose why they are here." }),
    hostMembershipId: z.preprocess(blank, UUID.nullable().optional()),
    hostName: optionalText(120),
    campusId: z.preprocess(blank, UUID.nullable().optional()),
    badge: optionalText(20),
    note: optionalText(500),
  });

export interface VisitorOptions {
  hosts: { id: string; name: string }[];
  /** The campuses this member can sign visitors in at (empty: the school has one site). */
  campuses: { id: string; name: string }[];
}

/** Who can be visited (active staff) and where, for the sign-in form. */
export async function listVisitorOptions(database: Database, ctx: TenantContext): Promise<VisitorOptions> {
  assertAllowed(ctx, "visitors.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [hosts, sites] = await Promise.all([
      tx
        .select({ id: memberships.id, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.tenantId, ctx.tenant.id),
            eq(memberships.status, "active"),
            sql`${memberships.roles} && ARRAY['owner','headteacher','admin','bursar','teacher']::text[]`,
          ),
        )
        .orderBy(asc(users.name)),
      tx
        .select({ id: campuses.id, name: campuses.name })
        .from(campuses)
        .where(eq(campuses.tenantId, ctx.tenant.id))
        .orderBy(asc(campuses.name)),
    ]);
    const visible = sites.filter((c) => ctx.campusIds === null || ctx.campusIds.includes(c.id));
    return { hosts, campuses: sites.length > 1 ? visible : [] };
  });
}

export async function signInVisitor(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<string> {
  assertAllowed(ctx, "visitors.manage");
  const data = signInSchema(ctx.tenant.countryCode).parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const sites = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(eq(campuses.tenantId, ctx.tenant.id));
    const mine = sites.filter((c) => ctx.campusIds === null || ctx.campusIds.includes(c.id));
    let campusId = data.campusId ?? null;
    if (campusId && !mine.some((c) => c.id === campusId))
      throw new DomainError("campus_scope", "Choose one of your campuses.", "campusId");
    // One site, or one campus for this member: that is where the visitor is.
    if (!campusId && mine.length === 1) campusId = mine[0]!.id;
    if (!campusId && sites.length > 1)
      throw new DomainError("campus_required", "Choose the campus.", "campusId");

    if (data.hostMembershipId) {
      const [host] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, ctx.tenant.id),
            eq(memberships.id, data.hostMembershipId),
            eq(memberships.status, "active"),
          ),
        );
      if (!host) throw new DomainError("not_found", "Choose a member of staff.", "hostMembershipId");
    }
    const [row] = await tx
      .insert(visitorVisits)
      .values({
        tenantId: ctx.tenant.id,
        campusId,
        fullName: data.fullName,
        phone: data.phone || null,
        organisation: data.organisation ?? null,
        purpose: data.purpose,
        hostMembershipId: data.hostMembershipId ?? null,
        hostName: data.hostMembershipId ? null : (data.hostName ?? null),
        badge: data.badge ?? null,
        note: data.note ?? null,
        signedInByUserId: ctx.userId,
      })
      .returning({ id: visitorVisits.id });
    return row!.id;
  });
}

export async function signOutVisitor(database: Database, ctx: TenantContext, visitId: string): Promise<void> {
  assertAllowed(ctx, "visitors.manage");
  if (!UUID.safeParse(visitId).success) throw new DomainError("not_found", "Visit not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [visit] = await tx
      .select({ signedOutAt: visitorVisits.signedOutAt })
      .from(visitorVisits)
      .where(and(eq(visitorVisits.tenantId, ctx.tenant.id), eq(visitorVisits.id, visitId), campusScope(ctx)))
      .for("update");
    if (!visit) throw new DomainError("not_found", "Visit not found.");
    if (visit.signedOutAt) throw new DomainError("signed_out", "This visitor has already been signed out.");
    await tx
      .update(visitorVisits)
      .set({ signedOutAt: new Date(), signedOutByUserId: ctx.userId })
      .where(eq(visitorVisits.id, visitId));
  });
}

export interface Visit {
  id: string;
  fullName: string;
  phone: string | null;
  organisation: string | null;
  purpose: VisitPurpose;
  visiting: string | null;
  campus: string | null;
  badge: string | null;
  note: string | null;
  signedInAt: Date;
  signedInBy: string;
  signedOutAt: Date | null;
  signedOutBy: string | null;
}

async function readVisits(
  database: Database,
  ctx: TenantContext,
  where: SQL | undefined,
  newestFirst: boolean,
) {
  const host = alias(users, "host_user");
  const inBy = alias(users, "in_by");
  const outBy = alias(users, "out_by");
  return withTenant(database, scopeOf(ctx), async (tx): Promise<Visit[]> => {
    const rows = await tx
      .select({
        v: visitorVisits,
        host: host.name,
        campus: campuses.name,
        inBy: inBy.name,
        outBy: outBy.name,
      })
      .from(visitorVisits)
      .leftJoin(memberships, eq(memberships.id, visitorVisits.hostMembershipId))
      .leftJoin(host, eq(host.id, memberships.userId))
      .leftJoin(campuses, eq(campuses.id, visitorVisits.campusId))
      .innerJoin(inBy, eq(inBy.id, visitorVisits.signedInByUserId))
      .leftJoin(outBy, eq(outBy.id, visitorVisits.signedOutByUserId))
      .where(and(eq(visitorVisits.tenantId, ctx.tenant.id), campusScope(ctx), where))
      .orderBy(newestFirst ? desc(visitorVisits.signedInAt) : asc(visitorVisits.signedInAt));
    return rows.map(({ v, host: hostName, campus, inBy: by, outBy: out }) => ({
      id: v.id,
      fullName: v.fullName,
      phone: v.phone,
      organisation: v.organisation,
      purpose: v.purpose,
      visiting: hostName ?? v.hostName,
      campus,
      badge: v.badge,
      note: v.note,
      signedInAt: v.signedInAt,
      signedInBy: by,
      signedOutAt: v.signedOutAt,
      signedOutBy: out,
    }));
  });
}

/** Visitors signed in and not out (VIS-01b), earliest first, including any left from an earlier day. */
export async function listOnSite(database: Database, ctx: TenantContext): Promise<Visit[]> {
  assertAllowed(ctx, "visitors.view");
  return readVisits(database, ctx, isNull(visitorVisits.signedOutAt), false);
}

/** Every visit signed in on a school-local day (VIS-01c), newest first. */
export async function listVisitsOn(database: Database, ctx: TenantContext, day: string): Promise<Visit[]> {
  assertAllowed(ctx, "visitors.view");
  if (!ISO_DATE.test(day)) throw new DomainError("invalid_date", "Choose a date.");
  const tz = ctx.tenant.timezone;
  const start = localToUtc(`${day}T00:00`, tz);
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = localToUtc(`${next.toISOString().slice(0, 10)}T00:00`, tz);
  return readVisits(
    database,
    ctx,
    and(gte(visitorVisits.signedInAt, start), lt(visitorVisits.signedInAt, end)),
    true,
  );
}
