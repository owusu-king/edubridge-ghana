import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, mobileMoneyCallbacks, mobileMoneyRequests, tenants } from "@/server/db/schema";
import { pgErrorCode } from "@/server/errors";
import { getReceipt } from "@/server/fees/payments";
import {
  pollOpenRequests,
  processMobileMoneyCallbacks,
  receiveMobileMoneyCallback,
  runMobileMoneyWork,
} from "@/server/mobile-money/callbacks";
import { callbackUrlFor } from "@/server/mobile-money/config";
import {
  DEV_MOCK_SECRET,
  MOCK_SIGNATURE_HEADER,
  mockProvider,
  signMockCallback,
} from "@/server/mobile-money/mock";
import { ProviderError } from "@/server/mobile-money/provider";
import {
  listMobileMoneyRequests,
  listSchoolMobileMoneyRequests,
  markMobileMoneyReviewed,
  PROMPT_EXPIRY_MS,
} from "@/server/mobile-money/requests";
import {
  APPROVES,
  ask,
  auditActions,
  conn,
  DECLINES,
  mock,
  NO_ANSWER,
  paymentsFor,
  school,
  scripted,
  WRONG_AMOUNT,
  type School,
} from "../support/mobile-money";

afterAll(() => conn.close());

const ref = (s: School) => ({ id: s.tenant.id, timezone: s.tenant.timezone });
const MINUTE = 60_000;

/** A callback as the mock provider sends it. */
function callback(
  s: School,
  body: Record<string, unknown>,
  options: { secret?: string; provider?: string; tenantId?: string; tamper?: boolean } = {},
) {
  const rawBody = JSON.stringify(body);
  const headers = new Headers({
    [MOCK_SIGNATURE_HEADER]: signMockCallback(rawBody, options.secret ?? DEV_MOCK_SECRET),
  });
  return receiveMobileMoneyCallback(
    conn.app,
    {
      providerName: options.provider ?? "mock",
      tenantId: options.tenantId ?? s.tenant.id,
      headers,
      rawBody: options.tamper ? rawBody.replace("}", ',"x":1}') : rawBody,
    },
    mock,
  );
}

async function requestRow(s: School, id: string) {
  return withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, async (tx) => {
    const [row] = await tx.select().from(mobileMoneyRequests).where(eq(mobileMoneyRequests.id, id));
    return row!;
  });
}

async function callbacksFor(s: School) {
  return withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx.select().from(mobileMoneyCallbacks).where(eq(mobileMoneyCallbacks.tenantId, s.tenant.id)),
  );
}

