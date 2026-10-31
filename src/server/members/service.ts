import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan, type Role } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { auditEvents, campuses, invitations, membershipCampuses, memberships, users } from "../db/schema";
import { DomainError } from "../errors";
import { issueInvitation, type IssuedInvitation } from "../invitations/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Member management. Rules:
 * - Requires `members.manage` and access to every campus.
 * - Only owners can grant or remove the owner role, or change and suspend owners.
 * - A school always keeps at least one active owner; nobody can suspend themselves.
 * - Staff roles only: parent and student access will come from guardian and student records (R1).
 */
export const ASSIGNABLE_ROLES = ["owner", "admin", "bursar", "teacher"] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

const rolesSchema = z
  .array(z.enum(ASSIGNABLE_ROLES, { message: "Choose a valid role." }))
  .min(1, "Choose at least one role.")
  .transform((roles) => [...new Set(roles)].sort());

const campusScopeSchema = z
  .array(z.string().uuid("Choose a valid campus."))
  .nullable()
  .transform((ids) => (ids && ids.length > 0 ? [...new Set(ids)] : null));

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  roles: rolesSchema,
  campusIds: campusScopeSchema,
});

export const updateMemberSchema = z.object({ roles: rolesSchema, campusIds: campusScopeSchema });

function assertManager(ctx: TenantContext): void {
  assertCan(ctx.roles, "members.manage");
  if (ctx.campusIds !== null) {
    throw new DomainError("campus_scope", "Only members with access to every campus can manage members.");
  }
}

function assertCanGrant(ctx: TenantContext, roles: readonly string[]): void {
  if (roles.includes("owner") && !ctx.roles.includes("owner")) {
    throw new DomainError("owner_required", "Only an owner can grant the owner role.", "roles");
  }
}

async function assertCampusesBelong(
  tx: Transaction,
  tenantId: string,
  campusIds: string[] | null,
): Promise<void> {
  if (!campusIds) return;
  const rows = await tx
    .select({ id: campuses.id })
    .from(campuses)
    .where(
      and(eq(campuses.tenantId, tenantId), inArray(campuses.id, campusIds), eq(campuses.status, "active")),
    );
  if (rows.length !== campusIds.length) {
    throw new DomainError("campus_invalid", "Choose active campuses of this school.", "campusIds");
  }
}

/** Serialises changes that could remove the last owner. */
async function lockOwners(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"owners:" + tenantId}, 0))`);
}

async function otherActiveOwners(
  tx: Transaction,
  tenantId: string,
  excludeMembershipId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        sql`'owner' = any(${memberships.roles})`,
        sql`${memberships.id} <> ${excludeMembershipId}`,
      ),
    );
  return row?.n ?? 0;
}

export async function inviteMember(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<IssuedInvitation> {
  assertManager(ctx);
  const data = inviteMemberSchema.parse(input);
  assertCanGrant(ctx, data.roles);
  return withTenant(database, scope(ctx), async (tx) => {
    await assertCampusesBelong(tx, ctx.tenant.id, data.campusIds);
    const [member] = await tx
      .select({ status: memberships.status })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(users.email, data.email)));
    if (member?.status === "active") {
      throw new DomainError(
        "already_member",
        "This person is already a member. Edit their roles instead.",
        "email",
      );
    }
    return issueInvitation(tx, {
      tenantId: ctx.tenant.id,
      email: data.email,
      roles: data.roles,
      campusIds: data.campusIds,
      invitedByUserId: ctx.userId,
    });
  });
}

export interface PendingInvitation {
  id: string;
  email: string;
  roles: string[];
  campusIds: string[] | null;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: string | null;
}

export async function listPendingInvitations(
  database: Database,
  ctx: TenantContext,
): Promise<PendingInvitation[]> {
  assertCan(ctx.roles, "members.view");
  return withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        roles: invitations.roles,
        campusIds: invitations.campusIds,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
        invitedBy: users.name,
      })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(
        and(
          eq(invitations.tenantId, ctx.tenant.id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          sql`${invitations.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(invitations.createdAt)),
  );
}

async function loadPendingInvitation(tx: Transaction, ctx: TenantContext, invitationId: string) {
  if (!z.string().uuid().safeParse(invitationId).success) {
    throw new DomainError("invitation_not_found", "Invitation not found.");
  }
  const [row] = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tenantId, ctx.tenant.id),
        eq(invitations.id, invitationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .for("update");
  if (!row) throw new DomainError("invitation_not_found", "This invitation is no longer pending.");
  return row;
}

export async function revokeInvitation(
  database: Database,
  ctx: TenantContext,
  invitationId: string,
): Promise<void> {
  assertManager(ctx);
  await withTenant(database, scope(ctx), async (tx) => {
    const invitation = await loadPendingInvitation(tx, ctx, invitationId);
    assertCanGrant(ctx, invitation.roles);
    await tx.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, invitation.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: { email: invitation.email },
    });
  });
}

/** A fresh link for a pending invitation, with the same roles and campus scope. The old link stops working. */
export async function reissueInvitation(
  database: Database,
  ctx: TenantContext,
  invitationId: string,
): Promise<IssuedInvitation & { email: string }> {
  assertManager(ctx);
  return withTenant(database, scope(ctx), async (tx) => {
    const invitation = await loadPendingInvitation(tx, ctx, invitationId);
    assertCanGrant(ctx, invitation.roles);
    const issued = await issueInvitation(tx, {
      tenantId: ctx.tenant.id,
      email: invitation.email,
      roles: invitation.roles as Role[],
      campusIds: invitation.campusIds,
      invitedByUserId: ctx.userId,
    });
    return { ...issued, email: invitation.email };
  });
}

