import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import {
  auditEvents,
  feeReminders,
  notificationOutbox,
  paymentPlanInstalments,
  paymentPlans,
} from "@/server/db/schema";
import { pgErrorCode } from "@/server/errors";
import { billTerm } from "@/server/fees/ledger";
import { listOwing } from "@/server/fees/owing";
import { recordPayment } from "@/server/fees/payments";
import { getReminderState, MAX_REMINDERS_PER_SEND, sendFeeReminders } from "@/server/fees/reminders";
import { addGuardian } from "@/server/students/guardians";
import { todayIn } from "@/lib/format";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

let phoneCounter = 0;
const phone = () =>
  `024 ${String(Date.now() % 1000).padStart(3, "0")} ${String(phoneCounter++ % 10000).padStart(4, "0")}`;

async function family(s: School) {
  const ama = await s.add("Ama", s.classA);
  const kofi = await s.add("Kofi", s.classA);
  const esi = await s.add("Esi", s.classB);
  const yaw = await s.add("Yaw", s.classA);
  await addGuardian(conn.app, s.owner, ama.id, {
    fullName: "Akosua Mensah",
    phone: phone(),
    relationship: "mother",
  });
  // Kofi's primary contact has no phone; his father does.
  await addGuardian(conn.app, s.owner, kofi.id, {
    fullName: "Abena Mensah",
    email: "abena@example.test",
    relationship: "mother",
  });
  await addGuardian(conn.app, s.owner, kofi.id, {
    fullName: "Kwame Mensah",
    phone: phone(),
    relationship: "father",
  });
  await addGuardian(conn.app, s.owner, esi.id, {
    fullName: "Efua Mensah",
    phone: phone(),
    relationship: "mother",
  });
  // Yaw has no guardian at all.
  await billTerm(conn.app, s.bursar, s.termId);
  return { ama, kofi, esi, yaw };
}

const pay = (s: School, studentId: string, amount: string) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    paidOn: todayIn(s.tenant.timezone),
    idempotencyKey: randomUUID(),
  });

/** A plan whose first instalment fell due last week (the service only allows future dates). */
async function overduePlan(s: School, studentId: string) {
  await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, async (tx) => {
    const [plan] = await tx
      .insert(paymentPlans)
      .values({ tenantId: s.tenant.id, studentId, totalPesewas: 60000, startsOn: "2026-09-01" })
      .returning({ id: paymentPlans.id });
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    await tx.insert(paymentPlanInstalments).values([
      { tenantId: s.tenant.id, planId: plan!.id, sequence: 1, dueOn: lastWeek, amountPesewas: 30000 },
      { tenantId: s.tenant.id, planId: plan!.id, sequence: 2, dueOn: "2099-01-01", amountPesewas: 30000 },
    ]);
  });
}