describe("Mobile Money callbacks", () => {
  it("stores a signed callback once and records the payment as the system", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, APPROVES, "300");
    const { providerReference } = await requestRow(s, sent.requestId);

    const body = { reference: sent.requestId, providerReference };
    expect(await callback(s, body)).toMatchObject({ kind: "accepted", school: ref(s) });
    // Providers retry: the same callback is stored once.
    expect(await callback(s, body)).toMatchObject({ kind: "duplicate" });
    expect(await callbacksFor(s)).toHaveLength(1);

    expect(await processMobileMoneyCallbacks(conn.app, ref(s), mock)).toMatchObject({
      callbacks: 1,
      recorded: 1,
      errors: 0,
    });
    const row = await requestRow(s, sent.requestId);
    expect(row.status).toBe("successful");
    const receipt = (await getReceipt(conn.app, s.bursar, row.paymentId!))!;
    expect(receipt).toMatchObject({ amountPesewas: 30000, method: "mobile_money", recordedBy: null });
    const [stored] = await callbacksFor(s);
    expect(stored).toMatchObject({ result: "successful", attempts: 1, requestId: sent.requestId });
    expect(stored!.processedAt).not.toBeNull();

    // Nothing left to do, and nothing recorded twice.
    expect(await processMobileMoneyCallbacks(conn.app, ref(s), mock)).toMatchObject({ callbacks: 0 });
    expect(await paymentsFor(s, ama.id)).toHaveLength(1);
    const actors = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx
        .select({ actor: auditEvents.actorUserId })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.entityId, sent.requestId), eq(auditEvents.action, "mobile_money.confirmed")),
        ),
    );
    expect(actors).toEqual([{ actor: null }]);
  });

  it("refuses callbacks that are not genuine, and stores nothing", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, APPROVES);
    const body = { reference: sent.requestId };
    expect(await callback(s, body, { secret: "wrong" })).toEqual({ kind: "invalid_signature" });
    expect(await callback(s, body, { tamper: true })).toEqual({ kind: "invalid_signature" });
    expect(await callback(s, {})).toEqual({ kind: "invalid_signature" });
    expect(
      await receiveMobileMoneyCallback(
        conn.app,
        {
          providerName: "mock",
          tenantId: s.tenant.id,
          headers: new Headers(),
          rawBody: JSON.stringify(body),
        },
        mock,
      ),
    ).toEqual({ kind: "invalid_signature" });
    expect(await callback(s, body, { provider: "mtn" })).toEqual({ kind: "unknown_provider" });
    expect(await callback(s, body, { tenantId: "not-a-school" })).toEqual({ kind: "unknown_school" });
    expect(await callback(s, body, { tenantId: randomUUID() })).toEqual({ kind: "unknown_school" });
    expect(await callbacksFor(s)).toHaveLength(0);
    expect((await requestRow(s, sent.requestId)).status).toBe("pending");
  });

  it("ignores callbacks for suspended schools", async () => {
    const s = await school();
    await conn.owner.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, s.tenant.id));
    expect(await callback(s, { reference: randomUUID() })).toEqual({ kind: "unknown_school" });
  });

  it("never lets one school's callback settle another school's request", async () => {
    const a = await school();
    const b = await school();
    const ama = await a.add("Ama", a.classA);
    const sent = await ask(a, ama.id, APPROVES);
    const { providerReference } = await requestRow(a, sent.requestId);
    // A genuine callback, but addressed to school B.
    expect(await callback(b, { reference: sent.requestId, providerReference })).toMatchObject({
      kind: "accepted",
    });
    await processMobileMoneyCallbacks(conn.app, ref(b), mock);
    expect((await callbacksFor(b))[0]).toMatchObject({ result: "unknown_request" });
    expect((await requestRow(a, sent.requestId)).status).toBe("pending");
  });

  it("retries a callback while the provider cannot be reached", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const { state, deps } = scripted();
    const sent = await ask(s, ama.id, APPROVES, "100", {}, deps);
    await withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.insert(mobileMoneyCallbacks).values({
        tenantId: s.tenant.id,
        provider: "scripted",
        requestId: sent.requestId,
        bodySha256: "a".repeat(64),
      }),
    );
    state.statusFail = new ProviderError("The network did not respond.");
    expect(await processMobileMoneyCallbacks(conn.app, ref(s), deps)).toMatchObject({
      callbacks: 0,
      errors: 1,
    });
    expect((await callbacksFor(s))[0]).toMatchObject({ attempts: 1, processedAt: null });

    state.statusFail = null;
    state.status = {
      state: "successful",
      amountPesewas: 10000,
      currency: "GHS",
      transactionId: "TX-RETRY",
      completedAt: null,
    };
    expect(await processMobileMoneyCallbacks(conn.app, ref(s), deps)).toMatchObject({
      callbacks: 1,
      recorded: 1,
    });
    expect((await callbacksFor(s))[0]).toMatchObject({ attempts: 2, result: "successful" });
  });

  it("has the mock send a signed callback to the school's callback URL", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const posted: { url: string; init: RequestInit }[] = [];
    const sending = mockProvider({
      secret: DEV_MOCK_SECRET,
      send: true,
      delayMs: 0,
      fetch: (async (url: string, init: RequestInit) => {
        posted.push({ url, init });
        return new Response(null);
      }) as typeof fetch,
    });
    const deps = { provider: sending, callbackBaseUrl: "https://school.example.test" };
    const sent = await ask(s, ama.id, APPROVES, "100", {}, deps);
    await ask(s, (await s.add("Esi", s.classA)).id, NO_ANSWER, "100", {}, deps);
    await new Promise((r) => setTimeout(r, 20));

    // Only the answered prompt calls back; unanswered prompts stay silent.
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(callbackUrlFor("mock", s.tenant.id, "https://school.example.test"));
    expect(posted[0]!.url).toBe(
      `https://school.example.test/api/v1/mobile-money/callbacks/mock/${s.tenant.id}`,
    );
    const rawBody = String(posted[0]!.init.body);
    const headers = new Headers(posted[0]!.init.headers);
    expect(sending.verifyCallback({ headers, rawBody })).toEqual({
      reference: sent.requestId,
      providerReference: (await requestRow(s, sent.requestId)).providerReference,
    });
  });
});

