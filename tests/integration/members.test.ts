import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, campuses } from "@/server/db/schema";
import { acceptInvitation, findInvitation } from "@/server/invitations/service";
import {
  AUDIT_PAGE_SIZE,
  inviteMember,
  listAuditEvents,
  listPendingInvitations,
  reissueInvitation,
  revokeInvitation,
  setMemberStatus,
  updateMember,
} from "@/server/members/service";
import { listMembers, resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

const email = () => `member-${Math.random().toString(36).slice(2, 10)}@example.test`;

async function setup() {
  const school = await createTenant(conn.owner, "Members Test School");
  const owner = await createUser(conn.owner, "Owner One");
  const admin = await createUser(conn.owner, "Admin One");
  const teacher = await createUser(conn.owner, "Teacher One");
  const ownerM = await addMember(conn.owner, school.id, owner.id, ["owner"]);
  const adminM = await addMember(conn.owner, school.id, admin.id, ["admin"]);
  const teacherM = await addMember(conn.owner, school.id, teacher.id, ["teacher"]);
  const [main, east] = await withTenant(conn.owner, { tenantId: school.id, userId: owner.id }, (tx) =>
    tx
      .insert(campuses)
      .values([
        { tenantId: school.id, name: "Main" },
        { tenantId: school.id, name: "East" },
      ])
      .returning(),
  );
  const ctx = async (userId: string) =>
    (await resolveTenantContext(conn.app, school.slug, userId)) as TenantContext;
  return {
    school,
    users: { owner, admin, teacher },
    memberships: { ownerM, adminM, teacherM },
    campuses: { main: main!, east: east! },
    ctx: { owner: await ctx(owner.id), admin: await ctx(admin.id), teacher: await ctx(teacher.id) },
    refresh: ctx,
  };
}

let s: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  s = await setup();
});

