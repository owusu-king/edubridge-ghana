import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { campuses, tenantEntitlements } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { canAccessCampus, type TenantContext } from "../tenancy/service";

export interface Campus {
  id: string;
  name: string;
  status: "active" | "archived";
  createdAt: Date;
}

export const campusNameSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters.").max(80, "Use 80 characters or fewer."),
});

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

export async function listCampuses(database: Database, ctx: TenantContext): Promise<Campus[]> {
  const rows = await withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: campuses.id,
        name: campuses.name,
        status: campuses.status,
        createdAt: campuses.createdAt,
      })
      .from(campuses)
      .where(eq(campuses.tenantId, ctx.tenant.id))
      .orderBy(sql`${campuses.status} = 'archived'`, asc(campuses.name)),
  );
  // Members limited to some campuses only see those.
  return rows.filter((c) => canAccessCampus(ctx, c.id));
}

export interface PlanUsage {
  planName: string;
  maxCampuses: number;
  maxStudents: number | null;
  activeCampuses: number;
}

async function readUsage(tx: Transaction, tenantId: string): Promise<PlanUsage> {
  const [plan] = await tx
    .select({
      planName: tenantEntitlements.planName,
      maxCampuses: tenantEntitlements.maxCampuses,
      maxStudents: tenantEntitlements.maxStudents,
    })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campuses)
    .where(and(eq(campuses.tenantId, tenantId), eq(campuses.status, "active")));
  // A school without a plan row gets the most restrictive default rather than no limit.
  return {
    planName: plan?.planName ?? "Pilot",
    maxCampuses: plan?.maxCampuses ?? 1,
    maxStudents: plan?.maxStudents ?? null,
    activeCampuses: count?.n ?? 0,
  };
}

export async function getPlanUsage(database: Database, ctx: TenantContext): Promise<PlanUsage> {
  assertCan(ctx.roles, "plan.view");
  return withTenant(database, scope(ctx), (tx) => readUsage(tx, ctx.tenant.id));
}

/**
 * Serialises campus-limit checks per school, so two concurrent requests cannot both pass the limit.
 * Advisory locks are released automatically at transaction end.
 */
async function lockCampusLimit(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"campuses:" + tenantId}, 0))`);
}

async function assertWithinLimit(tx: Transaction, tenantId: string): Promise<void> {
  await lockCampusLimit(tx, tenantId);
  const usage = await readUsage(tx, tenantId);
  if (usage.activeCampuses >= usage.maxCampuses) {
    throw new DomainError(
      "campus_limit_reached",
      `Your plan allows ${usage.maxCampuses} active ${usage.maxCampuses === 1 ? "campus" : "campuses"}. Archive one or contact EduBridge to change your plan.`,
    );
  }
}

function mapUnique(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
    throw new DomainError("campus_name_taken", "Another campus already has this name.", "name");
  }
  throw error;
}

function assertManage(ctx: TenantContext): void {
  assertCan(ctx.roles, "campuses.manage");
  // Creating, renaming and archiving campuses affects the whole school.
  if (ctx.campusIds !== null) {
    throw new DomainError("campus_scope", "Only members with access to every campus can manage campuses.");
  }
}

export async function createCampus(
  database: Database,
  ctx: TenantContext,
  input: { name: string },
): Promise<Campus> {
  assertManage(ctx);
  const { name } = campusNameSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    await assertWithinLimit(tx, ctx.tenant.id);
    const [campus] = await tx.insert(campuses).values({ tenantId: ctx.tenant.id, name }).returning({
      id: campuses.id,
      name: campuses.name,
      status: campuses.status,
      createdAt: campuses.createdAt,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "campus.created",
      entityType: "campus",
      entityId: campus!.id,
      metadata: { name },
    });
    return campus!;
  }).catch(mapUnique);
}

async function loadCampus(tx: Transaction, ctx: TenantContext, campusId: string) {
  if (!z.string().uuid().safeParse(campusId).success)
    throw new DomainError("campus_not_found", "Campus not found.");
  const [campus] = await tx
    .select()
    .from(campuses)
    .where(and(eq(campuses.tenantId, ctx.tenant.id), eq(campuses.id, campusId)))
    .for("update");
  if (!campus) throw new DomainError("campus_not_found", "Campus not found.");
  return campus;
}

export async function renameCampus(
  database: Database,
  ctx: TenantContext,
  campusId: string,
  input: { name: string },
): Promise<void> {
  assertManage(ctx);
  const { name } = campusNameSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const campus = await loadCampus(tx, ctx, campusId);
    if (campus.name === name) return;
    await tx.update(campuses).set({ name, updatedAt: new Date() }).where(eq(campuses.id, campus.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "campus.renamed",
      entityType: "campus",
      entityId: campus.id,
      metadata: { from: campus.name, to: name },
    });
  }).catch(mapUnique);
}

export async function setCampusStatus(
  database: Database,
  ctx: TenantContext,
  campusId: string,
  status: "active" | "archived",
): Promise<void> {
  assertManage(ctx);
  await withTenant(database, scope(ctx), async (tx) => {
    const campus = await loadCampus(tx, ctx, campusId);
    if (campus.status === status) return;
    if (status === "active") {
      await assertWithinLimit(tx, ctx.tenant.id);
    } else {
      await lockCampusLimit(tx, ctx.tenant.id);
      const usage = await readUsage(tx, ctx.tenant.id);
      if (usage.activeCampuses <= 1) {
        throw new DomainError("last_campus", "A school needs at least one active campus.");
      }
    }
    await tx.update(campuses).set({ status, updatedAt: new Date() }).where(eq(campuses.id, campus.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: status === "archived" ? "campus.archived" : "campus.restored",
      entityType: "campus",
      entityId: campus.id,
      metadata: { name: campus.name },
    });
  });
}