describe("Mobile Money background checks", () => {
  it("records a confirmed payment without anyone checking, and leaves recent checks alone", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const esi = await s.add("Esi", s.classA);
    const paid = await ask(s, ama.id, APPROVES, "120");
    const waiting = await ask(s, esi.id, NO_ANSWER, "80");

    expect(await pollOpenRequests(conn.app, ref(s), mock)).toMatchObject({ checked: 2, recorded: 1 });
    expect((await requestRow(s, paid.requestId)).status).toBe("successful");
    expect((await requestRow(s, waiting.requestId)).status).toBe("pending");
    // Checked a moment ago: not due again yet.
    expect(await pollOpenRequests(conn.app, ref(s), mock)).toMatchObject({ checked: 0 });
    expect(
      await pollOpenRequests(conn.app, ref(s), { ...mock, now: new Date(Date.now() + 2 * MINUTE) }),
    ).toMatchObject({ checked: 1 });
  });

  it("expires unanswered prompts, keeps checking them for a day, then stops", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, NO_ANSWER, "80");
    const at = (ms: number) => ({ ...mock, now: new Date(Date.now() + ms) });

    await pollOpenRequests(conn.app, ref(s), at(PROMPT_EXPIRY_MS + MINUTE));
    expect((await requestRow(s, sent.requestId)).status).toBe("expired");
    // Expired prompts are checked every 15 minutes, not every minute.
    expect(await pollOpenRequests(conn.app, ref(s), at(PROMPT_EXPIRY_MS + 5 * MINUTE))).toMatchObject({
      checked: 0,
    });
    expect(await pollOpenRequests(conn.app, ref(s), at(PROMPT_EXPIRY_MS + 20 * MINUTE))).toMatchObject({
      checked: 1,
    });
    expect(await pollOpenRequests(conn.app, ref(s), at(25 * 60 * MINUTE))).toMatchObject({ checked: 0 });
    expect(await auditActions(s, sent.requestId)).toContain("mobile_money.expired");
  });

  it("counts provider failures without changing the request", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const { state, deps } = scripted();
    const sent = await ask(s, ama.id, APPROVES, "100", {}, deps);
    state.statusFail = new ProviderError("The network did not respond.");
    expect(await pollOpenRequests(conn.app, ref(s), deps)).toMatchObject({ checked: 0, errors: 1 });
    const row = await requestRow(s, sent.requestId);
    expect(row.status).toBe("pending");
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it("runs across schools, only for requests sent through the configured provider", async () => {
    const name = `worker-${randomUUID().slice(0, 8)}`;
    const a = await school();
    const b = await school();
    const { deps } = scripted(
      { state: "successful", amountPesewas: 5000, currency: "GHS", transactionId: "TX-W", completedAt: null },
      name,
    );
    const inA = await ask(a, (await a.add("Ama", a.classA)).id, APPROVES, "50", {}, deps);
    const inB = await ask(b, (await b.add("Esi", b.classA)).id, APPROVES, "50", {}, deps);
    const other = await ask(a, (await a.add("Kofi", a.classA)).id, APPROVES, "50");

    const work = await runMobileMoneyWork(conn.app, deps);
    expect(work.recorded).toBeGreaterThanOrEqual(2);
    expect((await requestRow(a, inA.requestId)).status).toBe("successful");
    expect((await requestRow(b, inB.requestId)).status).toBe("successful");
    // Sent through the mock, so this run (another provider) does not touch it.
    expect((await requestRow(a, other.requestId)).status).toBe("pending");
    expect(await runMobileMoneyWork(conn.app, { provider: null })).toEqual({
      callbacks: 0,
      checked: 0,
      recorded: 0,
      errors: 0,
    });
  });
});

