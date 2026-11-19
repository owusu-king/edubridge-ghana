import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  MAINTENANCE_NEXT,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  maintenanceReference,
  type MaintenancePriority,
  type MaintenanceStatus,
} from "../../lib/inventory";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { assets, maintenanceRequests, maintenanceUpdates, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { audit, blank, nextNumber, optionalText, requiredText, scopeOf, UUID } from "./common";

/**
 * Maintenance requests (R4-6 INV-02c). Any member of staff reports what needs fixing; the office moves it on.
 * Every change is kept (insert-only updates); done or cancelled is final (database). Reporters see their own.
 */

export interface MaintenanceSummary {
  id: string;
  reference: string;
  title: string;
  location: string | null;
  asset: string | null;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  assignedTo: string | null;
  reportedBy: string;
  reportedAt: Date;
  updatedAt: Date;
}

const reporter = alias(users, "reporter");

/** Everyone sees all of them, except staff who only report: they see their own. */
const seesAll = (ctx: TenantContext) => allowed(ctx, "maintenance.manage") || allowed(ctx, "inventory.view");

export async function listMaintenance(database: Database, ctx: TenantContext): Promise<MaintenanceSummary[]> {
  assertAllowed(ctx, "maintenance.report");
  const all = seesAll(ctx);
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        location: maintenanceRequests.location,
        asset: sql<
          string | null
        >`case when ${assets.id} is null then null else ${assets.tag} || ' ' || ${assets.name} end`,
        priority: maintenanceRequests.priority,
        status: maintenanceRequests.status,
        assignedTo: maintenanceRequests.assignedTo,
        reportedBy: reporter.name,
        reportedAt: maintenanceRequests.reportedAt,
        updatedAt: maintenanceRequests.updatedAt,
      })
      .from(maintenanceRequests)
      .innerJoin(reporter, eq(reporter.id, maintenanceRequests.reportedByUserId))
      .leftJoin(assets, eq(assets.id, maintenanceRequests.assetId))
      .where(
        and(
          eq(maintenanceRequests.tenantId, ctx.tenant.id),
          all ? undefined : eq(maintenanceRequests.reportedByUserId, ctx.userId),
        ),
      )
      .orderBy(
        sql`${maintenanceRequests.status} in ('done', 'cancelled')`,
        sql`${maintenanceRequests.priority} = 'urgent' desc`,
        desc(maintenanceRequests.reportedAt),
      )
      .limit(300),
  );
}

export interface MaintenanceDetail extends MaintenanceSummary {
  description: string | null;
  assetId: string | null;
  updates: {
    id: string;
    status: MaintenanceStatus | null;
    assignedTo: string | null;
    note: string | null;
    by: string;
    at: Date;
  }[];
}

export async function getMaintenance(
  database: Database,
  ctx: TenantContext,
  requestId: string,
): Promise<MaintenanceDetail | null> {
  assertAllowed(ctx, "maintenance.report");
  if (!UUID.safeParse(requestId).success) return null;
  const all = seesAll(ctx);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({
        r: maintenanceRequests,
        reportedBy: reporter.name,
        asset: sql<
          string | null
        >`case when ${assets.id} is null then null else ${assets.tag} || ' ' || ${assets.name} end`,
      })
      .from(maintenanceRequests)
      .innerJoin(reporter, eq(reporter.id, maintenanceRequests.reportedByUserId))
      .leftJoin(assets, eq(assets.id, maintenanceRequests.assetId))
      .where(and(eq(maintenanceRequests.tenantId, ctx.tenant.id), eq(maintenanceRequests.id, requestId)));
    if (!row || (!all && row.r.reportedByUserId !== ctx.userId)) return null;
    const updates = await tx
      .select({
        id: maintenanceUpdates.id,
        status: maintenanceUpdates.status,
        assignedTo: maintenanceUpdates.assignedTo,
        note: maintenanceUpdates.note,
        by: users.name,
        at: maintenanceUpdates.at,
      })
      .from(maintenanceUpdates)
      .innerJoin(users, eq(users.id, maintenanceUpdates.byUserId))
      .where(and(eq(maintenanceUpdates.tenantId, ctx.tenant.id), eq(maintenanceUpdates.requestId, requestId)))
      .orderBy(desc(maintenanceUpdates.at));
    const r = row.r;
    return {
      id: r.id,
      reference: r.reference,
      title: r.title,
      description: r.description,
      location: r.location,
      assetId: r.assetId,
      asset: row.asset,
      priority: r.priority,
      status: r.status,
      assignedTo: r.assignedTo,
      reportedBy: row.reportedBy,
      reportedAt: r.reportedAt,
      updatedAt: r.updatedAt,
      updates,
    };
  });
}

