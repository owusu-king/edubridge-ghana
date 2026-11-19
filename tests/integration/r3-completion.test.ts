import { randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listLevelsWithClasses } from "@/server/academics/classes";
import { confirmOnlineApplication, startOnlineApplication } from "@/server/admissions/online";
import { createSession, revokeSessionToken, validateSessionToken } from "@/server/auth/sessions";
import {
  confirmInvoicePayment,
  mockInvoicePayments,
  startInvoicePayment,
  type InvoicePaymentProvider,
} from "@/server/billing/online-payments";
import {
  getSchoolBilling,
  issueSubscriptionInvoice,
  markSubscriptionInvoicePaid,
  updateSubscription,
} from "@/server/billing/subscriptions";
import { smsUsedThisMonth } from "@/server/billing/usage";
import { withTenant } from "@/server/db/context";
import {
  announcements,
  notificationOutbox,
  pushSubscriptions,
  scheduledAnnouncements,
  subscriptionInvoices,
  tenantEntitlements,
} from "@/server/db/schema";
import {
  cancelScheduledAnnouncement,
  listScheduledAnnouncements,
  postAnnouncement,
  runScheduledAnnouncements,
} from "@/server/messages/announcements";
import { getDeliveryReport } from "@/server/messages/delivery";
import { dispatchPending, whatsappOptedIn } from "@/server/notifications/outbox";
import type { Providers } from "@/server/notifications/providers";
import { saveStaffPushSubscription } from "@/server/notifications/staff-push";
import { WhatsAppError, type WhatsAppProvider } from "@/server/notifications/whatsapp";
import { handleWhatsAppWebhook } from "@/server/notifications/whatsapp-webhook";
import { getWhatsAppChoice, setWhatsAppChoice } from "@/server/parents/whatsapp";
import { updateEntitlements } from "@/server/platform/service";
import { addGuardian } from "@/server/students/guardians";
import { saveOnlineApplications } from "@/server/tenancy/preferences";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { FEATURES } from "@/lib/plan";
import { normalizePhone } from "@/lib/phone";
import { todayIn } from "@/lib/format";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = "BA" + randomBytes(60).toString("base64url");
});
afterAll(async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  await conn.close();
});

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const randomPhone = () => normalizePhone(`024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`)!;
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The school's plan, with or without the WhatsApp module; returns fresh contexts. */
async function withPlan(s: School, whatsapp: boolean) {
  const admin = await platform;
  await updateEntitlements(conn.app, admin.id, s.tenant.id, {
    planName: "Standard",
    maxCampuses: 2,
    maxStudents: null,
    maxSmsPerMonth: null,
    features: FEATURES.filter((f) => whatsapp || f !== "whatsapp"),
  });
  const ctx = async (c: TenantContext) =>
    (await resolveTenantContext(conn.app, s.tenant.slug, c.userId)) as TenantContext;
  return { owner: await ctx(s.owner), head: await ctx(s.head) };
}

async function family(s: School, name: string) {
  const student = await s.add(name, s.classA);
  const phone = randomPhone();
  await addGuardian(conn.app, s.owner, student.id, {
    fullName: `${name}'s mother`,
    phone,
    relationship: "mother",
  });
  return phone;
}

function providers(
  whatsapp: WhatsAppProvider | null,
): Providers & { sms: { sendSms: ReturnType<typeof vi.fn> } } {
  const never = async () => {
    throw new Error("not expected");
  };
  return {
    email: { name: "fake", sendEmail: never },
    sms: { name: "fake", sendSms: vi.fn(async () => ({ messageId: `sms-${randomInt(1e9)}` })) },
    push: { name: "fake", sendPush: vi.fn(async () => ({ messageId: "push-1" })) },
    whatsapp,
  };
}

