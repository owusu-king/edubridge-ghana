import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSession,
  revokeSessionToken,
  SESSION_LIFETIME_MS,
  validateSessionToken,
} from "@/server/auth/sessions";
import { MAX_FAILURES_PER_EMAIL, signIn } from "@/server/auth/sign-in";
import { sessionIdFromToken } from "@/server/auth/tokens";
import { sessions, users } from "@/server/db/schema";
import { connect, createUser, TEST_PASSWORD } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());
const DAY = 24 * 60 * 60 * 1000;

describe("sessions", () => {
  it("validates a fresh session and stores only the token hash", async () => {
    const user = await createUser(conn.owner);
    const { token } = await createSession(conn.app, user.id);
    const [row] = await conn.owner.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(row?.id).toBe(sessionIdFromToken(token));
    expect(row?.id).not.toBe(token);

    const session = await validateSessionToken(conn.app, token);
    expect(session?.user).toEqual({ id: user.id, email: user.email, name: user.name });
    expect(session?.renewed).toBe(false);
  });

  it("rejects unknown, expired and revoked tokens", async () => {
    const user = await createUser(conn.owner);
    expect(await validateSessionToken(conn.app, "not-a-real-token")).toBeNull();

    const past = new Date(Date.now() - SESSION_LIFETIME_MS - DAY);
    const expired = await createSession(conn.app, user.id, {}, past);
    expect(await validateSessionToken(conn.app, expired.token)).toBeNull();

    const live = await createSession(conn.app, user.id);
    await revokeSessionToken(conn.app, live.token);
    expect(await validateSessionToken(conn.app, live.token)).toBeNull();
  });

  it("renews sessions past the halfway point", async () => {
    const user = await createUser(conn.owner);
    const created = new Date(Date.now() - 10 * DAY);
    const { token } = await createSession(conn.app, user.id, {}, created);
    const session = await validateSessionToken(conn.app, token);
    expect(session?.renewed).toBe(true);
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_LIFETIME_MS - DAY);
  });

  it("rejects sessions of disabled users", async () => {
    const user = await createUser(conn.owner);
    const { token } = await createSession(conn.app, user.id);
    await conn.owner.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    expect(await validateSessionToken(conn.app, token)).toBeNull();
  });
});

describe("sign-in", () => {
  it("signs in with valid credentials and records the login time", async () => {
    const user = await createUser(conn.owner);
    const result = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    expect(result.ok).toBe(true);
    if (result.ok) expect(await validateSessionToken(conn.app, result.token)).not.toBeNull();
    const [row] = await conn.owner.select().from(users).where(eq(users.id, user.id));
    expect(row?.lastLoginAt).not.toBeNull();
  });

  it("matches email case-insensitively", async () => {
    const user = await createUser(conn.owner);
    const result = await signIn(conn.app, { email: user.email.toUpperCase(), password: TEST_PASSWORD });
    expect(result.ok).toBe(true);
  });

  it("returns the same error for a wrong password and an unknown email", async () => {
    const user = await createUser(conn.owner);
    const wrong = await signIn(conn.app, { email: user.email, password: "wrong password!" });
    const unknown = await signIn(conn.app, { email: "nobody@example.test", password: "whatever-pass" });
    expect(wrong).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(unknown).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("throttles repeated failures for an email, even with the right password", async () => {
    const user = await createUser(conn.owner);
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await signIn(conn.app, { email: user.email, password: "wrong password!" });
    }
    const result = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    expect(result).toEqual({ ok: false, reason: "throttled" });
  });

  it("refuses disabled accounts", async () => {
    const user = await createUser(conn.owner);
    await conn.owner.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    const result = await signIn(conn.app, { email: user.email, password: TEST_PASSWORD });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });
});
