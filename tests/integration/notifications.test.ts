import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { notificationOutbox } from "@/server/db/schema";
import { dispatchPending, enqueue, MAX_ATTEMPTS, releaseStuck } from "@/server/notifications/outbox";
import { DeliveryError, type Providers } from "@/server/notifications/providers";
import { connect } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

function fakeProviders(behaviour: () => Promise<{ messageId: string }>) {
  const sendEmail = vi.fn(behaviour);
  const providers: Providers = {
    email: { name: "fake", sendEmail },
    sms: { name: "fake", sendSms: vi.fn(behaviour) },
  };
  return { providers, sendEmail };
}

const queue = (recipient = `n-${Math.random().toString(36).slice(2)}@example.test`) =>
  enqueue(conn.app, {
    channel: "email",
    recipient,
    template: "password_reset",
    payload: { name: "Ama", token: "secret-token", expiresMinutes: 30 },
  });

const row = async (id: string) =>
  (await conn.owner.select().from(notificationOutbox).where(eq(notificationOutbox.id, id)))[0]!;
// Other test files share the outbox; isolate by only counting our own rows.
const future = () => new Date(Date.now() + 60 * 60 * 1000);

describe("notification outbox", () => {
  it("sends, records the provider id and clears the payload", async () => {
    const id = await queue();
    const { providers, sendEmail } = fakeProviders(async () => ({ messageId: "prov-1" }));
    await dispatchPending(conn.app, { providers, limit: 100, now: future() });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Reset your EduBridge password" }),
    );
    expect(await row(id)).toMatchObject({
      status: "sent",
      providerMessageId: "prov-1",
      payload: {},
      attempts: 1,
    });
  });

  it("retries with backoff, then gives up after the maximum attempts", async () => {
    const id = await queue();
    const { providers } = fakeProviders(async () => {
      throw new DeliveryError("Brevo responded 503");
    });
    let now = future();
    await dispatchPending(conn.app, { providers, limit: 100, now });
    let r = await row(id);
    expect(r).toMatchObject({ status: "pending", attempts: 1, lastError: "Brevo responded 503" });
    expect(r.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      now = new Date(now.getTime() + 60 * 60_000);
      await dispatchPending(conn.app, { providers, limit: 100, now });
    }
    r = await row(id);
    expect(r).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, payload: {} });
  });

  it("does not retry permanent failures", async () => {
    const id = await queue();
    const { providers } = fakeProviders(async () => {
      throw new DeliveryError("Brevo responded 400", true);
    });
    await dispatchPending(conn.app, { providers, limit: 100, now: future() });
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("never sends a message twice when dispatchers run concurrently", async () => {
    const ids = await Promise.all([queue(), queue(), queue()]);
    const { providers, sendEmail } = fakeProviders(async () => ({ messageId: "x" }));
    const now = future();
    await Promise.all([1, 2, 3].map(() => dispatchPending(conn.app, { providers, limit: 100, now })));
    const recipients = sendEmail.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to);
    const mine = (
      await conn.owner.select().from(notificationOutbox).where(inArray(notificationOutbox.id, ids))
    ).map((r) => r.recipient);
    for (const r of mine) expect(recipients.filter((x) => x === r)).toHaveLength(1);
  });

  it("releases messages stuck in sending", async () => {
    const id = await queue();
    await conn.owner
      .update(notificationOutbox)
      .set({ status: "sending", nextAttemptAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(notificationOutbox.id, id));
    expect(await releaseStuck(conn.app)).toBeGreaterThanOrEqual(1);
    expect((await row(id)).status).toBe("pending");
  });
});
