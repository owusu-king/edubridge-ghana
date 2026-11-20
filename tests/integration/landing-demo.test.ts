import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { aiAvailability, openAiSession } from "@/server/ai/gateway";
import { validateSessionToken } from "@/server/auth/sessions";
import { demoVisitors, salesEnquiries, tenants } from "@/server/db/schema";
import { DEMO_VISIT_MS, DEMO_VISITS_PER_HOUR, findDemoVisit, startDemoVisit } from "@/server/demo/visit";
import {
  ENQUIRIES_PER_HOUR,
  listEnquiries,
  markEnquiryHandled,
  submitEnquiry,
} from "@/server/enquiries/service";
import { getIncomeAndSpending, saveFinanceAccount } from "@/server/finance/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addDemoVisitor } from "../../scripts/demo/visitor";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";
import { billedSchool } from "../support/school";

const conn = connect();
afterAll(() => conn.close());

/** Drizzle wraps a database error; the database's own message is its cause. */
async function refused(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, "expected the database to refuse").not.toBeNull();
  expect(`${error?.message} ${error?.cause?.message ?? ""}`).toMatch(pattern);
}

/** A demo school (as `npm run demo:school` marks it) with its visitor, and the visitor's context. */
async function demoSchool() {
  const s = await billedSchool(conn);
  await conn.owner.update(tenants).set({ isDemo: true }).where(eq(tenants.id, s.tenant.id));
  await addDemoVisitor(conn.owner, s.tenant.slug);
  const visit = await findDemoVisit(conn.app, s.tenant.slug);
  const visitor = (await resolveTenantContext(conn.app, s.tenant.slug, visit!.visitorId)) as TenantContext;
  return { s, visit: visit!, visitor };
}

const account = { name: "GCB current account", kind: "bank", institution: "GCB Bank", accountEnding: "4821" };

describe("a demo visitor", () => {
  it("sees the school as its Proprietor would, but every change is refused by the database", async () => {
    const { visitor, s } = await demoSchool();
    expect(visitor.demoVisitor).toBe(true);
    expect(visitor.roles).toEqual(["owner"]);
    // Reading works.
    await expect(
      getIncomeAndSpending(conn.app, visitor, { from: "2026-01-01", to: "2026-12-31" }),
    ).resolves.toBeTruthy();
    // Writing does not, whatever the service.
    await expect(saveFinanceAccount(conn.app, visitor, account)).rejects.toMatchObject({
      code: "demo_view_only",
    });
    // The school's real Proprietor still can.
    await expect(s.addStudent("Ama", "Mensah")).resolves.toBeTruthy();
  });

  it("never reaches the AI provider", async () => {
    const { visitor } = await demoSchool();
    await expect(aiAvailability(conn.app, visitor, "assistant")).resolves.toMatchObject({ available: false });
    await expect(openAiSession(conn.app, visitor, "assistant")).rejects.toMatchObject({ code: "ai_demo" });
  });

  it("can never belong to a school that is not a demo", async () => {
    const { visit } = await demoSchool();
    const real = await createTenant(conn.owner, "Real Academy");
    await refused(addMember(conn.owner, real.id, visit.visitorId, ["owner"]), /demo_visitor_membership/);
    // Nor can a member of a real school be made a demo visitor.
    const teacher = await createUser(conn.owner);
    await addMember(conn.owner, real.id, teacher.id, ["teacher"]);
    await refused(conn.owner.insert(demoVisitors).values({ userId: teacher.id }), /demo_visitor_membership/);
    // The app may only read who the visitors are.
    await refused(conn.app.insert(demoVisitors).values({ userId: teacher.id }), /permission denied/);
  });

  it("is refused for a school that is not a demo", async () => {
    const s = await billedSchool(conn);
    expect(await findDemoVisit(conn.app, s.tenant.slug)).toBeNull();
    await expect(startDemoVisit(conn.app, s.tenant.slug, {})).rejects.toMatchObject({
      code: "demo_unavailable",
    });
    await expect(addDemoVisitor(conn.owner, s.tenant.slug)).rejects.toThrow(/not a demo/);
  });
});

