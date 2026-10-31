import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { notificationOutbox } from "@/server/db/schema";
import { withTenant } from "@/server/db/context";
import { issueInvitation } from "@/server/invitations/service";
import { resolveTenantContext, updateMfaPolicy } from "@/server/tenancy/service";
import { eq } from "drizzle-orm";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

describe("two-step verification policy", () => {
  it("defaults to owners and bursars, and owners can change it", async () => {
    const school = await createTenant(conn.owner);
    const owner = await createUser(conn.owner);
    const teacher = await createUser(conn.owner);
    const admin = await createUser(conn.owner);
    await addMember(conn.owner, school.id, owner.id, ["owner"]);
    await addMember(conn.owner, school.id, teacher.id, ["teacher"]);
    await addMember(conn.owner, school.id, admin.id, ["admin"]);

    const ownerCtx = (await resolveTenantContext(conn.app, school.slug, owner.id))!;
    expect(ownerCtx.tenant.mfaRequiredRoles).toEqual(["owner", "bursar"]);
    expect(ownerCtx.mfaRequired).toBe(true);
    expect((await resolveTenantContext(conn.app, school.slug, teacher.id))!.mfaRequired).toBe(false);

    await updateMfaPolicy(conn.app, ownerCtx, { roles: ["teacher"] });
    expect((await resolveTenantContext(conn.app, school.slug, teacher.id))!.mfaRequired).toBe(true);
    expect((await resolveTenantContext(conn.app, school.slug, owner.id))!.mfaRequired).toBe(false);

    await updateMfaPolicy(conn.app, ownerCtx, { roles: [] });
    expect((await resolveTenantContext(conn.app, school.slug, teacher.id))!.mfaRequired).toBe(false);

    const adminCtx = (await resolveTenantContext(conn.app, school.slug, admin.id))!;
    await expect(updateMfaPolicy(conn.app, adminCtx, { roles: [] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateMfaPolicy(conn.app, ownerCtx, { roles: ["parent"] })).rejects.toThrow();
  });
});

describe("invitation emails", () => {
  it("queues the invitation email in the same transaction", async () => {
    const school = await createTenant(conn.owner, "Email Test School");
    const inviter = await createUser(conn.owner);
    const email = `invited-${Math.random().toString(36).slice(2)}@example.test`;
    await withTenant(conn.app, { tenantId: school.id, userId: inviter.id }, (tx) =>
      issueInvitation(tx, { tenantId: school.id, email, roles: ["teacher"], invitedByUserId: inviter.id }),
    );
    const [queued] = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipient, email));
    expect(queued).toMatchObject({
      template: "invitation",
      status: "pending",
      payload: { schoolName: "Email Test School", roles: ["Teacher"] },
    });
  });
});
