import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { handleApiRequest } from "@/server/api";
import { deviceTokenIssuer } from "@/server/auth/device-tokens";
import { allowed } from "@/server/authz/permissions";
import { decidePlanRequest, getPlanOptions, requestPlanChange } from "@/server/billing/plans";
import { withTenant, withUser } from "@/server/db/context";
import { auditEvents, catalogPrices, platformEvents, schoolModules, tenants } from "@/server/db/schema";
import {
  endModuleGrant,
  getCatalog,
  grantModule,
  scheduleModuleEnd,
  setCatalogPrice,
  setReleaseAccess,
} from "@/server/entitlements/admin";
import { moduleActive } from "@/server/entitlements/service";
import { planIncludesParentView } from "@/server/parents/schools";
import { NotPlatformAdminError, updateEntitlements } from "@/server/platform/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { DEFAULT_PLAN_FEATURES } from "@/lib/plan";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school as baseSchool, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

/** A school on a plan without the given modules, with no two-step requirement (API calls). */
async function school(without: string[] = []) {
  const s = await baseSchool();
  await conn.owner.update(tenants).set({ mfaRequiredRoles: [] }).where(eq(tenants.id, s.tenant.id));
  const admin = await platform;
  await updateEntitlements(conn.app, admin.id, s.tenant.id, {
    planName: "Essentials",
    maxCampuses: 2,
    maxStudents: null,
    maxSmsPerMonth: null,
    features: DEFAULT_PLAN_FEATURES.filter((f) => !without.includes(f)),
  });
  return s;
}

const fresh = async (s: School, ctx: TenantContext) =>
  (await resolveTenantContext(conn.app, s.tenant.slug, ctx.userId)) as TenantContext;