describe("reviewing held payments", () => {
  async function held(s: School, firstName = "Ama", classId = s.classA) {
    const student = await s.add(firstName, classId);
    const sent = await ask(s, student.id, WRONG_AMOUNT, "400", {}, mock, s.owner);
    await pollOpenRequests(conn.app, ref(s), mock);
    return { student, requestId: sent.requestId };
  }

  it("records the review once, with a note, and lists what still needs attention", async () => {
    const s = await school();
    const { student, requestId } = await held(s);
    const declined = await ask(s, (await s.add("Esi", s.classA)).id, DECLINES, "50");
    await pollOpenRequests(conn.app, ref(s), mock);
    await ask(s, (await s.add("Kofi", s.classA)).id, NO_ANSWER, "50");

    let page = await listSchoolMobileMoneyRequests(conn.app, s.head, { filter: "all", page: 1 });
    expect(page).toMatchObject({ total: 3, attentionCount: 1 });
    expect(
      (await listSchoolMobileMoneyRequests(conn.app, s.bursar, { filter: "attention", page: 1 })).rows.map(
        (r) => r.id,
      ),
    ).toEqual([requestId]);
    expect(
      (await listSchoolMobileMoneyRequests(conn.app, s.bursar, { filter: "waiting", page: 1 })).rows.map(
        (r) => r.status,
      ),
    ).toEqual(["pending"]);

    await expect(
      markMobileMoneyReviewed(conn.app, s.bursar, requestId, { note: "x" }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      markMobileMoneyReviewed(conn.app, s.head, requestId, { note: "Checked statement" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      markMobileMoneyReviewed(conn.app, s.bursar, declined.requestId, { note: "Checked statement" }),
    ).rejects.toMatchObject({ code: "not_held" });

    await markMobileMoneyReviewed(conn.app, s.bursar, requestId, {
      note: "GH₵399 arrived; recorded as R000002",
    });
    await expect(
      markMobileMoneyReviewed(conn.app, s.bursar, requestId, { note: "Again" }),
    ).rejects.toMatchObject({ code: "already_reviewed" });

    const [row] = await listMobileMoneyRequests(conn.app, s.bursar, student.id);
    expect(row).toMatchObject({
      status: "needs_review",
      reviewedBy: "Akosua Accountant",
      reviewNote: "GH₵399 arrived; recorded as R000002",
    });
    page = await listSchoolMobileMoneyRequests(conn.app, s.bursar, { filter: "attention", page: 1 });
    expect(page).toMatchObject({ total: 0, attentionCount: 0 });
    expect(await auditActions(s, requestId)).toContain("mobile_money.reviewed");
  });

  it("keeps campus scope, and the database records a review only once", async () => {
    const s = await school();
    const main = await held(s, "Ama", s.classA);
    const east = await held(s, "Esi", s.classB);
    const seen = await listSchoolMobileMoneyRequests(conn.app, s.eastBursar, { filter: "all", page: 1 });
    expect(seen.rows.map((r) => r.id)).toEqual([east.requestId]);
    expect(seen.attentionCount).toBe(1);
    await expect(
      markMobileMoneyReviewed(conn.app, s.eastBursar, main.requestId, { note: "Checked statement" }),
    ).rejects.toMatchObject({ code: "request_not_found" });

    await markMobileMoneyReviewed(conn.app, s.bursar, main.requestId, { note: "Checked statement" });
    const asApp = withTenant(conn.app, { tenantId: s.tenant.id, userId: s.bursar.userId }, (tx) =>
      tx
        .update(mobileMoneyRequests)
        .set({ reviewNote: "Changed later" })
        .where(eq(mobileMoneyRequests.id, main.requestId)),
    );
    expect(await asApp.then(() => null, pgErrorCode)).toBe("23001");

    // Only held requests can carry a review.
    const paid = await ask(s, (await s.add("Kofi", s.classA)).id, APPROVES, "10");
    await pollOpenRequests(conn.app, ref(s), mock);
    const review = withTenant(conn.app, { tenantId: s.tenant.id, userId: s.bursar.userId }, (tx) =>
      tx
        .update(mobileMoneyRequests)
        .set({ reviewedAt: sql`now()`, reviewedByUserId: s.bursar.userId, reviewNote: "Not allowed" })
        .where(eq(mobileMoneyRequests.id, paid.requestId)),
    );
    expect(await review.then(() => null, pgErrorCode)).toBe("23514");
  });
});