const fakeWhatsApp = (fail = false) => {
  const calls: { to: string; template: string; params: string[] }[] = [];
  const provider: WhatsAppProvider = {
    name: "fake-whatsapp",
    async sendTemplate(m) {
      calls.push({ to: m.to, template: m.template, params: m.params });
      if (fail) throw new WhatsAppError("WhatsApp refused the message (400, code 131026).");
      return { messageId: `wamid.${randomBytes(8).toString("hex")}` };
    },
  };
  return { provider, calls };
};

const messagesTo = (phones: string[], template: string) =>
  conn.owner
    .select()
    .from(notificationOutbox)
    .where(and(inArray(notificationOutbox.recipient, phones), eq(notificationOutbox.template, template)));

describe("WhatsApp (WAB-01)", () => {
  it("sends family messages by WhatsApp to numbers that opted in, by SMS to the rest, and bills each its own way", async () => {
    const s = await school();
    const { head, owner } = await withPlan(s, true);
    const opted = await family(s, "Ama");
    const smsOnly = await family(s, "Esi");
    expect(await getWhatsAppChoice(conn.app, opted)).toMatchObject({ offered: true, on: false });
    await setWhatsAppChoice(conn.app, opted, { on: true });
    expect(await whatsappOptedIn(conn.app, opted)).toBe(true);

    await postAnnouncement(conn.app, head, {
      title: "Sports day on Friday",
      body: "Bring water.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    const queued = await messagesTo([opted, smsOnly], "announcement");
    expect(queued.every((m) => m.whatsappAllowed)).toBe(true);
    const wa = fakeWhatsApp();
    const p = providers(wa.provider);
    await dispatchPending(conn.app, { providers: p, ids: queued.map((m) => m.id) });
    expect(wa.calls).toEqual([
      {
        to: opted,
        template: "edubridge_announcement",
        params: [s.tenant.name, "Sports day on Friday", expect.stringMatching(/\/p$/)],
      },
    ]);
    expect(p.sms.sendSms).toHaveBeenCalledTimes(1);
    const sent = await messagesTo([opted, smsOnly], "announcement");
    expect(Object.fromEntries(sent.map((m) => [m.recipient, m.sentVia]))).toEqual({
      [opted]: "whatsapp",
      [smsOnly]: "sms",
    });
    // Kept until WhatsApp confirms delivery, so a later failure can still go by SMS.
    expect(sent.find((m) => m.recipient === opted)!.payload).not.toEqual({});

    // Billing: the WhatsApp message is not an SMS.
    const usage = (await getSchoolBilling(conn.app, owner)).usage[0]!;
    expect(usage).toMatchObject({ familyMessages: 1, whatsapp: 1 });
    const used = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      smsUsedThisMonth(tx, s.tenant.id, s.tenant.timezone),
    );
    expect(used).toBe(1);

    // Handset receipts from Meta's webhook (NOT-07), then the content is cleared.
    const wamid = sent.find((m) => m.recipient === opted)!.providerMessageId!;
    await handleWhatsAppWebhook(conn.app, {
      entry: [
        { changes: [{ value: { statuses: [{ id: wamid, status: "read", timestamp: "1794300000" }] } }] },
      ],
    });
    const [read] = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.providerMessageId, wamid));
    expect(read!.readAt).not.toBeNull();
    expect(read!.deliveredAt).not.toBeNull();
    expect(read!.payload).toEqual({});
    const report = await getDeliveryReport(conn.app, owner);
    expect(report.rows.find((r) => r.kind === "announcement")).toMatchObject({
      sent: 2,
      whatsapp: 1,
      delivered: 1,
    });
  });

  it("falls back to SMS when WhatsApp refuses or later fails, and stops on STOP", async () => {
    const s = await school();
    const { head } = await withPlan(s, true);
    const phone = await family(s, "Kofi");
    await setWhatsAppChoice(conn.app, phone, { on: true });
    await postAnnouncement(conn.app, head, {
      title: "Closed Monday",
      body: "Holiday.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    // Refused at once: the SMS goes in the same run.
    const [first] = await messagesTo([phone], "announcement");
    const refused = fakeWhatsApp(true);
    const p1 = providers(refused.provider);
    await dispatchPending(conn.app, { providers: p1, ids: [first!.id] });
    expect(refused.calls).toHaveLength(1);
    expect(p1.sms.sendSms).toHaveBeenCalledTimes(1);
    expect((await messagesTo([phone], "announcement"))[0]!.sentVia).toBe("sms");

    // Accepted, then reported failed by the webhook: back in the queue, and sent by SMS.
    await postAnnouncement(conn.app, head, {
      title: "Open day",
      body: "Saturday.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    const second = (await messagesTo([phone], "announcement")).find((m) => m.id !== first!.id)!;
    const ok = fakeWhatsApp();
    await dispatchPending(conn.app, { providers: providers(ok.provider), ids: [second.id] });
    const [viaWa] = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, second.id));
    await handleWhatsAppWebhook(conn.app, {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: viaWa!.providerMessageId,
                    status: "failed",
                    timestamp: "1794300000",
                    errors: [{ code: 131026 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const [requeued] = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, second.id));
    expect(requeued).toMatchObject({ status: "pending", whatsappAllowed: false, sentVia: null });
    expect(requeued!.lastError).toMatch(/131026/);
    const p2 = providers(ok.provider);
    await dispatchPending(conn.app, { providers: p2, ids: [second.id] });
    expect(p2.sms.sendSms).toHaveBeenCalledTimes(1);

    // STOP: opted out at once.
    await handleWhatsAppWebhook(conn.app, {
      entry: [
        {
          changes: [
            { value: { messages: [{ from: phone.slice(1), type: "text", text: { body: " Stop " } }] } },
          ],
        },
      ],
    });
    expect(await whatsappOptedIn(conn.app, phone)).toBe(false);
  });

  it("is never used for a school whose plan leaves it out", async () => {
    const s = await school();
    const { head } = await withPlan(s, false);
    const phone = await family(s, "Yaw");
    expect((await getWhatsAppChoice(conn.app, phone)).offered).toBe(false);
    await expect(setWhatsAppChoice(conn.app, phone, { on: true })).rejects.toThrow();
    await postAnnouncement(conn.app, head, {
      title: "Exams",
      body: "Next week.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    const [m] = await messagesTo([phone], "announcement");
    expect(m!.whatsappAllowed).toBe(false);
  });
});

describe("scheduled announcements (NOT-06)", () => {
  it("are posted at their time, charged only then, and can be cancelled until then", async () => {
    const s = await school();
    const { head } = await withPlan(s, false);
    const phone = await family(s, "Adwoa");
    const now = new Date();
    const local = (ms: number) =>
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: s.tenant.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
        .format(new Date(now.getTime() + ms))
        .replace(" ", "T");
    await expect(
      postAnnouncement(conn.app, head, {
        title: "Late",
        body: "x",
        audience: "school",
        sms: false,
        sendAt: local(60_000),
      }),
    ).rejects.toMatchObject({ code: "schedule_past" });
    const later = await postAnnouncement(conn.app, head, {
      title: "PTA tomorrow",
      body: "At 10:00.",
      audience: "school",
      audienceId: null,
      sms: true,
      sendAt: local(3_600_000),
    });
    expect(later.scheduledFor).toBeInstanceOf(Date);
    const cancelMe = await postAnnouncement(conn.app, head, {
      title: "Maybe",
      body: "Not sure.",
      audience: "school",
      sms: false,
      sendAt: local(7_200_000),
    });
    expect((await listScheduledAnnouncements(conn.app, head)).map((a) => a.title)).toEqual([
      "PTA tomorrow",
      "Maybe",
    ]);
    // Nothing sent or charged yet.
    expect(await messagesTo([phone], "announcement")).toEqual([]);
    await cancelScheduledAnnouncement(conn.app, head, cancelMe.id);
    await expect(cancelScheduledAnnouncement(conn.app, head, cancelMe.id)).rejects.toMatchObject({
      code: "not_found",
    });

    await runScheduledAnnouncements(conn.app, new Date(now.getTime() + 3 * 3_600_000));
    const rows = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(scheduledAnnouncements).where(eq(scheduledAnnouncements.tenantId, s.tenant.id)),
    );
    expect(Object.fromEntries(rows.map((r) => [r.title, r.status]))).toEqual({
      "PTA tomorrow": "posted",
      Maybe: "cancelled",
    });
    const posted = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(announcements).where(eq(announcements.tenantId, s.tenant.id)),
    );
    expect(posted.map((a) => [a.title, a.smsCount, a.createdByUserId])).toEqual([
      ["PTA tomorrow", 1, s.head.userId],
    ]);
    expect(await messagesTo([phone], "announcement")).toHaveLength(1);
    // A posted announcement never changes.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx
          .update(scheduledAnnouncements)
          .set({ status: "pending" })
          .where(eq(scheduledAnnouncements.id, later.id)),
      ),
    ).rejects.toThrow();
  });
});

describe("paying EduBridge invoices online (SUB-04)", () => {
  async function invoiceFor(s: School, amount = "1500") {
    const admin = await platform;
    const today = todayIn(s.tenant.timezone);
    return issueSubscriptionInvoice(conn.app, admin.id, s.tenant.id, {
      periodStartsOn: today,
      periodEndsOn: addDays(today, 120),
      dueOn: addDays(today, 14),
      lines: [{ description: "Standard plan", quantity: "1", unitPrice: amount }],
    });
  }
  const callbackUrl = "https://edubridge.example/s/x/settings/plan/paid";

  it("marks the invoice paid once the provider confirms the full amount, and extends the paid period", async () => {
    const s = await school();
    const admin = await platform;
    await updateSubscription(conn.app, admin.id, s.tenant.id, { status: "grace", billingPeriod: "termly" });
    const { id } = await invoiceFor(s);
    const provider = mockInvoicePayments();
    const started = await startInvoicePayment(conn.app, s.owner, id, { provider, callbackUrl });
    expect(started.reference).toMatch(/^EBI\./);
    expect(started.authorizationUrl).toContain(encodeURIComponent(started.reference));
    await expect(startInvoicePayment(conn.app, s.bursar, id, { provider, callbackUrl })).rejects.toThrow();

    expect(await confirmInvoicePayment(conn.app, started.reference, { provider })).toMatchObject({
      outcome: "paid",
    });
    // Again (the return page and the webhook both arrive): nothing changes.
    expect(await confirmInvoicePayment(conn.app, started.reference, { provider })).toMatchObject({
      outcome: "paid",
    });
    const [invoice] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.id, id)),
    );
    expect(invoice!.paidOn).not.toBeNull();
    expect(invoice!.paymentReference).toBe(`Online ${started.reference}`);
    const [plan] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(tenantEntitlements).where(eq(tenantEntitlements.tenantId, s.tenant.id)),
    );
    expect(plan!.paidUntil).toBe(invoice!.periodEndsOn);
    await expect(startInvoicePayment(conn.app, s.owner, id, { provider, callbackUrl })).rejects.toMatchObject(
      {
        code: "already_settled",
      },
    );
  });

  it("refuses a short or foreign-currency payment, and keeps a late duplicate for a refund", async () => {
    const s = await school();
    const admin = await platform;
    const { id } = await invoiceFor(s);
    const short: InvoicePaymentProvider = {
      ...mockInvoicePayments(),
      verify: async (_ref, expected) => ({
        status: "success",
        amountPesewas: expected.amountPesewas - 100,
        currency: expected.currency,
        paidAt: new Date(),
        providerReference: "x",
        channel: "card",
      }),
    };
    const a = await startInvoicePayment(conn.app, s.owner, id, { provider: short, callbackUrl });
    expect(await confirmInvoicePayment(conn.app, a.reference, { provider: short })).toMatchObject({
      outcome: "failed",
    });
    const [stillOpen] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.id, id)),
    );
    expect(stillOpen!.paidOn).toBeNull();
    // A forged or unknown reference does nothing.
    expect(await confirmInvoicePayment(conn.app, "EBI.not.real", { provider: short })).toEqual({
      outcome: "not_found",
    });

    // Paid by bank transfer meanwhile, then the online payment completes.
    const provider = mockInvoicePayments();
    const b = await startInvoicePayment(conn.app, s.owner, id, { provider, callbackUrl });
    await markSubscriptionInvoicePaid(conn.app, admin.id, s.tenant.id, id, {
      paidOn: todayIn(s.tenant.timezone),
      reference: "GCB-123",
    });
    expect(await confirmInvoicePayment(conn.app, b.reference, { provider })).toMatchObject({
      outcome: "duplicate",
    });
  });
});

