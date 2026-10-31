import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { confirmPhoneVerification, removePhone, startPhoneVerification } from "@/server/auth/phone";
import { requestPasswordReset } from "@/server/auth/password-reset";
import { MAX_FAILURES_PER_EMAIL, signIn } from "@/server/auth/sign-in";
import { notificationOutbox } from "@/server/db/schema";
import { connect, createUser, TEST_PASSWORD } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

let counter = 0;
/** Unique, valid synthetic Ghanaian mobile numbers. */
const newPhone = () =>
  `+23324${String((Date.now() % 10_000_000) + counter++)
    .padStart(7, "0")
    .slice(-7)}`;

async function latestSms(phone: string, template: string) {
  const rows = await conn.owner
    .select()
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.recipient, phone), eq(notificationOutbox.template, template)));
  return rows.at(-1)!.payload as Record<string, string>;
}

async function verifiedUser() {
  const user = await createUser(conn.owner);
  const phone = newPhone();
  const { verificationId } = await startPhoneVerification(conn.app, user.id, phone.replace("+233", "0"));
  await confirmPhoneVerification(
    conn.app,
    user.id,
    verificationId,
    (await latestSms(phone, "phone_code")).code!,
  );
  return { user, phone };
}

describe("phone verification", () => {
  it("attaches the number only after the SMS code is confirmed", async () => {
    const user = await createUser(conn.owner);
    const phone = newPhone();
    const { verificationId, phone: normalized } = await startPhoneVerification(conn.app, user.id, phone);
    expect(normalized).toBe(phone);
    expect((await signIn(conn.app, { identifier: phone, password: TEST_PASSWORD })).ok).toBe(false);

    await expect(confirmPhoneVerification(conn.app, user.id, verificationId, "000000")).rejects.toMatchObject(
      { code: "phone_code_invalid" },
    );
    const { code } = await latestSms(phone, "phone_code");
    expect(code).toMatch(/^\d{6}$/);
    expect(await confirmPhoneVerification(conn.app, user.id, verificationId, code!)).toBe(phone);
    await expect(confirmPhoneVerification(conn.app, user.id, verificationId, code!)).rejects.toMatchObject({
      code: "phone_code_invalid",
    });
  });

  it("limits attempts per code and codes per hour, and rejects invalid or taken numbers", async () => {
    const user = await createUser(conn.owner);
    const phone = newPhone();
    const { verificationId } = await startPhoneVerification(conn.app, user.id, phone);
    const { code } = await latestSms(phone, "phone_code");
    for (let i = 0; i < 5; i++)
      await confirmPhoneVerification(conn.app, user.id, verificationId, "111111").catch(() => undefined);
    await expect(confirmPhoneVerification(conn.app, user.id, verificationId, code!)).rejects.toMatchObject({
      code: "phone_code_invalid",
    });

    await startPhoneVerification(conn.app, user.id, newPhone());
    await startPhoneVerification(conn.app, user.id, newPhone());
    await expect(startPhoneVerification(conn.app, user.id, newPhone())).rejects.toMatchObject({
      code: "phone_rate_limited",
    });

    const other = await createUser(conn.owner);
    await expect(startPhoneVerification(conn.app, other.id, "12345")).rejects.toMatchObject({
      field: "phone",
    });
    const { phone: taken } = await verifiedUser();
    await expect(startPhoneVerification(conn.app, other.id, taken)).rejects.toMatchObject({
      code: "phone_taken",
    });
  });

  it("other users cannot confirm someone else's code", async () => {
    const user = await createUser(conn.owner);
    const intruder = await createUser(conn.owner);
    const phone = newPhone();
    const { verificationId } = await startPhoneVerification(conn.app, user.id, phone);
    const { code } = await latestSms(phone, "phone_code");
    await expect(
      confirmPhoneVerification(conn.app, intruder.id, verificationId, code!),
    ).rejects.toMatchObject({ code: "phone_code_invalid" });
  });
});

describe("phone sign-in and recovery", () => {
  it("signs in with a verified number in local or international format", async () => {
    const { user, phone } = await verifiedUser();
    expect((await signIn(conn.app, { identifier: phone, password: TEST_PASSWORD })).ok).toBe(true);
    expect(
      (await signIn(conn.app, { identifier: phone.replace("+233", "0"), password: TEST_PASSWORD })).ok,
    ).toBe(true);
    await removePhone(conn.app, user.id);
    expect((await signIn(conn.app, { identifier: phone, password: TEST_PASSWORD })).ok).toBe(false);
  });

  it("counts failures per account whether email or phone was used", async () => {
    const { user, phone } = await verifiedUser();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await signIn(conn.app, { identifier: i % 2 ? user.email : phone, password: "wrong-password" });
    }
    expect(await signIn(conn.app, { identifier: phone, password: TEST_PASSWORD })).toEqual({
      ok: false,
      reason: "throttled",
    });
  });

  it("sends a reset link by SMS when requested with the phone number", async () => {
    const { phone } = await verifiedUser();
    await requestPasswordReset(conn.app, { identifier: phone });
    const payload = await latestSms(phone, "password_reset_sms");
    expect(payload.token).toBeTruthy();
  });

  it("rejects malformed identifiers", async () => {
    await expect(signIn(conn.app, { identifier: "not-an-email-or-phone", password: "x" })).rejects.toThrow();
  });
});