describe("who owes what", () => {
  it("lists students who owe, largest first, with contact, last payment and plan progress", async () => {
    const s = await school();
    const { ama, kofi, esi, yaw } = await family(s);
    await pay(s, ama.id, "400");
    await pay(s, yaw.id, "1000");
    await overduePlan(s, kofi.id);

    const page = await listOwing(conn.app, s.head, {});
    expect(page.rows.map((r) => [r.name, r.balancePesewas])).toEqual([
      // Equal balances are ordered by name.
      ["Esi Mensah", 100000],
      ["Kofi Mensah", 100000],
      ["Ama Mensah", 60000],
    ]);
    expect(page).toMatchObject({ total: 3, owedPesewas: 260000, withoutPhone: 0 });
    const byName = Object.fromEntries(page.rows.map((r) => [r.firstName, r]));
    expect(byName.Kofi!.contact).toMatchObject({ name: "Kwame Mensah" });
    expect(byName.Kofi!.plan).toMatchObject({ overduePesewas: 30000, remainingPesewas: 60000 });
    expect(byName.Ama!.lastPaidOn).toBe(todayIn(s.tenant.timezone));
    expect(byName.Esi).toMatchObject({ lastPaidOn: null, plan: null, className: "Basic 4B" });
    expect(page.rows.find((r) => r.studentId === yaw.id)).toBeUndefined();
    void esi;
  });

  it("filters by class, minimum amount and overdue plans, and keeps campus scope", async () => {
    const s = await school();
    const { ama, kofi, yaw } = await family(s);
    await pay(s, ama.id, "400");
    await pay(s, yaw.id, "1000");
    await overduePlan(s, kofi.id);
    const names = async (ctx: School["bursar"], input: object) =>
      (await listOwing(conn.app, ctx, input)).rows.map((r) => r.firstName);

    expect(await names(s.bursar, { classId: s.classB })).toEqual(["Esi"]);
    expect(await names(s.bursar, { minAmount: "700" })).toEqual(["Esi", "Kofi"]);
    expect(await names(s.bursar, { minAmount: "600" })).toEqual(["Esi", "Kofi", "Ama"]);
    expect(await names(s.bursar, { overdueOnly: true })).toEqual(["Kofi"]);
    expect(await names(s.eastBursar, {})).toEqual(["Esi"]);
    await expect(listOwing(conn.app, s.bursar, { minAmount: "lots" })).rejects.toBeInstanceOf(ZodError);
    await expect(listOwing(conn.app, s.teacher, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("SMS fee reminders", () => {
  it("queues one SMS per family, with the amount, and skips who cannot be reminded", async () => {
    const s = await school();
    const { ama, kofi, esi, yaw } = await family(s);
    await pay(s, esi.id, "1000");

    const result = await sendFeeReminders(conn.app, s.bursar, {
      studentIds: [ama.id, kofi.id, esi.id, yaw.id, ama.id],
    });
    expect(result.sent).toBe(2);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { studentId: esi.id, reason: "not_owing" },
        { studentId: yaw.id, reason: "no_phone" },
      ]),
    );

    const reminders = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select().from(feeReminders).where(eq(feeReminders.tenantId, s.tenant.id)),
    );
    expect(reminders).toHaveLength(2);
    expect(
      reminders.every((r) => r.balancePesewas === 100000 && r.sentOn === todayIn(s.tenant.timezone)),
    ).toBe(true);
    const messages = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.template, "fee_reminder"),
          inArray(
            notificationOutbox.recipient,
            reminders.map((r) => r.recipient),
          ),
        ),
      );
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => (m.payload as { studentFirstName: string }).studentFirstName).sort()).toEqual([
      "Ama",
      "Kofi",
    ]);
    // The balance goes in the message, and is recorded with the reminder too.
    expect(messages.every((m) => (m.payload as { balancePesewas: number }).balancePesewas === 100000)).toBe(
      true,
    );

    // Kofi's reminder went to his father, who has a phone.
    expect((await getReminderState(conn.app, s.bursar, kofi.id))!).toMatchObject({
      contact: { name: "Kwame Mensah" },
      remindedToday: true,
    });

    const [audit] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "fees.reminders_sent")),
    );
    expect(audit!.metadata).toMatchObject({ count: 2 });
  });

  it("sends at most one reminder a day, even when sent twice at once", async () => {
    const s = await school();
    const { ama } = await family(s);
    const results = await Promise.all([
      sendFeeReminders(conn.app, s.bursar, { studentIds: [ama.id] }),
      sendFeeReminders(conn.app, s.owner, { studentIds: [ama.id] }),
    ]).catch((error: unknown) => {
      // Two transactions can race on the daily unique index; the loser rolls back entirely.
      expect(pgErrorCode(error)).toBe("23505");
      return null;
    });
    if (results) expect(results.map((r) => r.sent).sort()).toEqual([0, 1]);
    expect(await sendFeeReminders(conn.app, s.bursar, { studentIds: [ama.id] })).toEqual({
      sent: 0,
      skipped: [{ studentId: ama.id, reason: "already_today" }],
    });
  });

  it("skips families without a phone, and students out of the sender's scope", async () => {
    const s = await school();
    const { ama, esi } = await family(s);
    const noPhone = await s.add("Adwoa", s.classA);
    await addGuardian(conn.app, s.owner, noPhone.id, {
      fullName: "Adwoa's Aunt",
      email: "aunt@example.test",
      relationship: "guardian",
    });
    await billTerm(conn.app, s.bursar, s.termId);
    expect(await sendFeeReminders(conn.app, s.eastBursar, { studentIds: [ama.id, esi.id] })).toEqual({
      sent: 1,
      skipped: [{ studentId: ama.id, reason: "not_found" }],
    });
    expect(await sendFeeReminders(conn.app, s.bursar, { studentIds: [noPhone.id] })).toEqual({
      sent: 0,
      skipped: [{ studentId: noPhone.id, reason: "no_phone" }],
    });
  });

  it("is limited to finance staff and to a sensible batch size; records cannot change", async () => {
    const s = await school();
    const { ama } = await family(s);
    await expect(sendFeeReminders(conn.app, s.head, { studentIds: [ama.id] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(sendFeeReminders(conn.app, s.bursar, { studentIds: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(
      sendFeeReminders(conn.app, s.bursar, {
        studentIds: Array.from({ length: MAX_REMINDERS_PER_SEND + 1 }, () => randomUUID()),
      }),
    ).rejects.toBeInstanceOf(ZodError);

    await sendFeeReminders(conn.app, s.bursar, { studentIds: [ama.id] });
    const change = withTenant(conn.app, { tenantId: s.tenant.id, userId: s.bursar.userId }, (tx) =>
      tx.update(feeReminders).set({ balancePesewas: 1 }).where(eq(feeReminders.studentId, ama.id)),
    );
    expect(await change.then(() => null, pgErrorCode)).not.toBeNull();
  });
});
