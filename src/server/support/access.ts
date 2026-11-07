import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { auditEvents, supportGrants, supportViews, users } from "../db/schema";
import { assertPlatformAdmin } from "../platform/service";
import type { TenantContext } from "../tenancy/service";
import { readLiveGrant, type LiveGrant } from "./grants";

/**
 * Support access (PLT-02, D-08; founder decisions of 2026-11-06): the Proprietor lets EduBridge support
 * into the school for a chosen time, and can end it at any moment. While it lasts, platform staff open
 * the school with the Proprietor's permissions (they can make changes) except managing support access and
 * bulk exports. Every page support opens and every form it sends is recorded (`support_views`), every
 * change is in the audit log tagged with the grant, and the Proprietor sees both.
 */

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

/** How long the Proprietor can allow support in for, in hours (at most 7 days, also checked in SQL). */
export const SUPPORT_DURATIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

/** For the Proprietor's reminder on every page while support can come in. */
export async function getLiveSupportGrant(database: Database, ctx: TenantContext): Promise<LiveGrant | null> {
  if (!allowed(ctx, "support.manage")) return null;
  return withTenant(database, scope(ctx), (tx) => readLiveGrant(tx, ctx.tenant.id));
}

const grantSchema = z.object({
  hours: z.coerce
    .number()
    .refine((h) => SUPPORT_DURATIONS.some((d) => d.hours === h), "Choose how long support can stay."),
  note: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300, "Use 300 characters or fewer.").nullable(),
  ),
});

async function endLive(tx: Transaction, ctx: TenantContext): Promise<string | null> {
  const live = await readLiveGrant(tx, ctx.tenant.id);
  if (!live) return null;
  await tx
    .update(supportGrants)
    .set({ endedAt: sql`now()`, endedByUserId: ctx.userId })
    .where(and(eq(supportGrants.tenantId, ctx.tenant.id), eq(supportGrants.id, live.id)));
  return live.id;
}

/** Lets support in for the chosen time, replacing any live grant. Proprietor only. */
export async function grantSupportAccess(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<LiveGrant> {
  assertAllowed(ctx, "support.manage");
  const data = grantSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"support:" + ctx.tenant.id}, 0))`);
    const replaced = await endLive(tx, ctx);
    const [row] = await tx
      .insert(supportGrants)
      .values({
        tenantId: ctx.tenant.id,
        grantedByUserId: ctx.userId,
        note: data.note,
        expiresAt: sql`now() + make_interval(hours => ${data.hours})`,
      })
      .returning({ id: supportGrants.id, expiresAt: supportGrants.expiresAt });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "support.granted",
      entityType: "support_grant",
      entityId: row!.id,
      metadata: { hours: data.hours, expiresAt: row!.expiresAt.toISOString(), replaced },
    });
    return row!;
  });
}

/** Ends support access now. Proprietor only; does nothing when none is live. */
export async function endSupportAccess(database: Database, ctx: TenantContext): Promise<boolean> {
  assertAllowed(ctx, "support.manage");
  return withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"support:" + ctx.tenant.id}, 0))`);
    const ended = await endLive(tx, ctx);
    if (ended)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "support.ended",
        entityType: "support_grant",
        entityId: ended,
      });
    return ended !== null;
  });
}

const PATH = /^\/[\w\-./%[\]]*$/;

/** Records a page support opened or a form it sent. Called for every request in a support context. */
export async function recordSupportView(
  database: Database,
  ctx: TenantContext,
  path: string,
  kind: "view" | "action",
): Promise<void> {
  if (!ctx.support) return;
  const grantId = ctx.support.grantId;
  await withTenant(database, scope(ctx), (tx) =>
    tx.insert(supportViews).values({
      tenantId: ctx.tenant.id,
      grantId,
      userId: ctx.userId,
      // The path comes from the proxy; anything unexpected is recorded as the school's home.
      path: PATH.test(path) ? path.slice(0, 300) : `/s/${ctx.tenant.slug}`,
      kind,
    }),
  );
}

