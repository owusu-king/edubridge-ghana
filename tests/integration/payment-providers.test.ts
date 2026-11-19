import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getSchoolBillingForPlatform, updateSubscription } from "@/server/billing/subscriptions";
import { receiveMobileMoneyCallback } from "@/server/mobile-money/callbacks";
import {
  checkMobileMoneyRequest,
  mobileMoneySetup,
  requestMobileMoneyPayment,
} from "@/server/mobile-money/requests";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { APPROVES, conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

/**
 * PAY-06 without test overrides: the deployment's own registry (in tests, the mock is the default). Each
 * school uses the provider platform staff choose; a prompt is checked with the provider that sent it.
 */
const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

async function choose(s: School, mobileMoneyProvider: string): Promise<TenantContext> {
  const admin = await platform;
  await updateSubscription(conn.app, admin.id, s.tenant.id, {
    status: "active",
    billingPeriod: "termly",
    trialEndsOn: "",
    paidUntil: "",
    price: "",
    mobileMoneyProvider,
  });
  return (await resolveTenantContext(conn.app, s.tenant.slug, s.bursar.userId)) as TenantContext;
}

const prompt = (s: School, ctx: TenantContext, studentId: string) =>
  requestMobileMoneyPayment(conn.app, ctx, {
    studentId,
    amount: "400",
    phone: APPROVES,
    network: "mtn",
    idempotencyKey: randomUUID(),
  });

describe("Mobile Money provider per school", () => {
  it("follows the school's choice, and Off stops new prompts", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    expect(mobileMoneySetup(s.bursar)).toMatchObject({ enabled: true, testMode: true });
    const off = await choose(s, "none");
    expect(off.mobileMoneyProvider).toBe("none");
    expect(mobileMoneySetup(off).enabled).toBe(false);
    await expect(prompt(s, off, ama.id)).rejects.toMatchObject({ code: "mobile_money_off" });
    const admin = await platform;
    expect(
      (await getSchoolBillingForPlatform(conn.app, admin.id, s.tenant.id))!.plan.mobileMoneyProvider,
    ).toBe("none");
    await expect(choose(s, "mtn")).rejects.toThrow();
  });

  it("still settles a prompt already sent after the school's provider changes", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const sent = await prompt(s, s.bursar, ama.id);
    const off = await choose(s, "none");
    const checked = await checkMobileMoneyRequest(conn.app, off, sent.requestId);
    expect(checked.status).toBe("successful");
  });

  it("refuses callbacks for a provider this deployment does not have", async () => {
    const s = await school();
    const receipt = await receiveMobileMoneyCallback(conn.app, {
      providerName: "hubtel",
      tenantId: s.tenant.id,
      headers: new Headers(),
      rawBody: "{}",
    });
    expect(receipt).toEqual({ kind: "unknown_provider" });
  });
});