describe("a demo visit", () => {
  it("is a two-hour session for the visitor that is never extended", async () => {
    const { s, visit } = await demoSchool();
    const now = new Date();
    const { token } = await startDemoVisit(conn.app, s.tenant.slug, { ipAddress: "203.0.113.9" }, now);
    const session = await validateSessionToken(conn.app, token, now);
    expect(session?.user.id).toBe(visit.visitorId);
    expect(session?.user.demoVisitor).toBe(true);
    expect(session!.expiresAt.getTime()).toBe(now.getTime() + DEMO_VISIT_MS);
    // An ordinary session this close to its end would be renewed; a demo visit is not.
    const later = new Date(now.getTime() + DEMO_VISIT_MS - 60_000);
    expect((await validateSessionToken(conn.app, token, later))?.renewed).toBe(false);
    expect(
      await validateSessionToken(conn.app, token, new Date(now.getTime() + DEMO_VISIT_MS + 1)),
    ).toBeNull();
  });

  it("is limited per connection", async () => {
    const { s } = await demoSchool();
    const client = { ipAddress: "198.51.100.23" };
    for (let i = 0; i < DEMO_VISITS_PER_HOUR; i++) await startDemoVisit(conn.app, s.tenant.slug, client);
    await expect(startDemoVisit(conn.app, s.tenant.slug, client)).rejects.toMatchObject({
      code: "demo_busy",
    });
    await expect(
      startDemoVisit(conn.app, s.tenant.slug, { ipAddress: "198.51.100.24" }),
    ).resolves.toBeTruthy();
  });
});

describe("book a visit", () => {
  const enquiry = (extra: Record<string, string> = {}) => ({
    name: "Akosua Frimpong",
    role: "proprietor",
    schoolName: "Synthetic Hills Academy",
    town: "Kumasi",
    phone: "024 123 4567",
    email: "",
    students: "150_400",
    message: "",
    ...extra,
  });
  const ip = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}`;

  it("keeps a checked enquiry for the platform, with the phone number in E.164", async () => {
    const at = new Date();
    await submitEnquiry(conn.app, enquiry({ schoolName: `School ${at.getTime()}` }), { ipAddress: ip() }, at);
    const row = (await listEnquiries(conn.app)).find((r) => r.schoolName === `School ${at.getTime()}`);
    expect(row).toMatchObject({ phone: "+233241234567", email: null, message: null, handledAt: null });
  });

  it("refuses incomplete details, field by field", async () => {
    await expect(
      submitEnquiry(conn.app, enquiry({ name: " ", phone: "12", role: "spy" }), { ipAddress: ip() }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["name"] }),
        expect.objectContaining({ path: ["phone"] }),
        expect.objectContaining({ path: ["role"] }),
      ]),
    });
  });

  it("is limited per connection", async () => {
    const address = "192.0.2.254";
    await conn.owner.delete(salesEnquiries).where(eq(salesEnquiries.ipAddress, address));
    for (let i = 0; i < ENQUIRIES_PER_HOUR; i++)
      await submitEnquiry(conn.app, enquiry(), { ipAddress: address });
    await expect(submitEnquiry(conn.app, enquiry(), { ipAddress: address })).rejects.toMatchObject({
      code: "enquiry_busy",
    });
  });

  it("is marked handled once, and never deleted or rewritten", async () => {
    const admin = await createUser(conn.owner, "Platform admin");
    const at = new Date();
    await submitEnquiry(
      conn.app,
      enquiry({ schoolName: `Handled ${at.getTime()}` }),
      { ipAddress: ip() },
      at,
    );
    const row = (await listEnquiries(conn.app)).find((r) => r.schoolName === `Handled ${at.getTime()}`)!;
    await markEnquiryHandled(conn.app, admin.id, row.id);
    await expect(markEnquiryHandled(conn.app, admin.id, row.id)).rejects.toMatchObject({
      code: "enquiry_handled",
    });
    await refused(conn.app.delete(salesEnquiries).where(eq(salesEnquiries.id, row.id)), /permission denied/);
    await refused(
      conn.app.execute(sql`update sales_enquiries set school_name = 'Changed' where id = ${row.id}`),
      /permission denied/,
    );
  });
});