export interface SupportGrantRow {
  id: string;
  grantedBy: string;
  note: string | null;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedBy: string | null;
  live: boolean;
  pagesViewed: number;
  changes: number;
}

export interface SupportActivity {
  at: Date;
  by: string;
  /** A page path for views and sent forms; the audit action for changes. */
  what: string;
  kind: "view" | "action" | "change";
}

export interface SupportOverview {
  live: SupportGrantRow | null;
  grants: SupportGrantRow[];
  /** What support did during the most recent grant, newest first (at most 200 entries). */
  activity: SupportActivity[];
}

/** For Settings, Support access: the live grant, past grants, and what support did. Proprietor only. */
export async function getSupportAccess(database: Database, ctx: TenantContext): Promise<SupportOverview> {
  assertAllowed(ctx, "support.manage");
  return withTenant(database, scope(ctx), async (tx) => {
    const ender = sql<
      string | null
    >`(select name from ${users} u where u.id = ${supportGrants.endedByUserId})`;
    const rows = await tx
      .select({
        id: supportGrants.id,
        grantedBy: users.name,
        note: supportGrants.note,
        createdAt: supportGrants.createdAt,
        expiresAt: supportGrants.expiresAt,
        endedAt: supportGrants.endedAt,
        endedBy: ender,
        live: sql<boolean>`${supportGrants.endedAt} is null and ${supportGrants.expiresAt} > now()`,
        pagesViewed: sql<number>`(select count(*)::int from ${supportViews} v where v.grant_id = ${supportGrants.id})`,
        changes: sql<number>`(select count(*)::int from ${auditEvents} a where a.support_grant_id = ${supportGrants.id})`,
      })
      .from(supportGrants)
      .innerJoin(users, eq(users.id, supportGrants.grantedByUserId))
      .where(eq(supportGrants.tenantId, ctx.tenant.id))
      .orderBy(desc(supportGrants.createdAt))
      .limit(20);
    const latest = rows[0];
    let activity: SupportActivity[] = [];
    if (latest) {
      const views = await tx
        .select({ at: supportViews.at, by: users.name, what: supportViews.path, kind: supportViews.kind })
        .from(supportViews)
        .innerJoin(users, eq(users.id, supportViews.userId))
        .where(and(eq(supportViews.tenantId, ctx.tenant.id), eq(supportViews.grantId, latest.id)))
        .orderBy(desc(supportViews.at))
        .limit(200);
      const changes = await tx
        .select({ at: auditEvents.occurredAt, by: users.name, what: auditEvents.action })
        .from(auditEvents)
        .innerJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(and(eq(auditEvents.tenantId, ctx.tenant.id), eq(auditEvents.supportGrantId, latest.id)))
        .orderBy(desc(auditEvents.occurredAt))
        .limit(200);
      activity = [...views, ...changes.map((c) => ({ ...c, kind: "change" as const }))]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 200);
    }
    return { live: rows.find((r) => r.live) ?? null, grants: rows, activity };
  });
}

/** For EduBridge staff on the school's admin page: whether support can open the school now. */
export async function getSupportStatusForPlatform(
  database: Database,
  actorUserId: string,
  tenantId: string,
): Promise<(LiveGrant & { note: string | null; grantedBy: string }) | null> {
  await assertPlatformAdmin(database, actorUserId);
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const live = await readLiveGrant(tx, tenantId);
    if (!live) return null;
    const [row] = await tx
      .select({ note: supportGrants.note, grantedBy: users.name })
      .from(supportGrants)
      .innerJoin(users, eq(users.id, supportGrants.grantedByUserId))
      .where(and(eq(supportGrants.tenantId, tenantId), eq(supportGrants.id, live.id)));
    return { ...live, note: row?.note ?? null, grantedBy: row?.grantedBy ?? "" };
  });
}
