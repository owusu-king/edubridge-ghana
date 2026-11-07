import { randomInt, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { updateSubscription } from "@/server/billing/subscriptions";
import { withTenant } from "@/server/db/context";
import { feeReminders, notificationOutbox, smsUsage, tenants } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import { runAutoReminders } from "@/server/fees/reminders";
import {
  listAnnouncements,
  listAudiences,
  listParentAnnouncements,
  openParentSchoolNews,
  postAnnouncement,
} from "@/server/messages/announcements";
import { listStudentMessages } from "@/server/messages/history";
import { getParentChild } from "@/server/parents/portal";
import { updateEntitlements } from "@/server/platform/service";
import { addGuardian, setParentAccess } from "@/server/students/guardians";
import { saveMessageSettings, saveSchoolContacts } from "@/server/tenancy/preferences";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { FEATURES } from "@/lib/plan";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);
const fresh = (s: School, c: TenantContext) =>
  resolveTenantContext(conn.app, s.tenant.slug, c.userId) as Promise<TenantContext>;
const randomPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const e164 = (phone: string) => normalizePhone(phone)!;

const pay = (s: School, studentId: string, amount: string) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    reference: "",
    paidOn: todayIn(s.tenant.timezone),
    idempotencyKey: randomUUID(),
  });

const messageSettings = (overrides: Record<string, unknown> = {}) => ({
  paymentReceiptSms: false,
  autoRemindersEnabled: false,
  autoReminderIntervalDays: "14",
  autoReminderMin: "100",
  ...overrides,
});

const usageOf = (s: School, kind: (typeof smsUsage.$inferSelect)["kind"]) =>
  asSchool(s, (tx) =>
    tx
      .select({ studentId: smsUsage.studentId, outboxId: smsUsage.outboxId })
      .from(smsUsage)
      .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, kind))),
  );

/** A school with Ama (guardian phone) in Basic 4A and Kofi (another phone) in Basic 4B, both billed. */
async function setUp() {
  const s = await school();
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classB)).id;
  const amaPhone = randomPhone();
  const kofiPhone = randomPhone();
  const amaGuardian = await addGuardian(conn.app, s.owner, ama, {
    fullName: "Ama's mother",
    phone: amaPhone,
    relationship: "mother",
  });
  await addGuardian(conn.app, s.owner, kofi, {
    fullName: "Kofi's father",
    phone: kofiPhone,
    relationship: "father",
  });
  await billTerm(conn.app, s.bursar, s.termId);
  return { s, ama, kofi, amaPhone: e164(amaPhone), kofiPhone: e164(kofiPhone), amaGuardian };
}

describe("payment receipt SMS", () => {
  it("is sent only when the school turns it on, and shows in the family's message history", async () => {
    const { s, ama, amaPhone } = await setUp();
    await pay(s, ama, "100");
    expect(await usageOf(s, "payment_receipt")).toHaveLength(0);

    await saveMessageSettings(conn.app, s.bursar, messageSettings({ paymentReceiptSms: true }));
    const { receiptNumber } = await pay(s, ama, "250");
    const usage = await usageOf(s, "payment_receipt");
    expect(usage).toEqual([{ studentId: ama, outboxId: expect.any(String) }]);
    const [sms] = await asSchool(s, (tx) =>
      tx.select().from(notificationOutbox).where(eq(notificationOutbox.id, usage[0]!.outboxId)),
    );
    expect(sms).toMatchObject({ channel: "sms", recipient: amaPhone, template: "payment_receipt" });
    expect(sms!.payload).toMatchObject({ amountPesewas: 25_000, receiptNumber, balancePesewas: 65_000 });

    const history = await listStudentMessages(conn.app, s.head, ama);
    expect(history).toEqual([expect.objectContaining({ kind: "payment_receipt", recipient: amaPhone })]);
    await expect(listStudentMessages(conn.app, s.teacher, ama)).rejects.toThrow(ForbiddenError);
  });

  it("is skipped while SMS are paused, and for demo schools, without stopping the payment", async () => {
    const { s, ama } = await setUp();
    await saveMessageSettings(conn.app, s.bursar, messageSettings({ paymentReceiptSms: true }));
    const admin = await platform;
    await updateSubscription(conn.app, admin.id, s.tenant.id, {
      status: "past_due",
      billingPeriod: "termly",
      smsPrice: "0.04",
    });
    expect((await pay(s, ama, "100")).receiptNumber).toBeTruthy();
    expect(await usageOf(s, "payment_receipt")).toHaveLength(0);

    await updateSubscription(conn.app, admin.id, s.tenant.id, {
      status: "active",
      billingPeriod: "termly",
      smsPrice: "0.04",
    });
    await conn.owner.update(tenants).set({ isDemo: true }).where(eq(tenants.id, s.tenant.id));
    await pay(s, ama, "100");
    expect(await usageOf(s, "payment_receipt")).toHaveLength(0);
  });

  it("only the Proprietor and Accountant change it", async () => {
    const { s } = await setUp();
    await expect(saveMessageSettings(conn.app, s.head, messageSettings())).rejects.toThrow(ForbiddenError);
    await expect(
      saveMessageSettings(conn.app, s.owner, messageSettings({ autoReminderIntervalDays: "3" })),
    ).rejects.toThrow();
  });
});