const reportSchema = z.object({
  title: requiredText(3, 120, "Say what needs fixing, e.g. Broken window in Basic 4A."),
  description: optionalText(2000),
  location: optionalText(120),
  assetId: z.preprocess(blank, UUID.nullable().optional()),
  priority: z.enum(MAINTENANCE_PRIORITIES, { message: "Choose how urgent it is." }),
});

/** Any member of staff reports something that needs fixing (MR0001). */
export async function reportMaintenance(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<{ id: string; reference: string }> {
  assertAllowed(ctx, "maintenance.report");
  const data = reportSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (data.assetId) {
      const [a] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.tenantId, ctx.tenant.id), eq(assets.id, data.assetId)));
      if (!a) throw new DomainError("not_found", "Choose an asset.", "assetId");
    }
    const reference = maintenanceReference(await nextNumber(tx, ctx.tenant.id, "maintenance_request"));
    const [row] = await tx
      .insert(maintenanceRequests)
      .values({
        tenantId: ctx.tenant.id,
        reference,
        title: data.title,
        description: data.description ?? null,
        location: data.location ?? null,
        assetId: data.assetId ?? null,
        priority: data.priority,
        reportedByUserId: ctx.userId,
      })
      .returning({ id: maintenanceRequests.id });
    await audit(tx, ctx, "maintenance.reported", "maintenance_request", row!.id, {
      reference,
      priority: data.priority,
    });
    return { id: row!.id, reference };
  });
}

const updateSchema = z.object({
  status: z.enum(MAINTENANCE_STATUSES, { message: "Choose a status." }),
  assignedTo: optionalText(120),
  note: optionalText(1000),
});

/** The office moves a request on (in progress, done with what was done, cancelled) or notes who is on it. */
export async function updateMaintenance(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "maintenance.manage");
  const data = updateSchema.parse(input);
  if (!UUID.safeParse(requestId).success) throw new DomainError("not_found", "Request not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select()
      .from(maintenanceRequests)
      .where(and(eq(maintenanceRequests.tenantId, ctx.tenant.id), eq(maintenanceRequests.id, requestId)))
      .for("update");
    if (!row) throw new DomainError("not_found", "Request not found.");
    if (MAINTENANCE_NEXT[row.status].length === 0)
      throw new DomainError("closed", "This request is closed. Report it again if it needs more work.");
    const statusChanged = data.status !== row.status;
    if (statusChanged && !MAINTENANCE_NEXT[row.status].includes(data.status))
      throw new DomainError("invalid", "A request in progress cannot go back to open.", "status");
    if (data.status === "done" && statusChanged && !data.note)
      throw new DomainError("note_required", "Say what was done.", "note");
    const assignedTo = data.assignedTo ?? null;
    const assignedChanged = assignedTo !== row.assignedTo;
    if (!statusChanged && !assignedChanged && !data.note)
      throw new DomainError("no_change", "Nothing has changed.");
    await tx
      .update(maintenanceRequests)
      .set({ status: data.status, assignedTo, updatedAt: new Date() })
      .where(eq(maintenanceRequests.id, requestId));
    await tx.insert(maintenanceUpdates).values({
      tenantId: ctx.tenant.id,
      requestId,
      status: statusChanged ? data.status : null,
      assignedTo: assignedChanged ? assignedTo : null,
      note: data.note ?? null,
      byUserId: ctx.userId,
    });
    await audit(tx, ctx, "maintenance.updated", "maintenance_request", requestId, {
      reference: row.reference,
      status: data.status,
    });
  });
}
