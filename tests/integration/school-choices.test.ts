import { randomInt, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { getTermFinance } from "@/server/dashboard/finance";
import { withTenant } from "@/server/db/context";
import { feeConcessions, ledgerEntries } from "@/server/db/schema";
import { addConcession } from "@/server/fees/concessions";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment, voidPayment } from "@/server/fees/payments";
import { applySiblingDiscounts, previewSiblingDiscounts, saveSiblingRule } from "@/server/fees/siblings";
import { listFeeItems } from "@/server/fees/structure";
import { requestParentCode } from "@/server/parents/sign-in";
import { addGuardian } from "@/server/students/guardians";
import { createStudent } from "@/server/students/service";
import { getSchoolPreferences, saveOverviewPreferences, saveVoidPolicy } from "@/server/tenancy/preferences";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const fresh = (s: School, c: TenantContext) =>
  resolveTenantContext(conn.app, s.tenant.slug, c.userId) as Promise<TenantContext>;
const randomPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const pay = (s: School, studentId: string, amount: string) =>
  recordPayment(conn.app, s.bursar, {
    studentId,
    amount,
    method: "cash",
    reference: "",
    paidOn: todayIn(s.tenant.timezone),
    idempotencyKey: randomUUID(),
  });

describe("voiding receipts", () => {
  it("is the Proprietor's alone unless the Proprietor allows Accountants", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    await billTerm(conn.app, s.bursar, s.termId);
    const first = await pay(s, ama, "100");
    await expect(
      voidPayment(conn.app, s.bursar, first.paymentId, { reason: "Entered twice" }),
    ).rejects.toThrow(ForbiddenError);
    // Only the Proprietor decides.
    await expect(saveVoidPolicy(conn.app, s.head, { accountantsCanVoid: true })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(saveVoidPolicy(conn.app, s.bursar, { accountantsCanVoid: true })).rejects.toThrow(
      ForbiddenError,
    );

    await saveVoidPolicy(conn.app, s.owner, { accountantsCanVoid: true });
    const bursar = await fresh(s, s.bursar);
    expect(bursar.schoolGrants).toEqual(["payments.void"]);
    await voidPayment(conn.app, bursar, first.paymentId, { reason: "Entered twice" });
    // The head teacher still cannot: the grant is for Accountants.
    const second = await pay(s, ama, "50");
    await expect(
      voidPayment(conn.app, await fresh(s, s.head), second.paymentId, { reason: "Entered twice" }),
    ).rejects.toThrow(ForbiddenError);

    await saveVoidPolicy(conn.app, s.owner, { accountantsCanVoid: false });
    await expect(
      voidPayment(conn.app, await fresh(s, s.bursar), second.paymentId, { reason: "Entered twice" }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("overview figures", () => {
  it("follow the school's chosen collection-rate basis and attendance threshold", async () => {
    const s = await school();
    const kofi = (await s.add("Kofi", s.classA)).id;
    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.insert(ledgerEntries).values({
        tenantId: s.tenant.id,
        studentId: kofi,
        kind: "opening_balance",
        description: "Balance brought forward",
        amountPesewas: 100_000,
        effectiveOn: "2026-07-24",
      }),
    );
    await billTerm(conn.app, s.bursar, s.termId);
    await pay(s, kofi, "500");
    // Default: 500 of (1,000 owed at the start + 1,000 billed).
    expect((await getTermFinance(conn.app, s.bursar, s.termId))!.collectionRate).toBe(25);
    await saveOverviewPreferences(conn.app, s.owner, {
      collectionRateBasis: "billed",
      attendanceConcernPercent: "90",
      attendanceConcernMinDays: "3",
    });
    const finance = (await getTermFinance(conn.app, s.bursar, s.termId))!;
    expect(finance).toMatchObject({ collectionRate: 50, collectionRateBasis: "billed" });
    expect(await getSchoolPreferences(conn.app, s.owner)).toMatchObject({
      attendanceConcernPercent: 90,
      attendanceConcernMinDays: 3,
    });
    await expect(
      saveOverviewPreferences(conn.app, s.bursar, {
        collectionRateBasis: "due",
        attendanceConcernPercent: "80",
        attendanceConcernMinDays: "5",
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("shared sign-in codes", () => {
  it("are split equally between the schools that have the number", async () => {
    const a = await school();
    const b = await school();
    const phone = randomPhone();
    for (const s of [a, b]) {
      const id = (await s.add("Child", s.classA)).id;
      await addGuardian(conn.app, s.owner, id, { fullName: "Parent", phone, relationship: "mother" });
    }
    await requestParentCode(conn.app, phone);
    for (const s of [a, b])
      expect((await getSchoolBilling(conn.app, s.owner)).usage[0]).toMatchObject({
        sharedCodes: 1,
        billable: 0.5,
      });
  });
});

describe("sibling discounts", () => {
  it("follow the school's rule, change when the rule changes, and never touch discounts added by hand", async () => {
    const s = await school();
    const add = (firstName: string, dateOfBirth: string) =>
      createStudent(conn.app, s.owner, {
        firstName,
        lastName: "Mensah",
        sex: "female",
        classId: s.classA,
        dateOfBirth,
      });
    const ama = (await add("Ama", "2014-03-01")).id;
    const kofi = (await add("Kofi", "2016-05-10")).id;
    const esi = (await add("Esi", "2015-01-01")).id; // another family
    const phone = randomPhone();
    for (const id of [ama, kofi])
      await addGuardian(conn.app, s.owner, id, { fullName: "Mrs Mensah", phone, relationship: "mother" });
    const [tuition] = await listFeeItems(conn.app, s.bursar);
    await addConcession(conn.app, s.bursar, esi, {
      label: "Academic scholarship",
      feeItemId: tuition!.id,
      kind: "percent",
      value: "50",
    });

    // No rule yet: nothing to apply.
    expect((await previewSiblingDiscounts(conn.app, s.bursar)).filter((c) => c.change !== "keep")).toEqual(
      [],
    );

    await saveSiblingRule(conn.app, s.bursar, {
      firstChild: "eldest",
      secondPercent: "10",
      laterPercent: "",
      feeItemId: tuition!.id,
    });
    const preview = await previewSiblingDiscounts(conn.app, s.bursar);
    expect(preview.filter((c) => c.change !== "keep").map((c) => [c.name, c.change, c.proposed])).toEqual([
      ["Kofi Mensah", "add", { place: 2, percentBasisPoints: 1000 }],
    ]);
    expect(await applySiblingDiscounts(conn.app, s.bursar)).toEqual({ added: 1, replaced: 0, ended: 0 });
    // Applying again changes nothing.
    expect(await applySiblingDiscounts(conn.app, s.bursar)).toEqual({ added: 0, replaced: 0, ended: 0 });

    // Billing turns the discount into a ledger entry: 10% of Kofi's GH₵1,000 tuition.
    await billTerm(conn.app, s.bursar, s.termId);
    const discounts = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select({ studentId: ledgerEntries.studentId, amount: ledgerEntries.amountPesewas })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, s.tenant.id), eq(ledgerEntries.kind, "discount"))),
    );
    expect(discounts.find((d) => d.studentId === kofi)?.amount).toBe(-10_000);

    // The youngest pays in full instead: Kofi's discount ends and Ama gets one. Esi's scholarship stays.
    await saveSiblingRule(conn.app, s.bursar, {
      firstChild: "youngest",
      secondPercent: "10",
      laterPercent: "",
      feeItemId: tuition!.id,
    });
    expect(await applySiblingDiscounts(conn.app, s.bursar)).toEqual({ added: 1, replaced: 0, ended: 1 });
    const active = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx
        .select({
          studentId: feeConcessions.studentId,
          label: feeConcessions.label,
          source: feeConcessions.source,
        })
        .from(feeConcessions)
        .where(and(eq(feeConcessions.tenantId, s.tenant.id), eq(feeConcessions.status, "active"))),
    );
    expect(
      active
        .map((c) => [c.studentId === ama ? "Ama" : c.studentId === esi ? "Esi" : "Kofi", c.label, c.source])
        .sort(),
    ).toEqual([
      ["Ama", "Sibling discount (2nd child)", "sibling_rule"],
      ["Esi", "Academic scholarship", "manual"],
    ]);

    // Staff limited to a campus neither see the families list nor apply the rule.
    expect(await previewSiblingDiscounts(conn.app, s.eastBursar)).toEqual([]);
    await expect(applySiblingDiscounts(conn.app, s.eastBursar)).rejects.toMatchObject({
      code: "campus_restricted",
    });
    await expect(applySiblingDiscounts(conn.app, s.head)).rejects.toThrow(ForbiddenError);
  });
});
