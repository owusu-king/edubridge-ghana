import { randomInt, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, notificationOutbox, parentSessions, parentSignInCodes } from "@/server/db/schema";
import { billTerm, getStudentAccount } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import { sendFeeReminders } from "@/server/fees/reminders";
import { TEMPLATES } from "@/server/notifications/templates";
import { readBalanceLink } from "@/server/parents/balance-links";
import { getParentChild, getParentReceipt, listParentChildren } from "@/server/parents/portal";
import { createParentSession, purgeParentSignIns, validateParentSession } from "@/server/parents/sessions";
import { CODE_LIMITS, requestParentCode, verifyParentCode } from "@/server/parents/sign-in";
import { addGuardian, setParentAccess, updateGuardian } from "@/server/students/guardians";
import { todayIn } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const DAY = 86_400_000;
/** A synthetic Ghanaian mobile number, unique enough per test run. */
const newPhone = () => `024 ${randomInt(100, 1000)} ${randomInt(1000, 10000)}`;
const e164 = (local: string) => normalizePhone(local)!;
const client = (ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`) => ({
  ipAddress: ip,
  userAgent: "test",
});

/** The code in the newest SMS queued to a number (read straight away, before any dispatch clears it). */
async function lastCode(phone: string): Promise<string | undefined> {
  const [row] = await conn.owner
    .select({ payload: notificationOutbox.payload })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.recipient, phone), eq(notificationOutbox.template, "phone_code")))
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(1);
  return (row?.payload as { code?: string } | undefined)?.code;
}

async function family(s: School, phone: string) {
  const ama = await s.add("Ama", s.classA);
  const kofi = await s.add("Kofi", s.classB);
  const other = await s.add("Yaw", s.classA);
  const { guardianId } = await addGuardian(conn.app, s.owner, ama.id, {
    fullName: "Akosua Mensah",
    phone,
    relationship: "mother",
  });
  await addGuardian(conn.app, s.owner, kofi.id, { fullName: "Akosua Mensah", phone, relationship: "mother" });
  await addGuardian(conn.app, s.owner, other.id, {
    fullName: "Someone Else",
    phone: newPhone(),
    relationship: "father",
  });
  await billTerm(conn.app, s.bursar, s.termId);
  return { ama, kofi, other, guardianId };
}

const pay = (s: School, studentId: string, amount: string) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    paidOn: todayIn(s.tenant.timezone),
    idempotencyKey: randomUUID(),
  });

describe("parent sign-in by SMS code", () => {
  it("texts a code only to numbers a school has on file, and signs in for 30 days", async () => {
    const s = await school();
    const local = newPhone();
    await family(s, local);
    const phone = e164(local);

    const known = await requestParentCode(conn.app, local, client());
    expect(known.phone).toBe(phone);
    const code = await lastCode(phone);
    expect(code).toMatch(/^\d{6}$/);

    // An unknown number gets the same answer, but no SMS (and so costs nothing).
    const strangerPhone = e164(newPhone());
    const unknown = await requestParentCode(conn.app, strangerPhone, client());
    expect(Object.keys(unknown).sort()).toEqual(["phone", "requestId"]);
    expect(await lastCode(strangerPhone)).toBeUndefined();
    await expect(verifyParentCode(conn.app, unknown.requestId, "123456")).rejects.toMatchObject({
      code: "parent_code_invalid",
    });

    const wrong = code === "000000" ? "000001" : "000000";
    await expect(verifyParentCode(conn.app, known.requestId, wrong)).rejects.toMatchObject({
      code: "parent_code_invalid",
    });
    const now = new Date();
    const signedIn = await verifyParentCode(
      conn.app,
      known.requestId,
      ` ${code!.slice(0, 3)} ${code!.slice(3)} `,
    );
    expect(signedIn.phone).toBe(phone);
    expect(signedIn.expiresAt.getTime() - now.getTime()).toBeGreaterThan(29 * DAY);
    expect(await validateParentSession(conn.app, signedIn.token)).toMatchObject({ phone, renewed: false });
    // Each code works once.
    await expect(verifyParentCode(conn.app, known.requestId, code)).rejects.toMatchObject({
      code: "parent_code_invalid",
    });
    await expect(requestParentCode(conn.app, "12345")).rejects.toMatchObject({ code: "phone_invalid" });
  });

  it("allows five tries per code, within ten minutes", async () => {
    const s = await school();
    const local = newPhone();
    await family(s, local);
    const first = await requestParentCode(conn.app, local, client());
    const code = (await lastCode(e164(local)))!;
    const wrong = code === "999999" ? "999998" : "999999";
    for (let i = 0; i < 5; i++)
      await expect(verifyParentCode(conn.app, first.requestId, wrong)).rejects.toThrow();
    await expect(verifyParentCode(conn.app, first.requestId, code)).rejects.toMatchObject({
      code: "parent_code_invalid",
    });

    const second = await requestParentCode(conn.app, local, client());
    const code2 = (await lastCode(e164(local)))!;
    const later = new Date(Date.now() + 11 * 60_000);
    await expect(verifyParentCode(conn.app, second.requestId, code2, {}, later)).rejects.toMatchObject({
      code: "parent_code_invalid",
    });
  });

  it("limits code requests per number, per network address and per school", async () => {
    const s = await school();
    const [a, b, c] = [newPhone(), newPhone(), newPhone()];
    for (const phone of [a, b, c]) await family(s, phone);

    const perPhone = { ...CODE_LIMITS, perPhone15Min: 2 };
    await requestParentCode(conn.app, a, client(), new Date(), perPhone);
    await requestParentCode(conn.app, a, client(), new Date(), perPhone);
    await expect(requestParentCode(conn.app, a, client(), new Date(), perPhone)).rejects.toMatchObject({
      code: "parent_code_throttled",
    });

    const ip = client();
    const perIp = { ...CODE_LIMITS, perIpHour: 1 };
    await requestParentCode(conn.app, b, ip, new Date(), perIp);
    await expect(requestParentCode(conn.app, c, ip, new Date(), perIp)).rejects.toMatchObject({
      code: "parent_code_throttled",
    });

    // The school's parents have now been sent 3 codes this hour (a twice, b once).
    const perSchool = { ...CODE_LIMITS, perSchoolHour: 3 };
    await expect(requestParentCode(conn.app, c, client(), new Date(), perSchool)).rejects.toMatchObject({
      code: "parent_code_throttled",
    });
    // A number no school knows is not counted against any school.
    await requestParentCode(conn.app, newPhone(), client(), new Date(), perSchool);
  });

  it("renews sessions in use, ends them after 30 days, and purges old rows", async () => {
    const phone = e164(newPhone());
    const { token } = await createParentSession(conn.app, phone);
    expect(await validateParentSession(conn.app, token, new Date(Date.now() + 20 * DAY))).toMatchObject({
      renewed: true,
    });
    const { token: idle } = await createParentSession(conn.app, phone);
    expect(await validateParentSession(conn.app, idle, new Date(Date.now() + 31 * DAY))).toBeNull();

    await purgeParentSignIns(conn.app, new Date(Date.now() + 60 * DAY));
    const left = await conn.owner.select().from(parentSessions).where(eq(parentSessions.phone, phone));
    expect(left).toHaveLength(0);
    expect(
      await conn.owner.select().from(parentSignInCodes).where(eq(parentSignInCodes.phone, phone)),
    ).toHaveLength(0);
  });
});

describe("what a parent sees", () => {
  it("lists each linked child at every school, with the same figures as the accountant", async () => {
    const local = newPhone();
    const phone = e164(local);
    const first = await school();
    const second = await school();
    const { ama, kofi, other } = await family(first, local);
    const { ama: secondAma } = await family(second, local);
    const paid = await pay(first, ama.id, "400");
    const otherPaid = await pay(first, other.id, "100");

    const schools = await listParentChildren(conn.app, phone);
    const mine = schools.filter((x) => [first.tenant.slug, second.tenant.slug].includes(x.slug));
    expect(mine).toHaveLength(2);
    const atFirst = mine.find((x) => x.slug === first.tenant.slug)!;
    expect(atFirst.children.map((c) => [c.firstName, c.balancePesewas, c.className])).toEqual([
      ["Ama", 60000, "Basic 4A"],
      ["Kofi", 100000, "Basic 4B"],
    ]);
    expect(atFirst.children[0]!.lastPayment).toEqual({
      paidOn: todayIn(first.tenant.timezone),
      amountPesewas: 40000,
    });
    expect(mine.find((x) => x.slug === second.tenant.slug)!.children.map((c) => c.firstName)).toEqual([
      "Ama",
      "Kofi",
    ]);

    // The parent's statement is the accountant's statement.
    const detail = (await getParentChild(conn.app, phone, first.tenant.slug, ama.id))!;
    expect(detail.account).toEqual(await getStudentAccount(conn.app, first.bursar, ama.id));
    expect(detail.payments.map((p) => p.receiptNumber)).toEqual([paid.receiptNumber]);

    // Not their child, a child at the other school under this school's address, or a bad id: nothing.
    expect(await getParentChild(conn.app, phone, first.tenant.slug, other.id)).toBeNull();
    expect(await getParentChild(conn.app, phone, first.tenant.slug, secondAma.id)).toBeNull();
    expect(await getParentChild(conn.app, phone, first.tenant.slug, "nope")).toBeNull();
    expect(await getParentChild(conn.app, e164(newPhone()), first.tenant.slug, ama.id)).toBeNull();

    expect(
      (await getParentReceipt(conn.app, phone, first.tenant.slug, paid.paymentId))!.receipt.receiptNumber,
    ).toBe(paid.receiptNumber);
    expect(await getParentReceipt(conn.app, phone, first.tenant.slug, otherPaid.paymentId)).toBeNull();
    expect(await getParentReceipt(conn.app, phone, second.tenant.slug, paid.paymentId)).toBeNull();
    void kofi;
  });

  it("applies the school's changes at once: blocking, a new number, unlinking", async () => {
    const s = await school();
    const local = newPhone();
    const phone = e164(local);
    const { ama, guardianId } = await family(s, local);
    const visible = async (p = phone) =>
      (await listParentChildren(conn.app, p)).some((x) => x.slug === s.tenant.slug);
    expect(await visible()).toBe(true);

    await expect(setParentAccess(conn.app, s.bursar, guardianId, { blocked: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await setParentAccess(conn.app, s.head, guardianId, { blocked: true });
    expect(await visible()).toBe(false);
    expect(await getParentChild(conn.app, phone, s.tenant.slug, ama.id)).toBeNull();
    // Blocked guardians are not sent sign-in codes either.
    await requestParentCode(conn.app, local, client());
    expect(await lastCode(phone)).toBeUndefined();

    await setParentAccess(conn.app, s.owner, guardianId, { blocked: false });
    expect(await visible()).toBe(true);
    const actions = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, guardianId)),
    );
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["guardian.parent_access_blocked", "guardian.parent_access_allowed"]),
    );

    const newLocal = newPhone();
    await updateGuardian(conn.app, s.owner, guardianId, { fullName: "Akosua Mensah", phone: newLocal });
    expect(await visible()).toBe(false);
    expect(await visible(e164(newLocal))).toBe(true);
  });
});

describe("balance links in fee reminders", () => {
  it("show the live balance for 7 days, only while the guardian keeps the number", async () => {
    const s = await school();
    const local = newPhone();
    const phone = e164(local);
    const { ama, guardianId } = await family(s, local);
    await sendFeeReminders(conn.app, s.bursar, { studentIds: [ama.id] });
    const [queued] = await conn.owner
      .select({ payload: notificationOutbox.payload })
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.recipient, phone), eq(notificationOutbox.template, "fee_reminder")));
    const payload = queued!.payload as Parameters<typeof TEMPLATES.fee_reminder>[0];
    const token = payload.balanceLinkToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const text = TEMPLATES.fee_reminder(payload).text;
    expect(text).toContain(`/b/${token}`);
    expect(text).toContain("Ama's school fees balance is GHS 1,000.00.");

    await pay(s, ama.id, "250");
    expect(await readBalanceLink(conn.app, token)).toMatchObject({
      schoolName: s.tenant.name,
      child: { firstName: "Ama", balancePesewas: 75000 },
    });
    expect(await readBalanceLink(conn.app, token, new Date(Date.now() + 8 * DAY))).toBeNull();
    expect(await readBalanceLink(conn.app, "A".repeat(22))).toBeNull();
    expect(await readBalanceLink(conn.app, "not a token")).toBeNull();

    await setParentAccess(conn.app, s.owner, guardianId, { blocked: true });
    expect(await readBalanceLink(conn.app, token)).toBeNull();
    await setParentAccess(conn.app, s.owner, guardianId, { blocked: false });
    expect(await readBalanceLink(conn.app, token)).not.toBeNull();
    await updateGuardian(conn.app, s.owner, guardianId, { fullName: "Akosua Mensah", phone: newPhone() });
    expect(await readBalanceLink(conn.app, token)).toBeNull();
  });
});
