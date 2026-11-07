import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { changePassword } from "@/server/auth/account";
import { deviceTokenIssuer } from "@/server/auth/device-tokens";
import { beginEnrollment, confirmEnrollment } from "@/server/auth/mfa";
import { createSession } from "@/server/auth/sessions";
import { base32Decode, timeStep, totpAt } from "@/server/auth/totp";
import { handleApiRequest } from "@/server/api";
import { withTenant } from "@/server/db/context";
import { supportViews, tenants } from "@/server/db/schema";
import { grantSupportAccess } from "@/server/support/access";
import { createUser, makePlatformAdmin, TEST_PASSWORD } from "../support/fixtures";
import { conn, school as baseSchool } from "../support/mobile-money";

afterAll(() => conn.close());

interface Call {
  token?: string;
  cookie?: string;
  body?: unknown;
  raw?: string;
}

async function call(method: string, path: string, opts: Call = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const request = new Request(`http://localhost/api/v1${path}`, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const response = await handleApiRequest(conn.app, request, { cookieToken: opts.cookie ?? null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** A school without a two-step requirement (each test sets one where it needs it). */
async function school() {
  const s = await baseSchool();
  await conn.owner.update(tenants).set({ mfaRequiredRoles: [] }).where(eq(tenants.id, s.tenant.id));
  return s;
}

const tokenFor = async (userId: string, name = "Test device") =>
  (await deviceTokenIssuer(name)(conn.app, userId)).token;

describe("API sign-in and device tokens", () => {
  it("issues a named device token for the right password, and revokes it", async () => {
    const user = await createUser(conn.owner, "Api User");
    const bad = await call("POST", "/auth/token", {
      body: { identifier: user.email, password: "wrong password", deviceName: "Phone" },
    });
    expect(bad).toMatchObject({ status: 401, body: { error: { code: "invalid_credentials" } } });
    expect(
      (await call("POST", "/auth/token", { body: { identifier: user.email, password: TEST_PASSWORD } }))
        .status,
    ).toBe(422);

    const ok = await call("POST", "/auth/token", {
      body: { email: user.email, password: TEST_PASSWORD, deviceName: "Office tablet" },
    });
    expect(ok.status).toBe(200);
    const token = ok.body.token as string;
    expect(token).toMatch(/^ebd_/);
    expect((await call("GET", "/me", { token })).body.user).toMatchObject({ id: user.id });

    const devices = (await call("GET", "/auth/tokens", { token })).body.devices as {
      handle: string;
      name: string;
    }[];
    expect(devices.map((d) => d.name)).toEqual(["Office tablet"]);
    // A second device; revoking it leaves the first working.
    const second = await tokenFor(user.id, "Phone");
    const phone = (await call("GET", "/auth/tokens", { token })).body.devices.find(
      (d: { name: string }) => d.name === "Phone",
    );
    expect((await call("DELETE", `/auth/tokens/${phone.handle}`, { token })).status).toBe(200);
    expect((await call("GET", "/me", { token: second })).status).toBe(401);
    expect((await call("GET", "/me", { token })).status).toBe(200);
    // Signing out revokes the token used.
    expect((await call("POST", "/auth/sign-out", { token })).status).toBe(200);
    expect((await call("GET", "/me", { token })).status).toBe(401);
  });

  it("never accepts web session tokens as bearer tokens, and cookies only for reading", async () => {
    const user = await createUser(conn.owner);
    const session = await createSession(conn.app, user.id);
    expect((await call("GET", "/me", { token: session.token })).status).toBe(401);
    expect((await call("GET", "/me", { cookie: session.token })).status).toBe(200);
    expect((await call("POST", "/auth/sign-out", { cookie: session.token })).status).toBe(401);
  });

  it("asks for the second step when the account has one", async () => {
    const user = await createUser(conn.owner);
    const { secret } = await beginEnrollment(conn.app, user);
    await confirmEnrollment(conn.app, user.id, totpAt(base32Decode(secret), timeStep() - 1));
    const first = await call("POST", "/auth/token", {
      body: { identifier: user.email, password: TEST_PASSWORD, deviceName: "Laptop" },
    });
    expect(first.body).toMatchObject({ mfaRequired: true, challenge: expect.any(String) });
    expect(first.body.token).toBeUndefined();
    const wrong = await call("POST", "/auth/token/verify", {
      body: { challenge: first.body.challenge, code: "000000", deviceName: "Laptop" },
    });
    expect(wrong.status).toBe(401);
    const done = await call("POST", "/auth/token/verify", {
      body: {
        challenge: first.body.challenge,
        code: totpAt(base32Decode(secret), timeStep()),
        deviceName: "Laptop",
      },
    });
    expect(done.body.token).toMatch(/^ebd_/);
  });

  it("revokes every device when the password changes", async () => {
    const user = await createUser(conn.owner);
    const token = await tokenFor(user.id);
    const session = await createSession(conn.app, user.id);
    await changePassword(conn.app, user.id, (await import("@/server/auth/tokens")).hashToken(session.token), {
      currentPassword: TEST_PASSWORD,
      newPassword: "a brand new long password",
      confirmPassword: "a brand new long password",
    });
    expect((await call("GET", "/me", { token })).status).toBe(401);
  });
});

describe("school routes", () => {
  it("resolve the school like the web: members only, the school's two-step policy, and their permissions", async () => {
    const s = await school();
    const owner = await tokenFor(s.owner.userId);
    const teacher = await tokenFor(s.teacher.userId);
    const stranger = await tokenFor((await createUser(conn.owner)).id);

    const mine = await call("GET", `/schools/${s.tenant.slug}`, { token: owner });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ roles: ["owner"], currentTerm: { name: "Term 1" } });
    expect(mine.body.permissions).toContain("fees.manage");
    const theirs = await call("GET", `/schools/${s.tenant.slug}`, { token: teacher });
    expect(theirs.body.permissions).not.toContain("fees.view");
    expect((await call("GET", `/schools/${s.tenant.slug}`, { token: stranger })).status).toBe(404);
    expect((await call("GET", "/schools/no-such-school", { token: owner })).status).toBe(404);
    expect((await call("GET", `/schools/${s.tenant.slug}`)).status).toBe(401);

    await conn.owner
      .update(tenants)
      .set({ mfaRequiredRoles: ["teacher"] })
      .where(eq(tenants.id, s.tenant.id));
    expect((await call("GET", `/schools/${s.tenant.slug}`, { token: teacher })).body).toMatchObject({
      error: { code: "mfa_required" },
    });
  });

  it("list and show students through the same services and checks", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const token = await tokenFor(s.owner.userId);
    const list = await call("GET", `/schools/${s.tenant.slug}/students?q=Ama`, { token });
    expect(list.body.rows.map((r: { id: string }) => r.id)).toEqual([ama.id]);
    expect((await call("GET", `/schools/${s.tenant.slug}/students/${ama.id}`, { token })).body).toMatchObject(
      {
        id: ama.id,
        firstName: "Ama",
      },
    );
    expect((await call("GET", `/schools/${s.tenant.slug}/students/not-a-uuid`, { token })).status).toBe(404);
    expect((await call("GET", `/schools/${s.tenant.slug}/students?page=0`, { token })).status).toBe(422);
    // Another school's student is not found.
    const other = await school();
    const foreign = await other.add("Kofi", other.classA);
    expect((await call("GET", `/schools/${s.tenant.slug}/students/${foreign.id}`, { token })).status).toBe(
      404,
    );
  });

  it("record what EduBridge support reads through the API", async () => {
    const s = await school();
    const admin = await createUser(conn.owner, "Support");
    await makePlatformAdmin(conn.owner, admin.id);
    const token = await tokenFor(admin.id);
    expect((await call("GET", `/schools/${s.tenant.slug}/classes`, { token })).status).toBe(404);
    await grantSupportAccess(conn.app, s.owner, { hours: 1, note: "" });
    const answer = await call("GET", `/schools/${s.tenant.slug}/classes`, { token });
    // Platform staff must use two-step verification unless turned off for the environment.
    if (process.env.PLATFORM_MFA_REQUIRED === "false") expect(answer.status).toBe(200);
    else expect(answer.body.error.code).toBe("mfa_required");
    const views = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select({ path: supportViews.path }).from(supportViews).where(eq(supportViews.tenantId, s.tenant.id)),
    );
    expect(views.length).toBe(process.env.PLATFORM_MFA_REQUIRED === "false" ? 1 : 0);
  });
});

describe("the API itself", () => {
  it("answers with one error format", async () => {
    expect((await call("GET", "/nothing-here")).status).toBe(404);
    expect((await call("PUT", "/auth/token")).status).toBe(405);
    expect((await call("POST", "/auth/token", { raw: "{not json" })).body).toMatchObject({
      error: { code: "invalid_json" },
    });
    const index = await call("GET", "/");
    expect(index.body.routes.length).toBeGreaterThan(5);
  });
});