async function loadMembership(tx: Transaction, ctx: TenantContext, membershipId: string) {
  if (!z.string().uuid().safeParse(membershipId).success)
    throw new DomainError("member_not_found", "Member not found.");
  const [row] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, membershipId)))
    .for("update");
  if (!row) throw new DomainError("member_not_found", "Member not found.");
  return row;
}

export async function updateMember(
  database: Database,
  ctx: TenantContext,
  membershipId: string,
  input: unknown,
): Promise<void> {
  assertManager(ctx);
  const data = updateMemberSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    await lockOwners(tx, ctx.tenant.id);
    const member = await loadMembership(tx, ctx, membershipId);
    const wasOwner = member.roles.includes("owner");
    const isOwner = data.roles.includes("owner");
    if ((wasOwner || isOwner) && !ctx.roles.includes("owner")) {
      throw new DomainError(
        "owner_required",
        "Only an owner can change an owner's access or grant the owner role.",
      );
    }
    if (
      wasOwner &&
      !isOwner &&
      member.status === "active" &&
      (await otherActiveOwners(tx, ctx.tenant.id, member.id)) === 0
    ) {
      throw new DomainError(
        "last_owner",
        "A school needs at least one owner. Make someone else an owner first.",
        "roles",
      );
    }
    // Legacy parent/student roles are kept until guardian and student records replace them.
    const kept = member.roles.filter((r) => !(ASSIGNABLE_ROLES as readonly string[]).includes(r));
    const roles = [...new Set([...data.roles, ...kept])].sort();
    await assertCampusesBelong(tx, ctx.tenant.id, data.campusIds);

    const before = await tx
      .select({ campusId: membershipCampuses.campusId })
      .from(membershipCampuses)
      .where(
        and(eq(membershipCampuses.tenantId, ctx.tenant.id), eq(membershipCampuses.membershipId, member.id)),
      );
    await tx.update(memberships).set({ roles, updatedAt: new Date() }).where(eq(memberships.id, member.id));
    await tx
      .delete(membershipCampuses)
      .where(
        and(eq(membershipCampuses.tenantId, ctx.tenant.id), eq(membershipCampuses.membershipId, member.id)),
      );
    if (data.campusIds) {
      await tx
        .insert(membershipCampuses)
        .values(
          data.campusIds.map((campusId) => ({ tenantId: ctx.tenant.id, membershipId: member.id, campusId })),
        );
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "member.updated",
      entityType: "membership",
      entityId: member.id,
      metadata: {
        roles: { from: member.roles, to: roles },
        campusIds: { from: before.length ? before.map((b) => b.campusId) : null, to: data.campusIds },
      },
    });
  });
}

export async function setMemberStatus(
  database: Database,
  ctx: TenantContext,
  membershipId: string,
  status: "active" | "suspended",
): Promise<void> {
  assertManager(ctx);
  await withTenant(database, scope(ctx), async (tx) => {
    await lockOwners(tx, ctx.tenant.id);
    const member = await loadMembership(tx, ctx, membershipId);
    if (member.status === status) return;
    if (member.userId === ctx.userId) {
      throw new DomainError("self", "You cannot suspend your own access.");
    }
    if (member.roles.includes("owner")) {
      if (!ctx.roles.includes("owner"))
        throw new DomainError("owner_required", "Only an owner can change an owner's access.");
      if (status === "suspended" && (await otherActiveOwners(tx, ctx.tenant.id, member.id)) === 0) {
        throw new DomainError("last_owner", "A school needs at least one active owner.");
      }
    }
    // Access is re-checked on every request, so a suspended member is locked out on their next request.
    await tx.update(memberships).set({ status, updatedAt: new Date() }).where(eq(memberships.id, member.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: status === "suspended" ? "member.suspended" : "member.reactivated",
      entityType: "membership",
      entityId: member.id,
    });
  });
}

export interface AuditEntry {
  id: string;
  occurredAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
}

export const AUDIT_PAGE_SIZE = 50;

/** Newest first; pass the last entry's cursor to get older entries. */
export async function listAuditEvents(
  database: Database,
  ctx: TenantContext,
  cursor?: string,
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  assertCan(ctx.roles, "audit.view");
  const [at, id] = (cursor ?? "").split("_");
  const validCursor = at && id && !Number.isNaN(Date.parse(at)) && z.string().uuid().safeParse(id).success;
  const rows = await withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.occurredAt,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorName: users.name,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(
        and(
          eq(auditEvents.tenantId, ctx.tenant.id),
          // Compare at millisecond precision: JavaScript dates cannot carry PostgreSQL's microseconds.
          validCursor
            ? sql`(date_trunc('milliseconds', ${auditEvents.occurredAt}), ${auditEvents.id}) < (${at}::timestamptz, ${id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(sql`date_trunc('milliseconds', ${auditEvents.occurredAt}) desc`, desc(auditEvents.id))
      .limit(AUDIT_PAGE_SIZE + 1),
  );
  const entries = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor: rows.length > AUDIT_PAGE_SIZE && last ? `${last.occurredAt.toISOString()}_${last.id}` : null,
  };
}
