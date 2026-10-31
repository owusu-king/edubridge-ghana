import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from "../auth/password";
import { createSession, type ClientInfo } from "../auth/sessions";
import { generateToken, hashToken } from "../auth/tokens";
import { isRole, ROLE_LABELS, type Role } from "../authz/permissions";
import { enqueue } from "../notifications/outbox";
import type { Database, Transaction } from "../db/client";
import { setTenantContext } from "../db/context";
import { invitations, membershipCampuses, memberships, tenants, users } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssuedInvitation {
  id: string;
  /** The secret. Shown once to the person who issued it; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues an invitation inside the caller's tenant-scoped transaction. Any earlier pending invitation for
 * the same email in this school is revoked, so only the newest link works.
 */
export async function issueInvitation(
  tx: Transaction,
  input: {
    tenantId: string;
    email: string;
    roles: Role[];
    invitedByUserId: string;
    campusIds?: string[] | null;
  },
  now = new Date(),
): Promise<IssuedInvitation> {
  await tx
    .update(invitations)
    .set({ revokedAt: now })
    .where(
      and(
        eq(invitations.tenantId, input.tenantId),
        eq(invitations.email, input.email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    );
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
  const [row] = await tx
    .insert(invitations)
    .values({
      tenantId: input.tenantId,
      email: input.email,
      roles: input.roles,
      campusIds: input.campusIds && input.campusIds.length > 0 ? input.campusIds : null,
      tokenHash: hashToken(token),
      expiresAt,
      invitedByUserId: input.invitedByUserId,
    })
    .returning({ id: invitations.id });
  const [school] = await tx
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId));
  await enqueue(tx, {
    channel: "email",
    recipient: input.email,
    template: "invitation",
    payload: {
      schoolName: school?.name ?? "your school",
      roles: input.roles.map((r) => ROLE_LABELS[r]),
      token,
      expiresAt: expiresAt.toISOString(),
    },
  });
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorUserId: input.invitedByUserId,
    action: "invitation.issued",
    entityType: "invitation",
    entityId: row!.id,
    metadata: { email: input.email, roles: input.roles, campusIds: input.campusIds ?? null },
  });
  return { id: row!.id, token, expiresAt };
}

export interface InvitationDetails {
  id: string;
  tenantId: string;
  schoolSlug: string;
  schoolName: string;
  email: string;
  roles: Role[];
  campusIds: string[] | null;
  /** Whether an account with this email already exists (it must sign in to accept). */
  accountExists: boolean;
}

async function withInvitationToken<T>(
  database: Database,
  token: string,
  fn: (tx: Transaction) => Promise<T>,
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.invitation_token_hash', ${hashToken(token)}, true)`);
    return fn(tx);
  });
}

/** Looks up a usable invitation by its secret token, or null if it is unknown, used, revoked or expired. */
export async function findInvitation(
  database: Database,
  token: string,
  now = new Date(),
): Promise<InvitationDetails | null> {
  if (!token || token.length > 128) return null;
  return withInvitationToken(database, token, async (tx) => {
    const [row] = await tx
      .select({
        id: invitations.id,
        tenantId: invitations.tenantId,
        schoolSlug: tenants.slug,
        schoolName: tenants.name,
        email: invitations.email,
        roles: invitations.roles,
        campusIds: invitations.campusIds,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        tenantStatus: tenants.status,
      })
      .from(invitations)
      .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(eq(invitations.tokenHash, hashToken(token)))
      .limit(1);
    if (!row || row.acceptedAt || row.revokedAt || row.expiresAt <= now || row.tenantStatus !== "active") {
      return null;
    }
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, row.email))
      .limit(1);
    return {
      id: row.id,
      tenantId: row.tenantId,
      schoolSlug: row.schoolSlug,
      schoolName: row.schoolName,
      email: row.email,
      roles: row.roles.filter(isRole),
      campusIds: row.campusIds,
      accountExists: Boolean(existing),
    };
  });
}

