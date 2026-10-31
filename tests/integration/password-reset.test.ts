import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { isResetTokenValid, requestPasswordReset, resetPassword } from "@/server/auth/password-reset";
import { createSession, validateSessionToken } from "@/server/auth/sessions";
import { signIn } from "@/server/auth/sign-in";
import { notificationOutbox, passwordResets } from "@/server/db/schema";
import { connect, createUser, TEST_PASSWORD } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

/** The reset token travels only in the queued email; tests read it from the outbox payload. */
async function latestToken(email: string): Promise<string> {
  const rows = await conn.owner
    .select()
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.recipient, email), eq(notificationOutbox.template, "password_reset")));
  return (rows.at(-1)!.payload as { token: string }).token;
}

describe("password reset", () => {
  it("emails a single-use link that sets a new password and signs out every session", async () => {
    const user = await createUser(conn.owner);
    const session = await createSession(conn.app, user.id);
    await requestPasswordReset(conn.app, { email: user.email.toUpperCase() });
    const token = await latestToken(user.email);
    expect(await isResetTokenValid(conn.app, token)).toBe(true);

    await expect(resetPassword(conn.app, token, { password: "short" })).rejects.toThrow();
    await resetPassword(conn.app, token, { password: "a-brand-new-password" });
    expect(await validateSessionToken(conn.app, session.token)).toBeNull();
    expect((await signIn(conn.app, { email: user.email, password: "a-brand-new-password" })).ok).toBe(true);
    expect((await signIn(conn.app, { email: user.email, password: TEST_PASSWORD })).ok).toBe(false);
    await expect(resetPassword(conn.app, token, { password: "another-new-password" })).rejects.toMatchObject({
      code: "reset_invalid",
    });
  });

  it("says nothing about unknown emails and queues nothing", async () => {
    const email = "nobody-at-all@example.test";
    await expect(requestPasswordReset(conn.app, { email })).resolves.toBeUndefined();
    const rows = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipient, email));
    expect(rows).toHaveLength(0);
  });

  it("limits requests per account", async () => {
    const user = await createUser(conn.owner);
    for (let i = 0; i < 5; i++)
      await requestPasswordReset(conn.app, { email: user.email }, { ipAddress: "192.0.2.10" });
    const rows = await conn.owner.select().from(passwordResets).where(eq(passwordResets.userId, user.id));
    expect(rows).toHaveLength(3);
  });

  it("consumes all outstanding links when one is used, and rejects expired links", async () => {
    const user = await createUser(conn.owner);
    await requestPasswordReset(conn.app, { email: user.email });
    const first = await latestToken(user.email);
    await requestPasswordReset(conn.app, { email: user.email });
    const second = await latestToken(user.email);
    await resetPassword(conn.app, second, { password: "a-brand-new-password" });
    expect(await isResetTokenValid(conn.app, first)).toBe(false);

    const other = await createUser(conn.owner);
    const past = new Date(Date.now() - 31 * 60_000);
    await requestPasswordReset(conn.app, { email: other.email }, {}, past);
    expect(await isResetTokenValid(conn.app, await latestToken(other.email))).toBe(false);
  });
});
