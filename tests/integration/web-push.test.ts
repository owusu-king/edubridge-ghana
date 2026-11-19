import { randomBytes, randomInt } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db/context";
import { notificationOutbox, parentSessions, pushSubscriptions, smsUsage } from "@/server/db/schema";
import { listAudiences, postAnnouncement } from "@/server/messages/announcements";
import { dispatchPending } from "@/server/notifications/outbox";
import { DeliveryError, type Providers } from "@/server/notifications/providers";
import { countPushDevices, removePushSubscription, savePushSubscription } from "@/server/parents/push";
import { createParentSession, revokeParentSession, validateParentSession } from "@/server/parents/sessions";
import { addGuardian } from "@/server/students/guardians";
import { normalizePhone } from "@/lib/phone";
import { conn, school, type School } from "../support/mobile-money";

const KEY = "BA" + randomBytes(60).toString("base64url");
beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = KEY;
});
afterAll(async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  await conn.close();
});

const randomPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const endpoint = () => `https://push.example.test/send/${randomBytes(12).toString("hex")}`;
const subscription = (url = endpoint()) => ({
  endpoint: url,
  keys: { p256dh: "B" + randomBytes(64).toString("base64url"), auth: randomBytes(16).toString("base64url") },
});

async function signIn(phone: string) {
  const { token } = await createParentSession(conn.app, phone);
  return { token, session: (await validateParentSession(conn.app, token))! };
}

async function family(s: School, name: string) {
  const id = (await s.add(name, s.classA)).id;
  const phone = randomPhone();
  await addGuardian(conn.app, s.owner, id, { fullName: `${name}'s mother`, phone, relationship: "mother" });
  return normalizePhone(phone)!;
}

function fakeProviders(push: Providers["push"]["sendPush"]): Providers {
  const never = async () => {
    throw new Error("not expected");
  };
  return {
    email: { name: "fake", sendEmail: never },
    sms: { name: "fake", sendSms: async () => ({ messageId: "sms-1" }) },
    push: { name: "fake", sendPush: vi.fn(push) },
  };
}

describe("push subscriptions", () => {
  it("belong to the sign-in that turned them on, and end with it", async () => {
    const phone = normalizePhone(randomPhone())!;
    const first = await signIn(phone);
    const sub = subscription();
    await savePushSubscription(conn.app, first.session, sub);
    expect(await countPushDevices(conn.app, first.session)).toBe(1);
    // The same browser signing in again (here, as another number) moves the subscription to that sign-in.
    const other = await signIn(normalizePhone(randomPhone())!);
    await savePushSubscription(conn.app, other.session, sub);
    expect(await countPushDevices(conn.app, first.session)).toBe(0);
    expect(await countPushDevices(conn.app, other.session)).toBe(1);
    // A parent can only turn off their own sign-in's subscription.
    await removePushSubscription(conn.app, first.session, sub.endpoint);
    expect(await countPushDevices(conn.app, other.session)).toBe(1);
    // Signing out removes it.
    await revokeParentSession(conn.app, other.token);
    const left = await conn.app
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, sub.endpoint));
    expect(left).toEqual([]);
  });

  it("refuses anything that is not a browser push subscription", async () => {
    const { session } = await signIn(normalizePhone(randomPhone())!);
    await expect(
      savePushSubscription(conn.app, session, { ...subscription(), endpoint: "http://x.test/a" }),
    ).rejects.toThrow();
    await expect(
      savePushSubscription(conn.app, session, {
        endpoint: endpoint(),
        keys: { p256dh: "<script>", auth: "x" },
      }),
    ).rejects.toThrow();
    delete process.env.VAPID_PUBLIC_KEY;
    await expect(savePushSubscription(conn.app, session, subscription())).rejects.toThrow(/not available/);
    process.env.VAPID_PUBLIC_KEY = KEY;
  });
});

