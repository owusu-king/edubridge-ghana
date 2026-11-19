import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listLevelsWithClasses } from "@/server/academics/classes";
import {
  confirmOnlineApplication,
  getOnlineApplicationForm,
  ONLINE_LIMITS,
  startOnlineApplication,
} from "@/server/admissions/online";
import {
  createApplication,
  enrolApplicant,
  eraseExpiredApplications,
  getAdmissionsReport,
  getApplication,
  listApplications,
  makeOffer,
  moveApplication,
  recordAssessment,
} from "@/server/admissions/service";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { applications, enrolments, ledgerEntries, notificationOutbox, smsUsage } from "@/server/db/schema";
import { exportDataset } from "@/server/export/datasets";
import { updateEntitlements } from "@/server/platform/service";
import { addGuardian, listGuardians } from "@/server/students/guardians";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { saveAdmissionFees, saveOnlineApplications } from "@/server/tenancy/preferences";
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
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

async function basic4(s: School) {
  return (await listLevelsWithClasses(conn.app, s.owner)).find((l) => l.name === "Basic 4")!.id;
}

const applicant = (levelId: string, phone = randomPhone(), extra: Record<string, unknown> = {}) => ({
  status: "applied",
  source: "walk_in",
  childFirstName: "Esi",
  childLastName: "Boateng",
  sex: "female",
  dateOfBirth: "2017-03-04",
  levelId,
  guardianName: "Akua Boateng",
  guardianPhone: phone,
  guardianRelationship: "mother",
  ...extra,
});

async function plan(s: School, changes: Record<string, unknown>) {
  const admin = await platform;
  await updateEntitlements(conn.app, admin.id, s.tenant.id, {
    planName: "Starter",
    maxCampuses: 2,
    maxStudents: null,
    maxSmsPerMonth: null,
    features: [...FEATURES],
    ...changes,
  });
  const ctx = async (c: TenantContext) =>
    (await resolveTenantContext(conn.app, s.tenant.slug, c.userId)) as TenantContext;
  return { owner: await ctx(s.owner), head: await ctx(s.head), bursar: await ctx(s.bursar) };
}