export const newAccountSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name.").max(120, "Use 120 characters or fewer."),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`),
});

export type AcceptAs =
  | { kind: "new-account"; name: string; password: string }
  | { kind: "signed-in"; userId: string; email: string };

export type AcceptResult = { userId: string; tenantId: string; session?: { token: string; expiresAt: Date } };

/**
 * Accepts an invitation: creates the account if needed, grants the membership and marks the invitation
 * used — all in one transaction. A concurrent second acceptance fails because the invitation can be
 * marked accepted only once.
 */
export async function acceptInvitation(
  database: Database,
  token: string,
  as: AcceptAs,
  client: ClientInfo = {},
  now = new Date(),
): Promise<AcceptResult> {
  const invitation = await findInvitation(database, token, now);
  if (!invitation)
    throw new DomainError("invitation_invalid", "This invitation link is invalid or has expired.");

  if (as.kind === "signed-in" && as.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new DomainError(
      "invitation_wrong_account",
      `This invitation is for ${invitation.email}. Sign out and sign in with that account.`,
    );
  }
  if (as.kind === "new-account" && invitation.accountExists) {
    throw new DomainError(
      "invitation_account_exists",
      "An account with this email already exists. Sign in to accept.",
    );
  }
  const newAccount = as.kind === "new-account" ? newAccountSchema.parse(as) : null;
  const passwordHash = newAccount ? await hashPassword(newAccount.password) : null;

  const userId = await database
    .transaction(async (tx) => {
      let userId: string;
      if (newAccount && passwordHash) {
        const [created] = await tx
          .insert(users)
          .values({ email: invitation.email, name: newAccount.name, passwordHash })
          .returning({ id: users.id });
        userId = created!.id;
      } else {
        userId = (as as { userId: string }).userId;
      }
      await setTenantContext(tx, { tenantId: invitation.tenantId, userId });

      const [claimed] = await tx
        .update(invitations)
        .set({ acceptedAt: now, acceptedUserId: userId })
        .where(
          and(
            eq(invitations.id, invitation.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (!claimed)
        throw new DomainError("invitation_invalid", "This invitation link is invalid or has expired.");

      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, invitation.tenantId), eq(memberships.userId, userId)));

      // Re-inviting a former member reactivates them and adds the invited roles; their campus scope is kept.
      const [membership] = await tx
        .insert(memberships)
        .values({ tenantId: invitation.tenantId, userId, roles: invitation.roles })
        .onConflictDoUpdate({
          target: [memberships.tenantId, memberships.userId],
          set: {
            roles: sql`(select array_agg(distinct r order by r) from unnest(${memberships.roles} || excluded.roles) as r)`,
            status: "active",
            updatedAt: now,
          },
        })
        .returning({ id: memberships.id });
      if (!existing && invitation.campusIds && invitation.campusIds.length > 0) {
        // Composite foreign keys guarantee every campus belongs to this school.
        await tx.insert(membershipCampuses).values(
          invitation.campusIds.map((campusId) => ({
            tenantId: invitation.tenantId,
            membershipId: membership!.id,
            campusId,
          })),
        );
      }
      await recordAudit(tx, {
        tenantId: invitation.tenantId,
        actorUserId: userId,
        action: "invitation.accepted",
        entityType: "invitation",
        entityId: invitation.id,
        metadata: { roles: invitation.roles, newAccount: Boolean(newAccount) },
        ipAddress: client.ipAddress ?? null,
      });
      return userId;
    })
    .catch((error: unknown) => {
      // Someone registered this email between the lookup and the insert.
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw new DomainError(
          "invitation_account_exists",
          "An account with this email already exists. Sign in to accept.",
        );
      }
      throw error;
    });

  const session = newAccount ? await createSession(database, userId, client, now) : undefined;
  return { userId, tenantId: invitation.tenantId, session };
}