describe("announcements by push", () => {
  it("go free by push to families with notifications on, and by SMS (when chosen) to the rest", async () => {
    const s = await school();
    const withPush = await family(s, "Ama");
    const smsOnly = await family(s, "Kofi");
    const { session } = await signIn(withPush);
    await savePushSubscription(conn.app, session, subscription());
    const audiences = await listAudiences(conn.app, s.head);
    expect(audiences.find((a) => a.audience === "school")).toMatchObject({ families: 2, withPush: 1 });

    const posted = await postAnnouncement(conn.app, s.head, {
      title: "Sports day",
      body: "Friday at 9.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    expect(posted).toMatchObject({ sms: 1, push: 1 });
    const queued = await conn.owner
      .select({
        id: notificationOutbox.id,
        channel: notificationOutbox.channel,
        recipient: notificationOutbox.recipient,
      })
      .from(notificationOutbox)
      .innerJoin(pushSubscriptions, sql`${pushSubscriptions.id}::text = ${notificationOutbox.recipient}`)
      .where(eq(pushSubscriptions.phone, withPush));
    expect(queued.map((q) => q.channel)).toEqual(["push"]);
    // Only the SMS is charged.
    const usage = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select().from(smsUsage).where(eq(smsUsage.tenantId, s.tenant.id)),
    );
    expect(usage).toHaveLength(1);
    const [sms] = await conn.owner
      .select({ recipient: notificationOutbox.recipient })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, usage[0]!.outboxId));
    expect(sms!.recipient).toBe(smsOnly);

    // Without SMS chosen, the push still goes (it costs nothing).
    const quiet = await postAnnouncement(conn.app, s.head, {
      title: "Uniforms",
      body: "New sizes.",
      audience: "school",
      audienceId: null,
      sms: false,
    });
    expect(quiet).toMatchObject({ sms: 0, push: 1 });

    // The push says only that there is news, and opens the school's news page.
    const providers = fakeProviders(async () => ({ messageId: "push-1" }));
    await dispatchPending(conn.app, { providers, ids: queued.map((q) => q.id) });
    expect(providers.push.sendPush).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          title: s.tenant.name,
          body: "A new announcement. Open to read it.",
          url: `/p/${s.tenant.slug}/news`,
        },
      }),
    );
  });

  it("removes a subscription the push service says is gone, and skips signed-out phones", async () => {
    const s = await school();
    const phone = await family(s, "Esi");
    const { token, session } = await signIn(phone);
    await savePushSubscription(conn.app, session, subscription());
    await postAnnouncement(conn.app, s.head, {
      title: "Fees",
      body: "Due.",
      audience: "school",
      audienceId: null,
      sms: false,
    });
    const ids = (
      await conn.owner
        .select({ id: notificationOutbox.id })
        .from(notificationOutbox)
        .innerJoin(pushSubscriptions, sql`${pushSubscriptions.id}::text = ${notificationOutbox.recipient}`)
        .where(eq(pushSubscriptions.phone, phone))
    ).map((r) => r.id);
    const gone = fakeProviders(async () => {
      throw new DeliveryError("Notifications were turned off on that device.", true, true);
    });
    expect(await dispatchPending(conn.app, { providers: gone, ids })).toEqual({ sent: 0, failed: 1 });
    expect(await countPushDevices(conn.app, session)).toBe(0);
    const [row] = await conn.owner
      .select()
      .from(notificationOutbox)
      .where(inArray(notificationOutbox.id, ids));
    expect(row!.status).toBe("failed");

    // A phone whose sign-in has expired is not sent to (SMS is used instead, when chosen).
    await savePushSubscription(conn.app, session, subscription());
    await conn.owner
      .update(parentSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(parentSessions.id, session.sessionId));
    const after = await postAnnouncement(conn.app, s.head, {
      title: "Again",
      body: "Hello.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    expect(after).toMatchObject({ sms: 1, push: 0 });
    await revokeParentSession(conn.app, token);
  });
});