async function api(s: School, ctx: TenantContext, path: string) {
  const { token } = await deviceTokenIssuer("Test device")(conn.app, ctx.userId);
  const response = await handleApiRequest(
    conn.app,
    new Request(`http://localhost/api/v1/schools/${s.tenant.slug}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { cookieToken: null },
  );
  return response.status;
}

const auditFor = (s: School) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.tenantId, s.tenant.id)),
  );

describe("modules beyond the plan (SUB-06, ENT-02 to ENT-04)", () => {
  it("an add-on gives a school a module its plan leaves out, everywhere, until it is ended", async () => {
    const s = await school(["attendance"]);
    const admin = await platform;
    const today = todayIn(s.tenant.timezone);
    let head = await fresh(s, s.head);
    expect(allowed(head, "attendance.take")).toBe(false);
    expect(await api(s, head, `/attendance/${today}`)).toBe(404);

    const { id } = await grantModule(conn.app, admin.id, s.tenant.id, {
      module: "attendance",
      source: "addon",
      price: "300",
      priceUnit: "flat",
      billingPeriod: "termly",
    });
    head = await fresh(s, s.head);
    expect(allowed(head, "attendance.take")).toBe(true);
    expect(head.modules.attendance).toMatchObject({ state: "active", source: "addon", endsOn: null });
    expect(await api(s, head, `/attendance/${today}`)).toBe(200);
    const [row] = await withTenant(conn.app, { tenantId: s.tenant.id, userId: admin.id }, (tx) =>
      tx.select().from(schoolModules).where(eq(schoolModules.id, id)),
    );
    expect(row).toMatchObject({ pricePesewas: 30_000, currencyCode: "GHS", billingPeriod: "termly" });

    await endModuleGrant(conn.app, admin.id, s.tenant.id, id, { reason: "School asked to stop" });
    head = await fresh(s, s.head);
    expect(allowed(head, "attendance.take")).toBe(false);
    expect(await api(s, head, `/attendance/${today}`)).toBe(404);
    await expect(
      endModuleGrant(conn.app, admin.id, s.tenant.id, id, { reason: "Again" }),
    ).rejects.toMatchObject({ code: "module_grant_not_found" });

    const actions = (await auditFor(s)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["modules.granted", "modules.ended"]));
    const events = await withUser(conn.app, admin.id, (tx) =>
      tx.select({ action: platformEvents.action, metadata: platformEvents.metadata }).from(platformEvents),
    );
    expect(events.filter((e) => e.metadata.tenantId === s.tenant.id).map((e) => e.action)).toEqual(
      expect.arrayContaining(["modules.granted", "modules.ended"]),
    );
  });

  it("refuses a module whose dependencies the school lacks, and dates that overlap (MOD-03)", async () => {
    const s = await school();
    const admin = await platform;
    await expect(
      grantModule(conn.app, admin.id, s.tenant.id, {
        module: "payroll",
        source: "trial",
        endsOn: "2099-01-01",
      }),
    ).rejects.toMatchObject({
      code: "module_dependencies",
      message: "Payroll records needs Staff and HR first.",
    });
    await grantModule(conn.app, admin.id, s.tenant.id, { module: "staff_hr", source: "promotion" });
    await grantModule(conn.app, admin.id, s.tenant.id, {
      module: "payroll",
      source: "trial",
      endsOn: "2099-01-01",
    });
    expect((await fresh(s, s.owner)).features).toEqual(expect.arrayContaining(["staff_hr", "payroll"]));
    await expect(
      grantModule(conn.app, admin.id, s.tenant.id, { module: "staff_hr", source: "addon" }),
    ).rejects.toMatchObject({ code: "module_grant_overlap" });
    await expect(
      grantModule(conn.app, admin.id, s.tenant.id, { module: "attendance", source: "addon" }),
    ).rejects.toMatchObject({ code: "module_in_plan" });
    await expect(
      grantModule(conn.app, admin.id, s.tenant.id, { module: "library", source: "trial" }),
    ).rejects.toThrow("A trial needs an end date.");
  });

  it("is written only by EduBridge staff, never rewritten or deleted, and seen only by its own school", async () => {
    const s = await school(["admissions"]);
    const other = await school();
    const admin = await platform;
    const { id } = await grantModule(conn.app, admin.id, s.tenant.id, {
      module: "admissions",
      source: "addon",
    });

    // The school reads its own rows, and cannot add one.
    const mine = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select({ id: schoolModules.id }).from(schoolModules),
    );
    expect(mine.map((r) => r.id)).toEqual([id]);
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.insert(schoolModules).values({
          tenantId: s.tenant.id,
          module: "library",
          source: "addon",
          startsOn: "2026-01-01",
          grantedByUserId: s.owner.userId,
        }),
      ),
    ).rejects.toThrow();
    // Another school sees nothing of it.
    const theirs = await withTenant(
      conn.app,
      { tenantId: other.tenant.id, userId: other.owner.userId },
      (tx) => tx.select({ id: schoolModules.id }).from(schoolModules).where(eq(schoolModules.id, id)),
    );
    expect(theirs).toEqual([]);
    expect((await fresh(other, other.owner)).modules.admissions?.source).toBe("plan");

    // Even platform staff cannot rewrite or delete a grant; its end is set once.
    const asAdmin = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(conn.app, { tenantId: s.tenant.id, userId: admin.id }, fn);
    await expect(
      asAdmin((tx) => tx.update(schoolModules).set({ pricePesewas: 1 }).where(eq(schoolModules.id, id))),
    ).rejects.toThrow();
    await expect(asAdmin((tx) => tx.delete(schoolModules).where(eq(schoolModules.id, id)))).rejects.toThrow();
    await scheduleModuleEnd(conn.app, admin.id, s.tenant.id, id, { endsOn: "2099-12-31" });
    await expect(
      scheduleModuleEnd(conn.app, admin.id, s.tenant.id, id, { endsOn: "2099-06-30" }),
    ).rejects.toMatchObject({ code: "module_end_set" });
    await expect(
      asAdmin((tx) => tx.update(schoolModules).set({ endsOn: "2099-01-01" }).where(eq(schoolModules.id, id))),
    ).rejects.toThrow();
    expect((await fresh(s, s.owner)).modules.admissions).toMatchObject({
      state: "active",
      endsOn: "2099-12-31",
    });

    // A school member is never platform staff.
    await expect(
      grantModule(conn.app, s.owner.userId, s.tenant.id, { module: "library", source: "addon" }),
    ).rejects.toBeInstanceOf(NotPlatformAdminError);
  });
});

describe("release access (REL-02)", () => {
  it("is only for modules waiting for release, kept apart from what a school has", async () => {
    const s = await school();
    const admin = await platform;
    // Every module is released (2026-11-18), so none is waiting for release access.
    await expect(
      setReleaseAccess(conn.app, admin.id, s.tenant.id, { module: "library", on: true }),
    ).rejects.toThrow("already available");
    await expect(
      setReleaseAccess(conn.app, admin.id, s.tenant.id, { module: "attendance", on: true }),
    ).rejects.toThrow("already available");
  });
});

describe("asking for a module (SUB-08)", () => {
  it("adds it at the catalogue price when EduBridge approves, and cancels it the same way", async () => {
    const s = await school(["admissions"]);
    const admin = await platform;
    await setCatalogPrice(conn.app, admin.id, {
      module: "admissions",
      billingPeriod: "termly",
      currencyCode: "GHS",
      price: "150",
      unit: "flat",
    });
    let owner = await fresh(s, s.owner);
    const options = await getPlanOptions(conn.app, owner);
    const offered = options.available.find((a) => a.id === "admissions");
    expect(offered?.prices.map((p) => p.pricePesewas)).toEqual([15_000]);
    expect(options.available.map((a) => a.id)).not.toContain("safeguarding");
    await expect(
      requestPlanChange(conn.app, owner, { kind: "add_module", module: "safeguarding" }),
    ).rejects.toMatchObject({ code: "module_not_offered" });
    await expect(
      requestPlanChange(conn.app, owner, { kind: "add_module", module: "attendance" }),
    ).rejects.toMatchObject({ code: "module_active" });

    const asked = await requestPlanChange(conn.app, owner, {
      kind: "add_module",
      module: "admissions",
      message: "For next term's intake",
    });
    expect((await getPlanOptions(conn.app, owner)).pending).toMatchObject({
      kind: "add_module",
      module: "admissions",
    });
    expect(await decidePlanRequest(conn.app, admin.id, asked.id, { approve: true })).toEqual({
      applied: true,
    });
    owner = await fresh(s, s.owner);
    expect(owner.modules.admissions).toMatchObject({ state: "active", source: "addon" });
    const [grant] = (await getPlanOptions(conn.app, owner)).grants;
    expect(grant).toMatchObject({ module: "admissions", pricePesewas: 15_000, billingPeriod: "termly" });

    const cancel = await requestPlanChange(conn.app, owner, { kind: "cancel_module", module: "admissions" });
    await decidePlanRequest(conn.app, admin.id, cancel.id, { approve: true });
    owner = await fresh(s, s.owner);
    // No paid-until date: it ends today, so it is still active today and off tomorrow.
    expect(owner.modules.admissions).toMatchObject({ state: "active", endsOn: todayIn(s.tenant.timezone) });
    await expect(
      requestPlanChange(conn.app, owner, { kind: "cancel_module", module: "attendance" }),
    ).rejects.toMatchObject({ code: "module_not_cancellable" });
  });
});

describe("catalogue prices (SUB-07)", () => {
  it("keep one current price per period and currency, and the history", async () => {
    const admin = await platform;
    const set = (price: string) =>
      setCatalogPrice(conn.app, admin.id, {
        module: "transport",
        billingPeriod: "annual",
        currencyCode: "KES",
        price,
        unit: "per_student",
      });
    await set("100");
    await set("120");
    const rows = await withUser(conn.app, admin.id, (tx) =>
      tx
        .select()
        .from(catalogPrices)
        .where(and(eq(catalogPrices.module, "transport"), eq(catalogPrices.currencyCode, "KES"))),
    );
    expect(rows.filter((r) => r.archivedAt === null).map((r) => r.pricePesewas)).toEqual([12_000]);
    expect(rows.filter((r) => r.archivedAt !== null).map((r) => r.pricePesewas)).toContain(10_000);
    const catalog = await getCatalog(conn.app, admin.id);
    expect(catalog.modules.find((m) => m.id === "transport")?.prices).toEqual(
      expect.arrayContaining([expect.objectContaining({ pricePesewas: 12_000, unit: "per_student" })]),
    );
    const someone = await createUser(conn.owner, "Not Staff");
    await expect(
      setCatalogPrice(conn.app, someone.id, {
        module: "transport",
        billingPeriod: "annual",
        currencyCode: "KES",
        price: "1",
        unit: "flat",
      }),
    ).rejects.toBeInstanceOf(NotPlatformAdminError);
  });
});

describe("background jobs and the parent side use the same resolver (ENT-06)", () => {
  it("see a parent view add-on on a plan without it", async () => {
    const s = await school(["parent_view"]);
    const admin = await platform;
    const check = () =>
      withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        planIncludesParentView(tx, s.tenant.id),
      );
    expect(await check()).toBe(false);
    await grantModule(conn.app, admin.id, s.tenant.id, {
      module: "parent_view",
      source: "trial",
      endsOn: "2099-01-01",
    });
    expect(await check()).toBe(true);
    expect(
      await withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        moduleActive(tx, s.tenant.id, "whatsapp"),
      ),
    ).toBe(false);
  });
});