describe("automatic fee reminders", () => {
  const remindersFor = (s: School) =>
    asSchool(s, (tx) =>
      tx
        .select({ studentId: feeReminders.studentId })
        .from(feeReminders)
        .where(eq(feeReminders.tenantId, s.tenant.id)),
    );

  it("go once a day after 9:00 to families owing at least the minimum, then wait the interval", async () => {
    const { s, ama, kofi } = await setUp();
    const today = todayIn(s.tenant.timezone);
    // Kofi owes GH₵50, under the GH₵100 minimum.
    await pay(s, kofi, "950");
    const at = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);

    // Off by default.
    await runAutoReminders(conn.app, at(today, 10));
    expect(await remindersFor(s)).toHaveLength(0);

    await saveMessageSettings(conn.app, s.bursar, messageSettings({ autoRemindersEnabled: true }));
    await runAutoReminders(conn.app, at(today, 8));
    expect(await remindersFor(s)).toHaveLength(0);

    await runAutoReminders(conn.app, at(today, 10));
    expect(await remindersFor(s)).toEqual([{ studentId: ama }]);
    // Once a day, even if run again.
    await runAutoReminders(conn.app, at(today, 11));
    expect(await remindersFor(s)).toHaveLength(1);
    // Not again the next day: Ama was reminded within the 14-day interval.
    await runAutoReminders(conn.app, at(addDays(today, 1), 10));
    expect(await remindersFor(s)).toHaveLength(1);
    expect(await usageOf(s, "fee_reminder")).toHaveLength(1);
  });

  it("are not sent when the plan leaves out fee reminders", async () => {
    const { s } = await setUp();
    const admin = await platform;
    await updateEntitlements(conn.app, admin.id, s.tenant.id, {
      planName: "Basic",
      maxCampuses: 2,
      maxStudents: null,
      maxSmsPerMonth: null,
      features: FEATURES.filter((f) => f !== "fee_reminders"),
    });
    await saveMessageSettings(
      conn.app,
      await fresh(s, s.bursar),
      messageSettings({ autoRemindersEnabled: true }),
    );
    await runAutoReminders(conn.app, new Date(`${todayIn(s.tenant.timezone)}T10:00:00Z`));
    expect(await remindersFor(s)).toHaveLength(0);
  });
});