describe("staff notifications (PSH-01)", () => {
  it("tell admissions staff on their own devices about a new online application, until they sign out", async () => {
    const s = await school();
    await withPlan(s, false);
    const { token } = await createSession(conn.app, s.head.userId);
    const session = (await validateSessionToken(conn.app, token))!;
    await saveStaffPushSubscription(
      conn.app,
      { sessionId: session.sessionId, userId: s.head.userId },
      {
        endpoint: `https://push.example.test/send/${randomBytes(12).toString("hex")}`,
        keys: {
          p256dh: "B" + randomBytes(64).toString("base64url"),
          auth: randomBytes(16).toString("base64url"),
        },
      },
    );
    // The accountant's device is not told (admissions are not theirs to run).
    const { token: bursarToken } = await createSession(conn.app, s.bursar.userId);
    const bursarSession = (await validateSessionToken(conn.app, bursarToken))!;
    await saveStaffPushSubscription(
      conn.app,
      { sessionId: bursarSession.sessionId, userId: s.bursar.userId },
      {
        endpoint: `https://push.example.test/send/${randomBytes(12).toString("hex")}`,
        keys: {
          p256dh: "B" + randomBytes(64).toString("base64url"),
          auth: randomBytes(16).toString("base64url"),
        },
      },
    );

    await saveOnlineApplications(conn.app, s.head, { onlineApplications: "on" });
    const level = (await listLevelsWithClasses(conn.app, s.owner)).find((l) => l.name === "Basic 4")!.id;
    const phone = randomPhone();
    const { verificationId } = await startOnlineApplication(conn.app, s.tenant.slug, {
      childFirstName: "Esi",
      childLastName: "Boateng",
      sex: "female",
      dateOfBirth: "2017-03-04",
      levelId: level,
      guardianName: "Akua Boateng",
      guardianPhone: phone,
      guardianRelationship: "mother",
    });
    const [codeRow] = await conn.owner
      .select({ payload: notificationOutbox.payload })
      .from(notificationOutbox)
      .where(
        and(eq(notificationOutbox.template, "application_code"), eq(notificationOutbox.recipient, phone)),
      );
    await confirmOnlineApplication(conn.app, s.tenant.slug, {
      verificationId,
      code: String((codeRow!.payload as { code: string }).code),
    });
    const devices = await conn.owner
      .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, [s.head.userId, s.bursar.userId]));
    const pushes = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.template, "staff_application_push"),
          inArray(
            notificationOutbox.recipient,
            devices.map((d) => d.id),
          ),
        ),
      );
    expect(pushes.map((p) => p.recipient)).toEqual([devices.find((d) => d.userId === s.head.userId)!.id]);

    await revokeSessionToken(conn.app, token);
    const left = await conn.owner
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, s.head.userId));
    expect(left).toEqual([]);
  });
});
