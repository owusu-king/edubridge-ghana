import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { allowed, ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, supportGrants } from "@/server/db/schema";
import {
  endSupportAccess,
  getSupportAccess,
  grantSupportAccess,
  recordSupportView,
} from "@/server/support/access";
import { saveSchoolContacts } from "@/server/tenancy/preferences";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Support");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const asSupport = async (s: School) => resolveTenantContext(conn.app, s.tenant.slug, (await platform).id);

const contacts = (phone: string) => ({
  contactPhone: phone,
  contactEmail: "",
  contactWhatsapp: "",
  officeHours: "",
});

const auditFor = (s: School, action: string) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
    tx
      .select({ actor: auditEvents.actorUserId, grant: auditEvents.supportGrantId })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, action)))
      .orderBy(auditEvents.occurredAt),
  );

describe("support access", () => {
  it("lets platform staff in only while the Proprietor allows it", async () => {
    const s = await school();
    expect(await asSupport(s)).toBeNull();
    // Only the Proprietor decides.
    for (const ctx of [s.head, s.bursar, s.teacher])
      await expect(grantSupportAccess(conn.app, ctx, { hours: 4, note: "" })).rejects.toThrow(ForbiddenError);
    await expect(grantSupportAccess(conn.app, s.owner, { hours: 5, note: "" })).rejects.toThrow();

    const grant = await grantSupportAccess(conn.app, s.owner, { hours: 4, note: "Fees will not bill" });
    const hours = (grant.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(3.9);
    expect(hours).toBeLessThanOrEqual(4);

    const support = (await asSupport(s))!;
    expect(support).toMatchObject({
      roles: ["owner"],
      campusIds: null,
      support: { grantId: grant.id },
      mfaRequired: process.env.PLATFORM_MFA_REQUIRED !== "false",
    });
    // Support can make changes, but cannot manage support access or download the school's data.
    expect(allowed(support, "fees.manage")).toBe(true);
    expect(allowed(support, "members.manage")).toBe(true);
    expect(allowed(support, "support.manage")).toBe(false);
    expect(allowed(support, "data.export")).toBe(false);
    expect(allowed(support, "fees.export")).toBe(false);
    await expect(grantSupportAccess(conn.app, support, { hours: 168, note: "" })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(endSupportAccess(conn.app, support)).rejects.toThrow(ForbiddenError);
    // Someone who is neither a member nor platform staff still gets nothing.
    const stranger = await createUser(conn.owner, "Stranger");
    expect(await resolveTenantContext(conn.app, s.tenant.slug, stranger.id)).toBeNull();

    expect(await endSupportAccess(conn.app, s.owner)).toBe(true);
    expect(await asSupport(s)).toBeNull();
    expect(await endSupportAccess(conn.app, s.owner)).toBe(false);
    expect((await auditFor(s, "support.granted")).length).toBe(1);
    expect((await auditFor(s, "support.ended")).length).toBe(1);
  });

  it("records what support opened and tags its changes, for the Proprietor to see", async () => {
    const s = await school();
    const grant = await grantSupportAccess(conn.app, s.owner, { hours: 24, note: "" });
    const support = (await asSupport(s)) as TenantContext;
    await recordSupportView(conn.app, support, `/s/${s.tenant.slug}/fees`, "view");
    await recordSupportView(conn.app, support, `/s/${s.tenant.slug}/settings`, "action");
    // A path that is not a plain path is not stored as given.
    await recordSupportView(conn.app, support, "javascript:alert(1)", "view");
    await saveSchoolContacts(conn.app, support, contacts("030 123 4567"));
    await saveSchoolContacts(conn.app, s.owner, contacts("030 123 4568"));

    const admin = await platform;
    expect(await auditFor(s, "school.contacts_updated")).toEqual([
      { actor: admin.id, grant: grant.id },
      { actor: s.owner.userId, grant: null },
    ]);

    const overview = await getSupportAccess(conn.app, s.owner);
    expect(overview.live).toMatchObject({ id: grant.id, pagesViewed: 3, changes: 1 });
    expect(overview.activity.map((a) => [a.kind, a.what])).toEqual(
      expect.arrayContaining([
        ["view", `/s/${s.tenant.slug}/fees`],
        ["action", `/s/${s.tenant.slug}/settings`],
        ["view", `/s/${s.tenant.slug}`],
        ["change", "school.contacts_updated"],
      ]),
    );
    expect(overview.activity.every((a) => a.by === "EduBridge Support")).toBe(true);
    await expect(getSupportAccess(conn.app, support)).rejects.toThrow(ForbiddenError);
  });

  it("replaces the current grant, ends on its own, and never lasts more than 7 days", async () => {
    const s = await school();
    const first = await grantSupportAccess(conn.app, s.owner, { hours: 1, note: "" });
    const second = await grantSupportAccess(conn.app, s.owner, { hours: 168, note: "Term set-up" });
    const { grants, live } = await getSupportAccess(conn.app, s.owner);
    expect(live!.id).toBe(second.id);
    expect(grants.find((g) => g.id === first.id)).toMatchObject({ live: false, endedBy: expect.any(String) });
    await endSupportAccess(conn.app, s.owner);

    const asSchool = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);
    // A grant whose time has passed lets nobody in, without anyone ending it.
    await asSchool((tx) =>
      tx.insert(supportGrants).values({
        tenantId: s.tenant.id,
        grantedByUserId: s.owner.userId,
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      }),
    );
    expect(await asSupport(s)).toBeNull();
    await expect(
      asSchool((tx) =>
        tx.insert(supportGrants).values({
          tenantId: s.tenant.id,
          grantedByUserId: s.owner.userId,
          expiresAt: sql`now() + interval '8 days'`,
        }),
      ),
    ).rejects.toThrow();
    // An ended grant cannot be reopened, and grants are never deleted.
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx
          .update(supportGrants)
          .set({ endedAt: null, endedByUserId: null })
          .where(eq(supportGrants.id, second.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.delete(supportGrants).where(eq(supportGrants.id, second.id)),
      ),
    ).rejects.toThrow();
  });

  it("cannot be used at another school", async () => {
    const a = await school();
    const b = await school();
    await grantSupportAccess(conn.app, a.owner, { hours: 1, note: "" });
    expect(await asSupport(a)).not.toBeNull();
    expect(await asSupport(b)).toBeNull();
  });
});