describe("the admissions pipeline", () => {
  it("takes an applicant from application to enrolment, with fees frozen at the offer and posted once", async () => {
    const s = await school();
    const level = await basic4(s);
    // A sibling is already a student: the same phone links the same guardian.
    const sibling = await s.add("Kofi", s.classA);
    const phone = randomPhone();
    await addGuardian(conn.app, s.owner, sibling.id, {
      fullName: "Akua Boateng",
      phone,
      relationship: "mother",
    });
    await saveAdmissionFees(conn.app, s.bursar, {
      fees: [
        { description: "Admission fee", amount: "500" },
        { description: "Uniform", amount: "150.50" },
      ],
    });
    const { id, reference } = await createApplication(conn.app, s.head, applicant(level, phone));
    expect(reference).toMatch(/^A\d{4}$/);
    await recordAssessment(conn.app, s.head, id, { at: "2026-11-20T09:30", note: "Reading test" });
    await makeOffer(conn.app, s.head, id, {
      entryTermId: s.termId,
      classId: s.classA,
      respondBy: "2026-11-30",
    });
    // Changing the schedule after the offer does not change the offer.
    await saveAdmissionFees(conn.app, s.bursar, { fees: [{ description: "Admission fee", amount: "900" }] });
    const offered = (await getApplication(conn.app, s.head, id))!;
    expect(offered.offer.fees).toEqual([
      { description: "Admission fee", amountPesewas: 50_000 },
      { description: "Uniform", amountPesewas: 15_050 },
    ]);
    expect(offered.assessment.at?.toISOString()).toBe("2026-11-20T09:30:00.000Z");

    const enrolled = await enrolApplicant(conn.app, s.head, id, {});
    expect(enrolled.fees).toBe(2);
    const again = await enrolApplicant(conn.app, s.head, id, {});
    expect(again).toMatchObject({ studentId: enrolled.studentId, fees: 0 });
    const charges = await asSchool(s, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.studentId, enrolled.studentId)),
    );
    expect(charges.map((c) => [c.kind, c.amountPesewas, c.termId])).toEqual([
      ["charge", 50_000, s.termId],
      ["charge", 15_050, s.termId],
    ]);
    const placed = await asSchool(s, (tx) =>
      tx.select().from(enrolments).where(eq(enrolments.studentId, enrolled.studentId)),
    );
    expect(placed).toMatchObject([{ termId: s.termId, classId: s.classA }]);
    const [guardianOfNew] = (await listGuardians(conn.app, s.owner, enrolled.studentId))!;
    const [guardianOfSibling] = (await listGuardians(conn.app, s.owner, sibling.id))!;
    expect(guardianOfNew!.guardianId).toBeTruthy();
    expect(guardianOfNew!.guardianId).toBe(guardianOfSibling!.guardianId);

    const done = (await getApplication(conn.app, s.head, id))!;
    expect(done.status).toBe("enrolled");
    expect(done.student?.admissionNumber).toBe(enrolled.admissionNumber);
    expect(done.events.map((e) => e.to)).toEqual(["applied", "assessment", "offered", "enrolled"]);
    expect(done.canManage).toBe(false);
    // A closed application never changes, even directly in the database.
    await expect(
      asSchool(s, (tx) => tx.update(applications).set({ status: "offered" }).where(eq(applications.id, id))),
    ).rejects.toThrow();
  });

  it("needs a reason to decline or withdraw, and never reopens", async () => {
    const s = await school();
    const { id } = await createApplication(
      conn.app,
      s.head,
      applicant(await basic4(s), undefined, { status: "inquiry" }),
    );
    await expect(moveApplication(conn.app, s.head, id, { to: "declined" })).rejects.toThrow();
    await moveApplication(conn.app, s.head, id, { to: "declined", note: "No place in Basic 4 this year." });
    await expect(moveApplication(conn.app, s.head, id, { to: "applied" })).rejects.toThrow(/cannot become/);
    await expect(makeOffer(conn.app, s.head, id, { entryTermId: s.termId })).rejects.toThrow(
      /Only an application/,
    );
  });

  it("enrols within the plan's student limit, or not at all", async () => {
    const s = await school();
    await s.add("Ama", s.classA);
    const ctx = await plan(s, { maxStudents: 1 });
    const { id } = await createApplication(conn.app, ctx.head, applicant(await basic4(s)));
    await makeOffer(conn.app, ctx.head, id, { entryTermId: s.termId, classId: s.classA });
    await expect(enrolApplicant(conn.app, ctx.head, id, {})).rejects.toMatchObject({ code: "student_limit" });
    expect((await getApplication(conn.app, ctx.head, id))!.status).toBe("offered");
  });

  it("is for academic and office staff; the Accountant can look; plans can leave it out", async () => {
    const s = await school();
    const level = await basic4(s);
    await expect(createApplication(conn.app, s.teacher, applicant(level))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(createApplication(conn.app, s.bursar, applicant(level))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await listApplications(conn.app, s.bursar)).rows).toEqual([]);
    const without = await plan(s, { features: FEATURES.filter((f) => f !== "admissions") });
    await expect(listApplications(conn.app, without.head)).rejects.toMatchObject({
      code: "feature_not_included",
    });
  });

  it("reports how many reached each stage, and exports every application", async () => {
    const s = await school();
    const level = await basic4(s);
    const a = await createApplication(conn.app, s.head, applicant(level));
    await makeOffer(conn.app, s.head, a.id, { entryTermId: s.termId });
    await moveApplication(conn.app, s.head, a.id, { to: "withdrawn", note: "Moved away." });
    await createApplication(
      conn.app,
      s.head,
      applicant(level, undefined, { status: "inquiry", source: "referral" }),
    );
    const report = await getAdmissionsReport(conn.app, s.head);
    expect(report.byLevel).toMatchObject([
      { label: "Basic 4", total: 2, applied: 1, offered: 1, withdrawn: 1, enrolled: 0 },
    ]);
    expect(report.bySource.map((r) => r.key).sort()).toEqual(["referral", "walk_in"]);
    const { csv } = await exportDataset(conn.app, s.owner, "applications");
    expect(csv).toContain("withdrawn");
    expect(csv).toContain("Akua Boateng");
  });
});