describe("announcements", () => {
  it("reach the chosen families, who read them in the parent view", async () => {
    const { s, amaPhone, kofiPhone } = await setUp();
    const audiences = await listAudiences(conn.app, s.head);
    const families = (label: string) => audiences.find((a) => a.label === label)?.families;
    expect(families("The whole school")).toBe(2);
    expect(families("Basic 4A")).toBe(1);
    expect(families("Basic 4")).toBe(2);
    expect(families("East campus")).toBe(1);

    const basic4a = audiences.find((a) => a.label === "Basic 4A")!;
    const posted = await postAnnouncement(conn.app, s.head, {
      title: "Basic 4A trip",
      body: "The class visits the museum on Friday.",
      audience: "class",
      audienceId: basic4a.id,
      sms: true,
    });
    expect(posted.sms).toBe(1);
    await postAnnouncement(conn.app, s.head, {
      title: "Mid-term break",
      body: "School closes on Thursday.",
      audience: "school",
      audienceId: null,
      sms: false,
    });
    expect(await usageOf(s, "announcement")).toHaveLength(1);

    const titles = async (phone: string) =>
      (await listParentAnnouncements(conn.app, phone))
        .find((n) => n.slug === s.tenant.slug)
        ?.announcements.map((a) => a.title);
    expect(await titles(amaPhone)).toEqual(["Mid-term break", "Basic 4A trip"]);
    expect(await titles(kofiPhone)).toEqual(["Mid-term break"]);

    const unread = async (phone: string) =>
      (await listParentAnnouncements(conn.app, phone)).find((n) => n.slug === s.tenant.slug)?.unread;
    expect(await unread(amaPhone)).toBe(2);
    const opened = await openParentSchoolNews(conn.app, amaPhone, s.tenant.slug);
    // Shown as new on this visit, read from then on.
    expect(opened!.announcements.map((a) => a.read)).toEqual([false, false]);
    expect(await unread(amaPhone)).toBe(0);
    expect(await unread(kofiPhone)).toBe(1);
    expect((await listAnnouncements(conn.app, s.head)).map((a) => [a.title, a.reads])).toEqual([
      ["Mid-term break", 1],
      ["Basic 4A trip", 1],
    ]);
    // A number the school does not have sees nothing.
    expect(await openParentSchoolNews(conn.app, e164(randomPhone()), s.tenant.slug)).toBeNull();
  });

  it("leave out guardians the school stopped using the parent view", async () => {
    const { s, amaPhone, amaGuardian } = await setUp();
    await setParentAccess(conn.app, s.owner, amaGuardian.guardianId, { blocked: true });
    expect((await listAudiences(conn.app, s.head)).find((a) => a.audience === "school")!.families).toBe(1);
    const posted = await postAnnouncement(conn.app, s.head, {
      title: "Sports day",
      body: "Saturday at 8:00.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    expect(posted.sms).toBe(1);
    expect(await openParentSchoolNews(conn.app, amaPhone, s.tenant.slug)).toBeNull();
  });

  it("refuse SMS beyond the plan's monthly limit, but post without SMS", async () => {
    const { s } = await setUp();
    const admin = await platform;
    await updateEntitlements(conn.app, admin.id, s.tenant.id, {
      planName: "Starter",
      maxCampuses: 2,
      maxStudents: null,
      maxSmsPerMonth: 1,
      features: [...FEATURES],
    });
    const head = await fresh(s, s.head);
    const input = { title: "Fees", body: "Fees are due.", audience: "school", audienceId: null };
    await expect(postAnnouncement(conn.app, head, { ...input, sms: true })).rejects.toMatchObject({
      code: "sms_limit",
    });
    expect((await postAnnouncement(conn.app, head, { ...input, sms: false })).sms).toBe(0);
  });

  it("send no SMS for demo schools, and need communication.send", async () => {
    const { s } = await setUp();
    const input = { title: "Fees", body: "Fees are due.", audience: "school", audienceId: null, sms: true };
    await expect(postAnnouncement(conn.app, s.bursar, input)).rejects.toThrow(ForbiddenError);
    await expect(postAnnouncement(conn.app, s.teacher, input)).rejects.toThrow(ForbiddenError);
    await expect(
      postAnnouncement(conn.app, s.head, { ...input, audience: "class", audienceId: null }),
    ).rejects.toMatchObject({ code: "audience_invalid" });
    await conn.owner.update(tenants).set({ isDemo: true }).where(eq(tenants.id, s.tenant.id));
    expect((await postAnnouncement(conn.app, await fresh(s, s.head), input)).sms).toBe(0);
    expect(await usageOf(s, "announcement")).toHaveLength(0);
  });
});

describe("school contact details", () => {
  it("are set by the Proprietor and shown to families", async () => {
    const { s, ama, amaPhone } = await setUp();
    expect((await getParentChild(conn.app, amaPhone, s.tenant.slug, ama))!.contacts).toBeNull();
    await expect(
      saveSchoolContacts(conn.app, s.owner, {
        contactPhone: "12",
        contactEmail: "",
        contactWhatsapp: "",
        officeHours: "",
      }),
    ).rejects.toThrow();
    await expect(
      saveSchoolContacts(conn.app, s.bursar, {
        contactPhone: "030 123 4567",
        contactEmail: "",
        contactWhatsapp: "",
        officeHours: "",
      }),
    ).rejects.toThrow(ForbiddenError);
    await saveSchoolContacts(conn.app, s.owner, {
      contactPhone: "030 123 4567",
      contactEmail: " Office@Example.com ",
      contactWhatsapp: "024 123 4567",
      officeHours: "Weekdays 7:30 to 4:00",
    });
    const contacts = { phone: "+233301234567", whatsapp: "+233241234567", email: "office@example.com" };
    expect((await getParentChild(conn.app, amaPhone, s.tenant.slug, ama))!.contacts).toEqual({
      ...contacts,
      officeHours: "Weekdays 7:30 to 4:00",
    });
    expect((await openParentSchoolNews(conn.app, amaPhone, s.tenant.slug))!.contacts).toMatchObject(contacts);
  });
});
