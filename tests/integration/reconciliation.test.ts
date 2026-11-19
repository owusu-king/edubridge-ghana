import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { reconciliationRuns } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { voidPayment } from "@/server/fees/payments";
import type { CollectionStatus, MobileMoneyProvider } from "@/server/mobile-money/provider";
import {
  compare,
  countOpenDifferences,
  getReconciliation,
  reconcileSchool,
  reviewDifference,
  runReconciliation,
} from "@/server/mobile-money/reconciliation";
import { checkMobileMoneyRequest } from "@/server/mobile-money/requests";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { APPROVES, ask, conn, school } from "../support/mobile-money";

afterAll(() => conn.close());

/** A provider answering per request, so each case can be set up. */
function provider() {
  const answers = new Map<string, CollectionStatus>();
  const p: MobileMoneyProvider = {
    name: `recon-${randomUUID().slice(0, 8)}`,
    testMode: true,
    async requestPayment() {
      return { providerReference: null };
    },
    async getStatus({ reference }) {
      return answers.get(reference) ?? { state: "not_found" };
    },
    verifyCallback: () => null,
  };
  return { answers, deps: { provider: p } };
}

const paid = (pesewas: number, transactionId = `T${randomUUID().slice(0, 6)}`): CollectionStatus => ({
  state: "successful",
  amountPesewas: pesewas,
  currency: "GHS",
  transactionId,
  completedAt: null,
});

describe("daily reconciliation", () => {
  it("lists every difference with the provider, once a day, and corrects nothing", async () => {
    const s = await school();
    const { answers, deps } = provider();
    const [ama, esi, kofi, yaw, abena] = await Promise.all(
      ["Ama", "Esi", "Kofi", "Yaw", "Abena"].map((n) => s.add(n, s.classA)),
    );
    await billTerm(conn.app, s.bursar, s.termId);
    const send = (id: string) => ask(s, id, APPROVES, "400", {}, deps);
    const [rAma, rEsi, rKofi, rYaw] = await Promise.all([ama, esi, kofi, yaw].map((st) => send(st!.id)));
    await send(abena!.id); // still waiting: left to the worker

    answers.set(rAma!.requestId, paid(40000));
    answers.set(rEsi!.requestId, { state: "failed", reason: "Declined" });
    answers.set(rKofi!.requestId, paid(40000));
    answers.set(rYaw!.requestId, paid(40000));
    for (const r of [rAma, rEsi, rKofi, rYaw])
      await checkMobileMoneyRequest(conn.app, s.bursar, r!.requestId, deps);
    const yawPayment = (await checkMobileMoneyRequest(conn.app, s.bursar, rYaw!.requestId, deps)).paymentId!;
    await voidPayment(conn.app, s.owner, yawPayment, { reason: "Entered against the wrong child" });

    // The provider's records the next morning.
    answers.set(rEsi!.requestId, paid(40000, "LATE1"));
    answers.set(rKofi!.requestId, { state: "failed", reason: "Reversed by the network" });

    const today = todayIn(s.tenant.timezone);
    const result = await reconcileSchool(conn.app, s.tenant, today, deps);
    expect(result).toEqual({ checked: 4, matched: 1, differences: 3, errors: 0 });
    expect(await reconcileSchool(conn.app, s.tenant, today, deps)).toBeNull();

    const view = await getReconciliation(conn.app, s.bursar);
    expect(view.runs).toHaveLength(1);
    expect(view.items.map((i) => [i.studentName, i.difference]).sort()).toEqual([
      ["Esi Mensah", "not_recorded"],
      ["Kofi Mensah", "not_confirmed"],
      ["Yaw Mensah", "voided_but_paid"],
    ]);
    expect(view.items.find((i) => i.difference === "not_recorded")!.detail).toContain("LATE1");
    expect(await countOpenDifferences(conn.app, s.bursar)).toBe(3);
    // Nothing was changed: Esi still has no payment, Kofi's receipt stands.
    expect((await checkMobileMoneyRequest(conn.app, s.bursar, rEsi!.requestId, deps)).status).toBe("failed");
    expect((await checkMobileMoneyRequest(conn.app, s.bursar, rKofi!.requestId, deps)).status).toBe(
      "successful",
    );

    // Staff limited to another campus do not see these students' differences.
    expect((await getReconciliation(conn.app, s.eastBursar)).items).toEqual([]);

    const item = view.items[0]!;
    await expect(reviewDifference(conn.app, s.teacher, item.id, { note: "x" })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      reviewDifference(conn.app, s.eastBursar, item.id, { note: "Checked" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(reviewDifference(conn.app, s.bursar, item.id, { note: " " })).rejects.toThrow(ZodError);
    await reviewDifference(conn.app, s.bursar, item.id, { note: "Statement checked; recorded as R000009" });
    await expect(reviewDifference(conn.app, s.bursar, item.id, { note: "Again" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await countOpenDifferences(conn.app, s.bursar)).toBe(2);

    // A finished run cannot be edited.
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx
          .update(reconciliationRuns)
          .set({ differences: 0 })
          .where(eq(reconciliationRuns.tenantId, s.tenant.id)),
      ),
    ).rejects.toThrow();
  });

  it("runs each morning after 02:00 for the previous day", async () => {
    const s = await school();
    const { answers, deps } = provider();
    const ama = await s.add("Ama", s.classA);
    const sent = await ask(s, ama.id, APPROVES, "100", {}, deps);
    answers.set(sent.requestId, paid(10000));
    await checkMobileMoneyRequest(conn.app, s.bursar, sent.requestId, deps);

    const today = todayIn(s.tenant.timezone); // Africa/Accra is UTC+0
    const tomorrow = addDays(today, 1);
    // The pass covers every school in the shared test database. Schools other test files moved to
    // Africa/Nairobi (UTC+3) are already past 02:00 and are reconciled, so check only this school.
    await runReconciliation(conn.app, { ...deps, now: new Date(`${tomorrow}T01:30:00Z`) });
    expect((await getReconciliation(conn.app, s.bursar)).runs).toEqual([]);
    const later = await runReconciliation(conn.app, { ...deps, now: new Date(`${tomorrow}T03:00:00Z`) });
    expect(later.schools).toBeGreaterThanOrEqual(1);
    const { runs } = await getReconciliation(conn.app, s.bursar);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runDate: today, checked: 1, matched: 1, differences: 0 });
  });

  it("explains each kind of difference", () => {
    const base = {
      id: "r",
      amountPesewas: 40000,
      currency: "GHS",
      providerReference: null,
      receiptNumber: "R000001",
      voided: false,
    };
    const recorded = { ...base, status: "successful" as const, paymentId: "p" };
    expect(compare(recorded, paid(40000))).toBeNull();
    expect(compare(recorded, paid(39900))?.difference).toBe("amount_differs");
    expect(compare(recorded, { state: "pending" })?.detail).toContain("still shows it waiting");
    expect(compare(recorded, { state: "not_found" })?.detail).toContain("has no record");
    expect(compare({ ...base, status: "expired", paymentId: null }, { state: "pending" })).toBeNull();
    expect(compare({ ...base, status: "expired", paymentId: null }, paid(40000))?.difference).toBe(
      "not_recorded",
    );
  });
});