describe("retention (D-R3-2)", () => {
  it("removes personal details from declined and withdrawn applications 12 months after they close", async () => {
    const s = await school();
    const level = await basic4(s);
    const declined = await createApplication(conn.app, s.head, applicant(level));
    await moveApplication(conn.app, s.head, declined.id, { to: "declined", note: "Full." });
    const open = await createApplication(conn.app, s.head, applicant(level));
    const soon = new Date(Date.now() + 11 * 30 * 86_400_000);
    await eraseExpiredApplications(conn.app, soon);
    expect((await getApplication(conn.app, s.head, declined.id))!.erased).toBe(false);
    const later = new Date(Date.now() + 13 * 31 * 86_400_000);
    expect(await eraseExpiredApplications(conn.app, later)).toBeGreaterThanOrEqual(1);
    const gone = (await getApplication(conn.app, s.head, declined.id))!;
    expect(gone).toMatchObject({
      erased: true,
      child: { name: "Details removed", firstName: null },
      guardian: { phone: null },
    });
    expect((await getApplication(conn.app, s.head, open.id))!.erased).toBe(false);
    // Kept for the report, still declined.
    expect((await getAdmissionsReport(conn.app, s.head)).byLevel[0]).toMatchObject({ total: 2, declined: 1 });
  });
});

describe("online applications (ADM-02)", () => {
  async function openForms(s: School) {
    await saveOnlineApplications(conn.app, s.head, { onlineApplications: "on" });
    return basic4(s);
  }
  const codeFor = async (phone: string) => {
    const [row] = await conn.owner
      .select({ payload: notificationOutbox.payload })
      .from(notificationOutbox)
      .where(
        and(eq(notificationOutbox.template, "application_code"), eq(notificationOutbox.recipient, phone)),
      )
      .orderBy(notificationOutbox.createdAt);
    return String((row!.payload as { code: string }).code);
  };

  it("are closed until the school opens them", async () => {
    const s = await school();
    expect(await getOnlineApplicationForm(conn.app, s.tenant.slug)).toBeNull();
    await expect(
      startOnlineApplication(conn.app, s.tenant.slug, applicant(await basic4(s))),
    ).rejects.toMatchObject({ code: "applications_closed" });
  });

  it("become an application only once the phone is confirmed by the SMS code", async () => {
    const s = await school();
    const level = await openForms(s);
    const form = (await getOnlineApplicationForm(conn.app, s.tenant.slug))!;
    expect(form.levels.map((l) => l.id)).toContain(level);
    const phone = randomPhone();
    const e164 = normalizePhone(phone)!;
    const { verificationId } = await startOnlineApplication(
      conn.app,
      s.tenant.slug,
      applicant(level, phone),
      {
        ipAddress: "198.51.100.7",
      },
    );
    // Nothing is an application yet, and the code SMS is charged to the school.
    expect((await listApplications(conn.app, s.head, { status: "open" })).rows).toEqual([]);
    const usage = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select().from(smsUsage).where(eq(smsUsage.kind, "application_code")),
    );
    expect(usage).toHaveLength(1);
    const code = await codeFor(e164);
    await expect(
      confirmOnlineApplication(conn.app, s.tenant.slug, {
        verificationId,
        code: code === "000000" ? "111111" : "000000",
      }),
    ).rejects.toMatchObject({ code: "code_invalid" });
    const { reference } = await confirmOnlineApplication(conn.app, s.tenant.slug, { verificationId, code });
    expect(await confirmOnlineApplication(conn.app, s.tenant.slug, { verificationId, code })).toEqual({
      reference,
    });
    const [row] = (await listApplications(conn.app, s.head, { status: "applied" })).rows;
    expect(row).toMatchObject({ reference, source: "online", guardianPhone: e164, childName: "Esi Boateng" });
  });

  it("refuse bots and limit codes per number", async () => {
    const s = await school();
    const level = await openForms(s);
    await expect(
      startOnlineApplication(conn.app, s.tenant.slug, { ...applicant(level), website: "http://spam.test" }),
    ).rejects.toMatchObject({ code: "application_refused" });
    const phone = randomPhone();
    for (let i = 0; i < ONLINE_LIMITS.perPhone15Min; i++)
      await startOnlineApplication(conn.app, s.tenant.slug, applicant(level, phone));
    await expect(
      startOnlineApplication(conn.app, s.tenant.slug, applicant(level, phone)),
    ).rejects.toMatchObject({
      code: "application_throttled",
    });
  });

  it("expire after 15 minutes", async () => {
    const s = await school();
    const level = await openForms(s);
    const phone = randomPhone();
    const past = new Date(Date.now() - 20 * 60_000);
    const { verificationId } = await startOnlineApplication(
      conn.app,
      s.tenant.slug,
      applicant(level, phone),
      {},
      past,
    );
    const code = await codeFor(normalizePhone(phone)!);
    await expect(
      confirmOnlineApplication(conn.app, s.tenant.slug, { verificationId, code }),
    ).rejects.toMatchObject({
      code: "verification_invalid",
    });
  });
});
