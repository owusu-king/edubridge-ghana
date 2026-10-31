import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { changePassword, signOutOtherSessions } from "@/server/auth/account";
import {
  beginEnrollment,
  confirmEnrollment,
  disableMfa,
  getMfaStatus,
  MAX_CHALLENGE_ATTEMPTS,
  regenerateRecoveryCodes,
  verifyChallenge,
} from "@/server/auth/mfa";
import { createSession, validateSessionToken } from "@/server/auth/sessions";
import { MAX_FAILURES_PER_EMAIL, signIn } from "@/server/auth/sign-in";
import { base32Decode, timeStep, totpAt } from "@/server/auth/totp";
import { userMfa } from "@/server/db/schema";
import { connect, createUser, TEST_PASSWORD } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

const codeFor = (secret: string, offset = 0) => totpAt(base32Decode(secret), timeStep() + offset);

async function userWithMfa() {
  const user = await createUser(conn.owner, "MFA User");
  const { secret } = await beginEnrollment(conn.app, user);
  const recovery = await confirmEnrollment(conn.app, user.id, codeFor(secret, -1));
  return { user, secret, recovery };
}

describe("enrolment", () => {
  it("activates only after a valid code, stores the secret encrypted, and returns 10 recovery codes", async () => {
    const user = await createUser(conn.owner);
    const { secret, uri } = await beginEnrollment(conn.app, user);
    expect(uri).toContain(`secret=${secret}`);
    expect((await getMfaStatus(conn.app, user.id)).enabled).toBe(false);
    const [row] = await conn.owner.select().from(userMfa).where(eq(userMfa.userId, user.id));
    expect(row?.secretSealed).not.toContain(secret);

    await expect(confirmEnrollment(conn.app, user.id, "000000")).rejects.toMatchObject({
      code: "mfa_code_invalid",
    });
    const codes = await confirmEnrollment(conn.app, user.id, codeFor(secret));
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(await getMfaStatus(conn.app, user.id)).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
    await expect(beginEnrollment(conn.app, user)).rejects.toMatchObject({ code: "mfa_already_enabled" });
  });
});

describe("sign-in with two-step verification", () => {
  it("requires a second step and creates the session only after a valid code", async () => {
    const { user, secret } = await userWithMfa();
    const first = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    expect(first.ok).toBe("mfa");
    if (first.ok !== "mfa") return;
    expect(await verifyChallenge(conn.app, first.challengeToken, "123456")).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    const result = await verifyChallenge(conn.app, first.challengeToken, codeFor(secret));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect((await validateSessionToken(conn.app, result.session.token))?.user.id).toBe(user.id);
    // The challenge is single-use.
    expect(await verifyChallenge(conn.app, first.challengeToken, codeFor(secret, 1))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a replayed code", async () => {
    const { user, secret } = await userWithMfa();
    const code = codeFor(secret);
    const a = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    const b = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    if (a.ok !== "mfa" || b.ok !== "mfa") throw new Error("expected challenges");
    expect((await verifyChallenge(conn.app, a.challengeToken, code)).ok).toBe(true);
    expect(await verifyChallenge(conn.app, b.challengeToken, code)).toEqual({
      ok: false,
      reason: "invalid_code",
    });
  });

  it("accepts each recovery code once", async () => {
    const { user, recovery } = await userWithMfa();
    const a = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    const b = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    if (a.ok !== "mfa" || b.ok !== "mfa") throw new Error("expected challenges");
    expect((await verifyChallenge(conn.app, a.challengeToken, recovery[0]!.toLowerCase())).ok).toBe(true);
    expect((await verifyChallenge(conn.app, b.challengeToken, recovery[0]!)).ok).toBe(false);
    expect((await getMfaStatus(conn.app, user.id)).recoveryCodesRemaining).toBe(9);
  });

  it("limits attempts per challenge and counts failures towards the account throttle", async () => {
    const { user, secret } = await userWithMfa();
    const challenge = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    if (challenge.ok !== "mfa") throw new Error("expected challenge");
    for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS; i++)
      await verifyChallenge(conn.app, challenge.challengeToken, "000000");
    expect(await verifyChallenge(conn.app, challenge.challengeToken, codeFor(secret))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(MAX_CHALLENGE_ATTEMPTS).toBeGreaterThanOrEqual(MAX_FAILURES_PER_EMAIL);
    expect(await signIn(conn.app, { email: user.email, password: TEST_PASSWORD })).toEqual({
      ok: false,
      reason: "throttled",
    });
  });

  it("expires challenges", async () => {
    const { user, secret } = await userWithMfa();
    const past = new Date(Date.now() - 10 * 60 * 1000);
    const challenge = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD }, {}, past);
    if (challenge.ok !== "mfa") throw new Error("expected challenge");
    expect(await verifyChallenge(conn.app, challenge.challengeToken, codeFor(secret))).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("managing two-step verification", () => {
  it("regenerates recovery codes and turns off only with password and code", async () => {
    const { user, secret, recovery } = await userWithMfa();
    const fresh = await regenerateRecoveryCodes(conn.app, user.id, codeFor(secret));
    expect(fresh).not.toEqual(recovery);
    await expect(disableMfa(conn.app, user.id, "wrong-password", codeFor(secret, 1))).rejects.toMatchObject({
      field: "password",
    });
    await expect(disableMfa(conn.app, user.id, TEST_PASSWORD, recovery[0]!)).rejects.toMatchObject({
      field: "code",
    });
    await disableMfa(conn.app, user.id, TEST_PASSWORD, fresh[0]!);
    expect((await getMfaStatus(conn.app, user.id)).enabled).toBe(false);
    expect((await signIn(conn.app, { email: user.email, password: TEST_PASSWORD })).ok).toBe(true);
  });
});

describe("account", () => {
  it("changes the password and signs out other sessions only", async () => {
    const user = await createUser(conn.owner);
    const current = await createSession(conn.app, user.id);
    const other = await createSession(conn.app, user.id);
    const currentId = (await validateSessionToken(conn.app, current.token))!.sessionId;

    await expect(
      changePassword(conn.app, user.id, currentId, {
        currentPassword: "nope",
        newPassword: "another-strong-password",
      }),
    ).rejects.toMatchObject({ field: "currentPassword" });
    await changePassword(conn.app, user.id, currentId, {
      currentPassword: TEST_PASSWORD,
      newPassword: "another-strong-password",
    });

    expect(await validateSessionToken(conn.app, current.token)).not.toBeNull();
    expect(await validateSessionToken(conn.app, other.token)).toBeNull();
    expect((await signIn(conn.app, { email: user.email, password: "another-strong-password" })).ok).toBe(
      true,
    );
    expect((await signIn(conn.app, { email: user.email, password: TEST_PASSWORD })).ok).toBe(false);
  });

  it("signs out other sessions on request", async () => {
    const user = await createUser(conn.owner);
    const current = await createSession(conn.app, user.id);
    await createSession(conn.app, user.id);
    await createSession(conn.app, user.id);
    const currentId = (await validateSessionToken(conn.app, current.token))!.sessionId;
    expect(await signOutOtherSessions(conn.app, user.id, currentId)).toBe(2);
    expect(await validateSessionToken(conn.app, current.token)).not.toBeNull();
  });
});
