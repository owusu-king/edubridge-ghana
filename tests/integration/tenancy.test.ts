import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, memberships } from "@/server/db/schema";
import {
  countMembersByRole,
  listMembers,
  listUserSchools,
  resolveTenantContext,
  updateSchoolProfile,
} from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

let school: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let teacher: Awaited<ReturnType<typeof createUser>>;
let suspended: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  school = await createTenant(conn.owner, "Synthetic Hills School");
  other = await createTenant(conn.owner, "Another School");
  admin = await createUser(conn.owner, "Ama Admin");
  teacher = await createUser(conn.owner, "Kofi Teacher");
  suspended = await createUser(conn.owner, "Former Staff");
  await addMember(conn.owner, school.id, admin.id, ["admin"]);
  await addMember(conn.owner, school.id, teacher.id, ["teacher", "parent"]);
  await addMember(conn.owner, other.id, admin.id, ["owner"]);
  const m = await addMember(conn.owner, school.id, suspended.id, ["teacher"]);
  await conn.owner.transaction(async (tx) => {
    await tx.execute(`select set_config('app.tenant_id', '${school.id}', true)`);
    await tx.update(memberships).set({ status: "suspended" }).where(eq(memberships.id, m.id));
  });
});

describe("tenant context", () => {
  it("resolves an active member's roles", async () => {
    const ctx = await resolveTenantContext(conn.app, school.slug, teacher.id);
    expect(ctx?.tenant.id).toBe(school.id);
    expect(ctx?.roles).toEqual(["teacher", "parent"]);
  });

  it("returns null for non-members, suspended members and unknown schools alike", async () => {
    expect(await resolveTenantContext(conn.app, other.slug, teacher.id)).toBeNull();
    expect(await resolveTenantContext(conn.app, school.slug, suspended.id)).toBeNull();
    expect(await resolveTenantContext(conn.app, "no-such-school", admin.id)).toBeNull();
  });

  it("lists the schools a user belongs to", async () => {
    const schools = await listUserSchools(conn.app, admin.id);
    expect(schools.map((s) => s.slug).sort()).toEqual([school.slug, other.slug].sort());
  });
});

describe("members", () => {
  it("lists only this school's members, even for users who belong to several schools", async () => {
    const ctx = (await resolveTenantContext(conn.app, school.slug, admin.id))!;
    const members = await listMembers(conn.app, ctx);
    expect(members.map((m) => m.name)).toEqual(["Ama Admin", "Former Staff", "Kofi Teacher"]);
    expect(members.find((m) => m.userId === admin.id)?.roles).toEqual(["admin"]);
  });

  it("counts active members by role", async () => {
    const ctx = (await resolveTenantContext(conn.app, school.slug, admin.id))!;
    const counts = await countMembersByRole(conn.app, ctx);
    expect(counts).toMatchObject({ admin: 1, teacher: 1, parent: 1, owner: 0 });
  });

  it("forbids members without permission", async () => {
    const ctx = (await resolveTenantContext(conn.app, school.slug, teacher.id))!;
    await expect(listMembers(conn.app, ctx)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("school profile", () => {
  it("updates the profile and records an audit event in the same transaction", async () => {
    const ctx = (await resolveTenantContext(conn.app, school.slug, admin.id))!;
    const updated = await updateSchoolProfile(conn.app, ctx, {
      name: "Synthetic Hills Academy",
      timezone: "UTC",
    });
    expect(updated.name).toBe("Synthetic Hills Academy");

    // FORCE RLS applies to the owner role too, so a tenant context is needed to read.
    const events = await withTenant(conn.owner, { tenantId: school.id, userId: admin.id }, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, school.id)),
    );
    const event = events.find((e) => e.action === "school.profile.updated");
    expect(event?.actorUserId).toBe(admin.id);
    expect(event?.metadata).toEqual({
      changes: {
        name: { from: "Synthetic Hills School", to: "Synthetic Hills Academy" },
        timezone: { from: "Africa/Accra", to: "UTC" },
      },
    });
  });

  it("rejects invalid input and unauthorised roles", async () => {
    const adminCtx = (await resolveTenantContext(conn.app, school.slug, admin.id))!;
    await expect(
      updateSchoolProfile(conn.app, adminCtx, { name: "", timezone: "Africa/Accra" }),
    ).rejects.toThrow();
    const teacherCtx = (await resolveTenantContext(conn.app, school.slug, teacher.id))!;
    await expect(
      updateSchoolProfile(conn.app, teacherCtx, { name: "Teacher's School", timezone: "Africa/Accra" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
