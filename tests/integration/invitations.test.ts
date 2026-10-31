import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateSessionToken } from "@/server/auth/sessions";
import { withTenant } from "@/server/db/context";
import { invitations } from "@/server/db/schema";
import {
  acceptInvitation,
  findInvitation,
  INVITATION_LIFETIME_MS,
  issueInvitation,
} from "@/server/invitations/service";
import { resolveTenantContext } from "@/server/tenancy/service";
import { connect, createTenant, createUser, addMember } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

let school: Awaited<ReturnType<typeof createTenant>>;
let inviter: Awaited<ReturnType<typeof createUser>>;

async function invite(email: string, roles: ("owner" | "admin" | "teacher")[] = ["teacher"], now?: Date) {
  return withTenant(conn.app, { tenantId: school.id, userId: inviter.id }, (tx) =>
    issueInvitation(tx, { tenantId: school.id, email, roles, invitedByUserId: inviter.id }, now),
  );
}
const email = () => `invitee-${Math.random().toString(36).slice(2, 10)}@example.test`;

beforeAll(async () => {
  school = await createTenant(conn.owner, "Invitation Test School");
  inviter = await createUser(conn.owner, "Inviter");
  await addMember(conn.owner, school.id, inviter.id, ["admin"]);
});

describe("invitations", () => {
  it("creates an account and membership, signs the new user in, and cannot be reused", async () => {
    const address = email();
    const { token } = await invite(address);
    const result = await acceptInvitation(conn.app, token, {
      kind: "new-account",
      name: "Esi Quaye",
      password: "a-strong-password",
    });
    expect(result.session).toBeDefined();
    expect((await validateSessionToken(conn.app, result.session!.token))?.user.email).toBe(address);
    expect((await resolveTenantContext(conn.app, school.slug, result.userId))?.roles).toEqual(["teacher"]);

    await expect(
      acceptInvitation(conn.app, token, {
        kind: "new-account",
        name: "Again",
        password: "a-strong-password",
      }),
    ).rejects.toMatchObject({ code: "invitation_invalid" });
  });

  it("lets only one of two concurrent acceptances succeed", async () => {
    const existing = await createUser(conn.owner, "Concurrent User");
    const { token } = await invite(existing.email);
    const as = { kind: "signed-in" as const, userId: existing.id, email: existing.email };
    const results = await Promise.allSettled([
      acceptInvitation(conn.app, token, as),
      acceptInvitation(conn.app, token, as),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("requires existing accounts to sign in, as the invited email", async () => {
    const existing = await createUser(conn.owner, "Existing User");
    const other = await createUser(conn.owner, "Someone Else");
    const { token } = await invite(existing.email, ["admin"]);
    expect((await findInvitation(conn.app, token))?.accountExists).toBe(true);

    await expect(
      acceptInvitation(conn.app, token, {
        kind: "new-account",
        name: "Impostor",
        password: "a-strong-password",
      }),
    ).rejects.toMatchObject({ code: "invitation_account_exists" });
    await expect(
      acceptInvitation(conn.app, token, { kind: "signed-in", userId: other.id, email: other.email }),
    ).rejects.toMatchObject({ code: "invitation_wrong_account" });

    const result = await acceptInvitation(conn.app, token, {
      kind: "signed-in",
      userId: existing.id,
      email: existing.email,
    });
    expect(result.session).toBeUndefined();
    expect((await resolveTenantContext(conn.app, school.slug, existing.id))?.roles).toEqual(["admin"]);
  });

  it("merges roles when an existing member is invited again", async () => {
    const member = await createUser(conn.owner, "Teacher Parent");
    await addMember(conn.owner, school.id, member.id, ["teacher"]);
    const { token } = await invite(member.email, ["admin"]);
    await acceptInvitation(conn.app, token, { kind: "signed-in", userId: member.id, email: member.email });
    expect((await resolveTenantContext(conn.app, school.slug, member.id))?.roles).toEqual([
      "admin",
      "teacher",
    ]);
  });

  it("rejects expired, revoked and unknown tokens", async () => {
    const past = new Date(Date.now() - INVITATION_LIFETIME_MS - 1000);
    const expired = await invite(email(), ["teacher"], past);
    expect(await findInvitation(conn.app, expired.token)).toBeNull();

    const address = email();
    const first = await invite(address);
    await invite(address);
    expect(await findInvitation(conn.app, first.token)).toBeNull();

    expect(await findInvitation(conn.app, "x".repeat(43))).toBeNull();
  });

  it("enforces password rules for new accounts", async () => {
    const { token } = await invite(email());
    await expect(
      acceptInvitation(conn.app, token, { kind: "new-account", name: "Short", password: "short" }),
    ).rejects.toThrow();
    expect(await findInvitation(conn.app, token)).not.toBeNull();
  });

  it("hides invitations from other tenants and from lookups without the token", async () => {
    await invite(email());
    const otherSchool = await createTenant(conn.owner);
    const rows = await withTenant(conn.app, { tenantId: otherSchool.id, userId: inviter.id }, (tx) =>
      tx.select().from(invitations),
    );
    expect(rows).toHaveLength(0);
    expect(await conn.app.select().from(invitations)).toHaveLength(0);
  });
});