describe("inviting members", () => {
  it("invites with roles and campus scope that apply on acceptance", async () => {
    const address = email();
    const { token } = await inviteMember(conn.app, s.ctx.admin, {
      email: address,
      roles: ["teacher", "bursar"],
      campusIds: [s.campuses.east.id],
    });
    expect((await listPendingInvitations(conn.app, s.ctx.admin)).map((i) => i.email)).toContain(address);
    const { userId } = await acceptInvitation(conn.app, token, {
      kind: "new-account",
      name: "Scoped Teacher",
      password: "a-strong-password",
    });
    const ctx = await s.refresh(userId);
    expect(ctx.roles).toEqual(["bursar", "teacher"]);
    expect(ctx.campusIds).toEqual([s.campuses.east.id]);
    const member = (await listMembers(conn.app, s.ctx.admin)).find((m) => m.userId === userId);
    expect(member?.campusIds).toEqual([s.campuses.east.id]);
  });

  it("only owners can invite owners; teachers cannot invite at all", async () => {
    await expect(
      inviteMember(conn.app, s.ctx.admin, { email: email(), roles: ["owner"], campusIds: null }),
    ).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(
      inviteMember(conn.app, s.ctx.owner, { email: email(), roles: ["owner"], campusIds: null }),
    ).resolves.toBeDefined();
    await expect(
      inviteMember(conn.app, s.ctx.teacher, { email: email(), roles: ["teacher"], campusIds: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects parent/student roles, existing members, and foreign or invalid campuses", async () => {
    await expect(
      inviteMember(conn.app, s.ctx.admin, { email: email(), roles: ["parent"], campusIds: null }),
    ).rejects.toThrow();
    await expect(
      inviteMember(conn.app, s.ctx.admin, {
        email: s.users.teacher.email,
        roles: ["teacher"],
        campusIds: null,
      }),
    ).rejects.toMatchObject({ code: "already_member", field: "email" });
    const other = await createTenant(conn.owner);
    const [foreign] = await withTenant(conn.owner, { tenantId: other.id, userId: s.users.owner.id }, (tx) =>
      tx.insert(campuses).values({ tenantId: other.id, name: "Elsewhere" }).returning(),
    );
    await expect(
      inviteMember(conn.app, s.ctx.admin, { email: email(), roles: ["teacher"], campusIds: [foreign!.id] }),
    ).rejects.toMatchObject({ code: "campus_invalid" });
  });

  it("revokes and reissues pending invitations", async () => {
    const first = await inviteMember(conn.app, s.ctx.admin, {
      email: email(),
      roles: ["teacher"],
      campusIds: null,
    });
    const reissued = await reissueInvitation(conn.app, s.ctx.admin, first.id);
    expect(await findInvitation(conn.app, first.token)).toBeNull();
    expect(await findInvitation(conn.app, reissued.token)).not.toBeNull();
    await revokeInvitation(conn.app, s.ctx.admin, reissued.id);
    expect(await findInvitation(conn.app, reissued.token)).toBeNull();
    await expect(revokeInvitation(conn.app, s.ctx.admin, reissued.id)).rejects.toMatchObject({
      code: "invitation_not_found",
    });
  });
});

describe("head teachers", () => {
  it("can be invited by admins, see members, and not manage them", async () => {
    const t = await setup();
    const { token } = await inviteMember(conn.app, t.ctx.admin, {
      email: email(),
      roles: ["headteacher"],
      campusIds: null,
    });
    const { userId } = await acceptInvitation(conn.app, token, {
      kind: "new-account",
      name: "Head Teacher",
      password: "a-strong-password",
    });
    const head = await t.refresh(userId);
    expect(head.roles).toEqual(["headteacher"]);
    expect((await listMembers(conn.app, head)).length).toBeGreaterThan(0);
    await expect(
      inviteMember(conn.app, head, { email: email(), roles: ["teacher"], campusIds: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("changing members", () => {
  it("updates roles and campus scope", async () => {
    await updateMember(conn.app, s.ctx.admin, s.memberships.teacherM.id, {
      roles: ["teacher", "bursar"],
      campusIds: [s.campuses.main.id],
    });
    let ctx = await s.refresh(s.users.teacher.id);
    expect(ctx.roles).toEqual(["bursar", "teacher"]);
    expect(ctx.campusIds).toEqual([s.campuses.main.id]);
    await updateMember(conn.app, s.ctx.admin, s.memberships.teacherM.id, {
      roles: ["teacher"],
      campusIds: null,
    });
    ctx = await s.refresh(s.users.teacher.id);
    expect(ctx.campusIds).toBeNull();
  });

  it("protects owners: admins cannot change them, and the last owner cannot be removed", async () => {
    await expect(
      updateMember(conn.app, s.ctx.admin, s.memberships.ownerM.id, { roles: ["admin"], campusIds: null }),
    ).rejects.toMatchObject({ code: "owner_required" });
    await expect(
      updateMember(conn.app, s.ctx.owner, s.memberships.ownerM.id, { roles: ["admin"], campusIds: null }),
    ).rejects.toMatchObject({ code: "last_owner" });
    await expect(
      setMemberStatus(conn.app, s.ctx.admin, s.memberships.ownerM.id, "suspended"),
    ).rejects.toMatchObject({
      code: "owner_required",
    });
  });

  it("allows handing over ownership", async () => {
    const t = await setup();
    await updateMember(conn.app, t.ctx.owner, t.memberships.adminM.id, { roles: ["owner"], campusIds: null });
    await updateMember(conn.app, t.ctx.owner, t.memberships.ownerM.id, { roles: ["admin"], campusIds: null });
    expect((await t.refresh(t.users.owner.id)).roles).toEqual(["admin"]);
    expect((await t.refresh(t.users.admin.id)).roles).toEqual(["owner"]);
  });

  it("suspends and reactivates; suspended members lose access on their next request", async () => {
    await setMemberStatus(conn.app, s.ctx.admin, s.memberships.teacherM.id, "suspended");
    expect(await resolveTenantContext(conn.app, s.school.slug, s.users.teacher.id)).toBeNull();
    await setMemberStatus(conn.app, s.ctx.admin, s.memberships.teacherM.id, "active");
    expect(await resolveTenantContext(conn.app, s.school.slug, s.users.teacher.id)).not.toBeNull();
    await expect(
      setMemberStatus(conn.app, s.ctx.admin, s.memberships.adminM.id, "suspended"),
    ).rejects.toMatchObject({ code: "self" });
  });

  it("cannot change members of another school", async () => {
    const other = await setup();
    await expect(
      updateMember(conn.app, s.ctx.admin, other.memberships.teacherM.id, {
        roles: ["admin"],
        campusIds: null,
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("campus-scoped admins cannot manage members", async () => {
    const t = await setup();
    await updateMember(conn.app, t.ctx.owner, t.memberships.adminM.id, {
      roles: ["admin"],
      campusIds: [t.campuses.main.id],
    });
    const scoped = await t.refresh(t.users.admin.id);
    await expect(
      inviteMember(conn.app, scoped, { email: email(), roles: ["teacher"], campusIds: null }),
    ).rejects.toMatchObject({
      code: "campus_scope",
    });
  });
});

describe("audit log", () => {
  it("records member changes and pages through entries without gaps or repeats", async () => {
    const t = await setup();
    await withTenant(conn.owner, { tenantId: t.school.id, userId: t.users.owner.id }, (tx) =>
      tx.insert(auditEvents).values(
        Array.from({ length: AUDIT_PAGE_SIZE + 5 }, (_, i) => ({
          tenantId: t.school.id,
          action: `test.${i}`,
          entityType: "test",
        })),
      ),
    );
    await updateMember(conn.app, t.ctx.owner, t.memberships.teacherM.id, {
      roles: ["bursar"],
      campusIds: null,
    });

    const first = await listAuditEvents(conn.app, t.ctx.owner);
    expect(first.entries[0]).toMatchObject({ action: "member.updated", actorName: "Owner One" });
    expect(first.entries).toHaveLength(AUDIT_PAGE_SIZE);
    const second = await listAuditEvents(conn.app, t.ctx.owner, first.nextCursor!);
    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(AUDIT_PAGE_SIZE + 6);
    expect(second.nextCursor).toBeNull();
    await expect(listAuditEvents(conn.app, t.ctx.teacher)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
