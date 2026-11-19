import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { recordSmsUsage, smsAllowance } from "@/server/billing/usage";
import { withTenant } from "@/server/db/context";
import { notificationOutbox, smsUsage } from "@/server/db/schema";
import { getDeliveryReport, maskNumber } from "@/server/messages/delivery";
import { postAnnouncement } from "@/server/messages/announcements";
import { enqueue } from "@/server/notifications/outbox";
import { updateEntitlements } from "@/server/platform/service";
import { addGuardian } from "@/server/students/guardians";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { FEATURES } from "@/lib/plan";
import { normalizePhone } from "@/lib/phone";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const randomPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, fn);

async function withFamily(s: School, name: string) {
  const id = (await s.add(name, s.classA)).id;
  const phone = randomPhone();
  await addGuardian(conn.app, s.owner, id, { fullName: `${name}'s mother`, phone, relationship: "mother" });
  return { id, phone: normalizePhone(phone)! };
}

async function limit(s: School, maxSmsPerMonth: number | null): Promise<TenantContext> {
  const admin = await platform;
  await updateEntitlements(conn.app, admin.id, s.tenant.id, {
    planName: "Starter",
    maxCampuses: 2,
    maxStudents: null,
    maxSmsPerMonth,
    features: [...FEATURES],
  });
  return (await resolveTenantContext(conn.app, s.tenant.slug, s.head.userId)) as TenantContext;
}

/** A two-part announcement title: "ç" is not in the GSM alphabet, so the SMS is Unicode (70 a part). */
const LONG_TITLE = "Réunion des parents: leçons et progrès du trimestre";

describe("SMS segments", () => {
  it("are worked out when a message is queued and copied to the school's usage by the database", async () => {
    const s = await school();
    const usage = await asSchool(s, async (tx) => {
      const id = await enqueue(tx, {
        channel: "sms",
        recipient: "+233245550199",
        template: "announcement",
        payload: { schoolName: s.tenant.name, title: LONG_TITLE },
      });
      const segments = await recordSmsUsage(tx, s.tenant.id, "announcement", id);
      // A caller cannot set its own segments: the trigger takes the queued message's.
      const other = await enqueue(tx, {
        channel: "sms",
        recipient: "+233245550198",
        template: "announcement",
        payload: { schoolName: s.tenant.name, title: "Sports day" },
      });
      const [row] = await tx
        .insert(smsUsage)
        .values({ tenantId: s.tenant.id, kind: "announcement", outboxId: other, segments: 9 })
        .returning({ segments: smsUsage.segments });
      return { segments, forced: row!.segments };
    });
    expect(usage).toEqual({ segments: 2, forced: 1 });
  });

  it("count against the plan's limit, and every school-paid SMS is billed by segment", async () => {
    const s = await school();
    await withFamily(s, "Ama");
    await withFamily(s, "Kofi");
    const head = await limit(s, 3);
    const input = { title: LONG_TITLE, body: "Details inside.", audience: "school", audienceId: null };
    // Two families × 2 SMS each = 4 > 3 left: refused before anything is queued.
    await expect(postAnnouncement(conn.app, head, { ...input, sms: true })).rejects.toMatchObject({
      code: "sms_limit",
      message: expect.stringMatching(/needs 4 SMS/),
    });
    const roomy = await limit(s, 10);
    expect((await postAnnouncement(conn.app, roomy, { ...input, sms: true })).sms).toBe(2);
    expect(await asSchool(s, (tx) => smsAllowance(tx, s.tenant.id, s.tenant.timezone))).toBe(6);
    const billing = await getSchoolBilling(conn.app, s.owner);
    const month = billing.usage[0]!;
    // Announcements were left out of bills before (NOT-02); now billed, in segments.
    expect(month.familyMessages).toBe(4);
    expect(month.billable).toBe(4);
  });
});

describe("duplicate prevention", () => {
  it("queues a message with the same key to the same recipient once", async () => {
    const s = await school();
    const key = `test:${randomUUID()}`;
    const send = (recipient: string) =>
      asSchool(s, (tx) =>
        enqueue(tx, {
          channel: "sms",
          recipient,
          template: "announcement",
          payload: { schoolName: s.tenant.name, title: "Sports day" },
          idempotencyKey: key,
        }),
      );
    const first = await send("+233245550101");
    expect(await send("+233245550101")).toBe(first);
    expect(await send("+233245550102")).not.toBe(first);
    const rows = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(notificationOutbox).where(eq(notificationOutbox.idempotencyKey, key)),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("delivery report", () => {
  it("shows sent, waiting and failed SMS by kind, and failures with masked numbers", async () => {
    const s = await school();
    await withFamily(s, "Ama");
    await withFamily(s, "Kofi");
    const head = await limit(s, null);
    await postAnnouncement(conn.app, head, {
      title: "Sports day",
      body: "Friday.",
      audience: "school",
      audienceId: null,
      sms: true,
    });
    const ids = await asSchool(s, async (tx) =>
      (
        await tx.select({ id: smsUsage.outboxId }).from(smsUsage).where(eq(smsUsage.tenantId, s.tenant.id))
      ).map((r) => r.id),
    );
    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .update(notificationOutbox)
        .set({ status: "failed", lastError: "Number not reachable" })
        .where(and(inArray(notificationOutbox.id, ids), eq(notificationOutbox.id, ids[0]!))),
    );
    const report = await getDeliveryReport(conn.app, s.owner);
    expect(report.rows).toEqual([
      { kind: "announcement", sent: 0, waiting: 1, failed: 1, segments: 1, whatsapp: 0, delivered: 0 },
    ]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.recipient).toMatch(/^\+233 ••• ••• \d{3}$/);
    expect(report.failures[0]!.reason).toBe("Number not reachable");
    await expect(getDeliveryReport(conn.app, s.teacher)).rejects.toThrow();
    expect(maskNumber("+233245550101")).toBe("+233 ••• ••• 101");
  });
});
