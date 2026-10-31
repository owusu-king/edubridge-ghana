import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import {
  createCampus,
  getPlanUsage,
  listCampuses,
  renameCampus,
  setCampusStatus,
} from "@/server/campuses/service";
import { withTenant } from "@/server/db/context";
import { campuses, membershipCampuses, tenantEntitlements } from "@/server/db/schema";
import { canAccessCampus, resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser, makePlatformAdmin } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

let platformAdminId: string;
beforeAll(async () => {
  const platformAdmin = await createUser(conn.owner, "Platform Admin");
  await makePlatformAdmin(conn.owner, platformAdmin.id);
  platformAdminId = platformAdmin.id;
});

async function schoolWithLimit(maxCampuses: number) {
  const school = await createTenant(conn.owner);
  const admin = await createUser(conn.owner, "Campus Admin");
  await addMember(conn.owner, school.id, admin.id, ["admin"]);
  // Plan limits can only be written by a platform administrator, even with the owner role.
  await withTenant(conn.owner, { tenantId: school.id, userId: platformAdminId }, async (tx) => {
    await tx.insert(tenantEntitlements).values({ tenantId: school.id, maxCampuses });
    await tx.insert(campuses).values({ tenantId: school.id, name: "Main campus" });
  });
  const ctx = (await resolveTenantContext(conn.app, school.slug, admin.id))!;
  return { school, admin, ctx };
}

describe("campuses", () => {
  it("creates campuses up to the plan limit", async () => {
    const { ctx } = await schoolWithLimit(2);
    await createCampus(conn.app, ctx, { name: "East Legon" });
    await expect(createCampus(conn.app, ctx, { name: "Tema" })).rejects.toMatchObject({
      code: "campus_limit_reached",
    });
    expect(await getPlanUsage(conn.app, ctx)).toMatchObject({ activeCampuses: 2, maxCampuses: 2 });
  });

  it("enforces the limit under concurrent requests", async () => {
    const { ctx } = await schoolWithLimit(2);
    const results = await Promise.allSettled([
      createCampus(conn.app, ctx, { name: "North" }),
      createCampus(conn.app, ctx, { name: "South" }),
      createCampus(conn.app, ctx, { name: "West" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listCampuses(conn.app, ctx)).filter((c) => c.status === "active")).toHaveLength(2);
  });

  it("archives and restores, keeping one active campus and respecting the limit", async () => {
    const { ctx } = await schoolWithLimit(2);
    const [main] = await listCampuses(conn.app, ctx);
    await expect(setCampusStatus(conn.app, ctx, main!.id, "archived")).rejects.toMatchObject({
      code: "last_campus",
    });

    const second = await createCampus(conn.app, ctx, { name: "Second" });
    await setCampusStatus(conn.app, ctx, main!.id, "archived");
    const third = await createCampus(conn.app, ctx, { name: "Third" });
    await expect(setCampusStatus(conn.app, ctx, main!.id, "active")).rejects.toMatchObject({
      code: "campus_limit_reached",
    });
    expect((await listCampuses(conn.app, ctx)).map((c) => [c.name, c.status])).toEqual([
      ["Second", "active"],
      ["Third", "active"],
      ["Main campus", "archived"],
    ]);
    expect(second.id).not.toBe(third.id);
  });

  it("renames with case-insensitive uniqueness", async () => {
    const { ctx } = await schoolWithLimit(3);
    const campus = await createCampus(conn.app, ctx, { name: "Airport" });
    await expect(renameCampus(conn.app, ctx, campus.id, { name: "MAIN CAMPUS" })).rejects.toMatchObject({
      code: "campus_name_taken",
      field: "name",
    });
    await renameCampus(conn.app, ctx, campus.id, { name: "Airport Residential" });
    expect((await listCampuses(conn.app, ctx)).some((c) => c.name === "Airport Residential")).toBe(true);
  });

  it("cannot touch another school's campus", async () => {
    const a = await schoolWithLimit(2);
    const b = await schoolWithLimit(2);
    const [campusB] = await listCampuses(conn.app, b.ctx);
    await expect(renameCampus(conn.app, a.ctx, campusB!.id, { name: "Hijacked" })).rejects.toMatchObject({
      code: "campus_not_found",
    });
  });

  it("requires the campuses.manage permission", async () => {
    const { school } = await schoolWithLimit(2);
    const teacher = await createUser(conn.owner, "Teacher");
    await addMember(conn.owner, school.id, teacher.id, ["teacher"]);
    const ctx = (await resolveTenantContext(conn.app, school.slug, teacher.id))!;
    await expect(createCampus(conn.app, ctx, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("campus-scoped memberships", () => {
  it("resolves the scope, filters campus lists and blocks school-wide campus management", async () => {
    const { school, ctx: adminCtx } = await schoolWithLimit(3);
    const east = await createCampus(conn.app, adminCtx, { name: "East" });
    const scoped = await createUser(conn.owner, "Scoped Admin");
    const membership = await addMember(conn.owner, school.id, scoped.id, ["admin"]);
    await withTenant(conn.owner, { tenantId: school.id, userId: scoped.id }, (tx) =>
      tx
        .insert(membershipCampuses)
        .values({ tenantId: school.id, membershipId: membership.id, campusId: east.id }),
    );

    const ctx = (await resolveTenantContext(conn.app, school.slug, scoped.id)) as TenantContext;
    expect(ctx.campusIds).toEqual([east.id]);
    expect(canAccessCampus(ctx, east.id)).toBe(true);
    expect((await listCampuses(conn.app, ctx)).map((c) => c.name)).toEqual(["East"]);
    await expect(createCampus(conn.app, ctx, { name: "West" })).rejects.toMatchObject({
      code: "campus_scope",
    });
    expect(adminCtx.campusIds).toBeNull();
  });

  it("cannot link a membership to another school's campus (composite foreign key)", async () => {
    const a = await schoolWithLimit(2);
    const b = await schoolWithLimit(2);
    const [campusB] = await listCampuses(conn.app, b.ctx);
    const membership = await withTenant(
      conn.owner,
      { tenantId: a.school.id, userId: a.admin.id },
      async (tx) => {
        const { memberships } = await import("@/server/db/schema");
        const [row] = await tx.select().from(memberships).where(eq(memberships.userId, a.admin.id));
        return row!;
      },
    );
    await expect(
      withTenant(conn.owner, { tenantId: a.school.id, userId: a.admin.id }, (tx) =>
        tx
          .insert(membershipCampuses)
          .values({ tenantId: a.school.id, membershipId: membership.id, campusId: campusB!.id }),
      ),
    ).rejects.toSatisfy((e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503");
  });
});
