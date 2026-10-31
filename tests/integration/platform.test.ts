import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withUser } from "@/server/db/context";
import { auditEvents, campuses, tenantEntitlements, tenants } from "@/server/db/schema";
import { DomainError } from "@/server/errors";
import {
  createSchool,
  getSchool,
  listSchools,
  NotPlatformAdminError,
  reissueOwnerInvitation,
  setSchoolStatus,
  updateEntitlements,
} from "@/server/platform/service";
import { findInvitation } from "@/server/invitations/service";
import { resolveTenantContext } from "@/server/tenancy/service";
import {
  addMember,
  connect,
  createTenant,
  createUser,
  makePlatformAdmin,
  uniqueSlug,
} from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

let admin: Awaited<ReturnType<typeof createUser>>;
let schoolOwner: Awaited<ReturnType<typeof createUser>>;

const input = (overrides: Record<string, unknown> = {}) => ({
  name: "Synthetic Lakeside School",
  slug: uniqueSlug("lakeside"),
  countryCode: "GH",
  currencyCode: "GHS",
  timezone: "Africa/Accra",
  ownerEmail: `owner-${Math.random().toString(36).slice(2, 8)}@example.test`,
  planName: "Pilot",
  maxCampuses: 2,
  maxStudents: "",
  ...overrides,
});

beforeAll(async () => {
  admin = await createUser(conn.owner, "Platform Admin");
  await makePlatformAdmin(conn.owner, admin.id);
  schoolOwner = await createUser(conn.owner, "School Owner");
});

describe("creating schools", () => {
  it("creates the school, its plan, a first campus, an audit entry and an owner invitation", async () => {
    const data = input();
    const created = await createSchool(conn.app, admin.id, data);
    expect(created.slug).toBe(data.slug);
    expect(created.ownerInvitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const detail = await getSchool(conn.app, admin.id, created.tenantId);
    expect(detail).toMatchObject({
      name: data.name,
      status: "active",
      entitlements: { planName: "Pilot", maxCampuses: 2, maxStudents: null },
      activeCampuses: 1,
    });
    expect(detail?.invitations).toEqual([
      expect.objectContaining({ email: data.ownerEmail, roles: ["owner"], state: "pending" }),
    ]);

    const invitation = await findInvitation(conn.app, created.ownerInvitation.token);
    expect(invitation).toMatchObject({
      tenantId: created.tenantId,
      email: data.ownerEmail,
      roles: ["owner"],
    });

    const actions = await withTenant(conn.owner, { tenantId: created.tenantId, userId: admin.id }, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, created.tenantId)),
    );
    expect(actions.map((a) => a.action).sort()).toEqual(["invitation.issued", "school.created"]);
  });

  it("rejects a taken or reserved address with a field error", async () => {
    const first = input();
    await createSchool(conn.app, admin.id, first);
    await expect(createSchool(conn.app, admin.id, input({ slug: first.slug }))).rejects.toMatchObject({
      code: "slug_taken",
      field: "slug",
    });
    await expect(createSchool(conn.app, admin.id, input({ slug: "admin" }))).rejects.toThrow();
  });

  it("refuses non-platform-admins in the service", async () => {
    await expect(createSchool(conn.app, schoolOwner.id, input())).rejects.toBeInstanceOf(
      NotPlatformAdminError,
    );
    await expect(listSchools(conn.app, schoolOwner.id)).rejects.toBeInstanceOf(NotPlatformAdminError);
  });

  it("refuses non-platform-admins in the database, even if the service check were bypassed", async () => {
    await expect(
      withUser(conn.app, schoolOwner.id, (tx) =>
        tx.execute(sql`select platform_create_tenant('rogue-school', 'Rogue', 'GH', 'GHS', 'Africa/Accra')`),
      ),
    ).rejects.toSatisfy((e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "42501");
    await expect(
      withUser(conn.app, schoolOwner.id, (tx) =>
        tx.insert(tenants).values({ slug: "rogue-two", name: "Rogue" }),
      ),
    ).rejects.toThrow();
  });
});

describe("operating schools", () => {
  it("suspends a school, which locks its members out, and reactivates it", async () => {
    const school = await createTenant(conn.owner);
    await addMember(conn.owner, school.id, schoolOwner.id, ["owner"]);
    await setSchoolStatus(conn.app, admin.id, school.id, "suspended");
    expect(await resolveTenantContext(conn.app, school.slug, schoolOwner.id)).toBeNull();
    await setSchoolStatus(conn.app, admin.id, school.id, "active");
    expect(await resolveTenantContext(conn.app, school.slug, schoolOwner.id)).not.toBeNull();
  });

  it("updates plan limits; school admins cannot change their own plan", async () => {
    const school = await createTenant(conn.owner);
    await addMember(conn.owner, school.id, schoolOwner.id, ["owner"]);
    await updateEntitlements(conn.app, admin.id, school.id, {
      planName: "Standard",
      maxCampuses: 3,
      maxStudents: 800,
    });
    const detail = await getSchool(conn.app, admin.id, school.id);
    expect(detail?.entitlements).toEqual({ planName: "Standard", maxCampuses: 3, maxStudents: 800 });

    await expect(
      withTenant(conn.app, { tenantId: school.id, userId: schoolOwner.id }, (tx) =>
        tx
          .update(tenantEntitlements)
          .set({ maxCampuses: 99 })
          .where(eq(tenantEntitlements.tenantId, school.id)),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("reissuing an owner invitation revokes the previous link", async () => {
    const created = await createSchool(conn.app, admin.id, input());
    const email = (await findInvitation(conn.app, created.ownerInvitation.token))!.email;
    const next = await reissueOwnerInvitation(conn.app, admin.id, created.tenantId, email);
    expect(await findInvitation(conn.app, created.ownerInvitation.token)).toBeNull();
    expect(await findInvitation(conn.app, next.token)).not.toBeNull();
  });

  it("returns null for unknown or malformed school ids", async () => {
    expect(await getSchool(conn.app, admin.id, "not-a-uuid")).toBeNull();
    expect(await getSchool(conn.app, admin.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("keeps a school's campuses invisible to platform reads outside a tenant context", async () => {
    const rows = await withUser(conn.app, admin.id, (tx) => tx.select().from(campuses));
    expect(rows).toHaveLength(0);
  });
});

it("DomainError carries a code and field", () => {
  const error = new DomainError("x", "message", "field");
  expect([error.code, error.field, error.message]).toEqual(["x", "field", "message"]);
});
