import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { ledgerEntries, notificationOutbox, smsUsage } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import { postAnnouncement } from "@/server/messages/announcements";
import { findParentReceiptId, getParentFamilyStatement } from "@/server/parents/portal";
import { getFamilyStatement } from "@/server/fees/family-statement";
import { renderFamilyStatementPdf } from "@/web/pdf/statement";
import { getAnnouncementSms, setAnnouncementSms } from "@/server/parents/preferences";
import { updateEntitlements } from "@/server/platform/service";
import { addGuardian, inviteGuardian, listGuardians, setParentAccess } from "@/server/students/guardians";
import { setGuardianFlags } from "@/server/students/profile";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { saveMessageSettings } from "@/server/tenancy/preferences";
import { FEATURES } from "@/lib/plan";
import { todayIn } from "@/lib/format";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const MOTHER = "+233245550101";
const FATHER = "+233245550202";

const outbox = (s: School, kind: (typeof smsUsage.$inferSelect)["kind"]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
    tx
      .select({
        recipient: notificationOutbox.recipient,
        payload: notificationOutbox.payload,
        studentId: smsUsage.studentId,
      })
      .from(smsUsage)
      .innerJoin(notificationOutbox, eq(notificationOutbox.id, smsUsage.outboxId))
      .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, kind))),
  );

const fresh = (s: School, c: TenantContext) =>
  resolveTenantContext(conn.app, s.tenant.slug, c.userId) as Promise<TenantContext>;

async function family() {
  const s = await school();
  const ama = await s.add("Ama", s.classA);
  const mother = await addGuardian(conn.app, s.owner, ama.id, {
    fullName: "Akosua Mensah",
    phone: "024 555 0101",
    relationship: "mother",
  });
  const father = await addGuardian(conn.app, s.owner, ama.id, {
    fullName: "Kwame Mensah",
    phone: "024 555 0202",
    relationship: "father",
  });
  return { s, ama, mother: mother.guardianId, father: father.guardianId };
}

describe("messages to families", () => {
  it("sends the receipt SMS, with its link, to the guardian who pays the fees", async () => {
    const { s, ama, father } = await family();
    await saveMessageSettings(conn.app, s.bursar, {
      paymentReceiptSms: true,
      autoRemindersEnabled: false,
      autoReminderIntervalDays: "14",
      autoReminderMin: "100",
    });
    await setGuardianFlags(conn.app, s.owner, ama.id, father, {
      isFeePayer: true,
      isEmergencyContact: false,
      canPickUp: true,
      receivesMessages: true,
    });
    const { receiptNumber, paymentId } = await recordPayment(conn.app, s.bursar, {
      studentId: ama.id,
      amount: "250",
      method: "cash",
      reference: "",
      paidOn: todayIn(s.tenant.timezone),
      idempotencyKey: randomUUID(),
    });
    const [sms] = await outbox(s, "payment_receipt");
    expect(sms).toMatchObject({ recipient: FATHER, payload: { receiptNumber, schoolSlug: s.tenant.slug } });

    // The link opens the receipt only for a number linked to the child.
    expect(await findParentReceiptId(conn.app, FATHER, s.tenant.slug, receiptNumber)).toBe(paymentId);
    expect(await findParentReceiptId(conn.app, MOTHER, s.tenant.slug, receiptNumber)).toBe(paymentId);
    expect(await findParentReceiptId(conn.app, "+233200000000", s.tenant.slug, receiptNumber)).toBeNull();
    expect(await findParentReceiptId(conn.app, FATHER, s.tenant.slug, "R999999")).toBeNull();
    expect(await findParentReceiptId(conn.app, FATHER, s.tenant.slug, "x' or 1=1")).toBeNull();
  });

  it("tells each family billed their new balance when asked, within the plan's SMS", async () => {
    const { s } = await family();
    await s.add("Kofi", s.classA); // no guardian phone
    const quiet = await billTerm(conn.app, s.bursar, s.termId);
    expect(quiet.notified).toBe(0);
    expect(await outbox(s, "fees_billed")).toEqual([]);

    // A second school, with an SMS limit too small for its families: billing is refused as a whole.
    const t = await family();
    const admin = await createUser(conn.owner, "EduBridge Staff");
    await makePlatformAdmin(conn.owner, admin.id);
    await updateEntitlements(conn.app, admin.id, t.s.tenant.id, {
      planName: "Small",
      maxCampuses: 2,
      maxStudents: null,
      maxSmsPerMonth: 0,
      features: [...FEATURES],
    });
    await expect(
      billTerm(conn.app, await fresh(t.s, t.s.bursar), t.s.termId, { notify: true }),
    ).rejects.toMatchObject({
      code: "sms_limit",
    });
    const charges = await withTenant(conn.owner, { tenantId: t.s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.tenantId, t.s.tenant.id)),
    );
    expect(charges).toEqual([]);

    // With room: one SMS per billed child that has a number.
    const u = await family();
    await u.s.add("Kofi", u.s.classA);
    const billed = await billTerm(conn.app, u.s.bursar, u.s.termId, { notify: true });
    expect(billed.notified).toBe(1);
    const [sms] = await outbox(u.s, "fees_billed");
    expect(sms).toMatchObject({
      recipient: MOTHER,
      studentId: u.ama.id,
      payload: { studentFirstName: "Ama", termLabel: "Term 1 2026/2027", balancePesewas: 100000 },
    });
  });

  it("leaves out guardians who turned announcement SMS off, and lets parents turn it back on", async () => {
    const { s, ama, father } = await family();
    const post = () =>
      postAnnouncement(conn.app, s.head, {
        title: "Sports day",
        body: "Friday.",
        audience: "school",
        audienceId: null,
        sms: true,
      });
    expect((await post()).sms).toBe(2);

    expect(await getAnnouncementSms(conn.app, MOTHER, s.tenant.slug)).toBe(true);
    await setAnnouncementSms(conn.app, MOTHER, s.tenant.slug, { on: false });
    expect(await getAnnouncementSms(conn.app, MOTHER, s.tenant.slug)).toBe(false);
    expect((await post()).sms).toBe(1);

    // Staff can set it for a guardian too.
    await setGuardianFlags(conn.app, s.owner, ama.id, father, {
      isFeePayer: false,
      isEmergencyContact: false,
      canPickUp: false,
      receivesMessages: false,
    });
    expect((await post()).sms).toBe(0);

    await setAnnouncementSms(conn.app, MOTHER, s.tenant.slug, { on: true });
    expect((await post()).sms).toBe(1);
    // Someone not on file at the school cannot change anything there.
    await expect(
      setAnnouncementSms(conn.app, "+233200000000", s.tenant.slug, { on: false }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await getAnnouncementSms(conn.app, "+233200000000", s.tenant.slug)).toBeNull();
  });

  it("invites a guardian to the parent view by SMS, at most once a day", async () => {
    const { s, ama, mother, father } = await family();
    await expect(inviteGuardian(conn.app, s.teacher, ama.id, mother)).rejects.toThrow(ForbiddenError);
    const now = new Date();
    await inviteGuardian(conn.app, s.head, ama.id, mother, now);
    const [sms] = await outbox(s, "portal_invitation");
    expect(sms).toMatchObject({ recipient: MOTHER, studentId: ama.id, payload: { studentFirstName: "Ama" } });
    const links = (await listGuardians(conn.app, s.head, ama.id))!;
    expect(links.find((g) => g.guardianId === mother)!.portalInvitedAt).toEqual(now);

    await expect(inviteGuardian(conn.app, s.head, ama.id, mother, now)).rejects.toMatchObject({
      code: "invited_recently",
    });
    await inviteGuardian(conn.app, s.head, ama.id, mother, new Date(now.getTime() + 25 * 3600_000));
    expect(await outbox(s, "portal_invitation")).toHaveLength(2);

    await setParentAccess(conn.app, s.head, father, { blocked: true });
    await expect(inviteGuardian(conn.app, s.head, ama.id, father)).rejects.toMatchObject({
      code: "parent_blocked",
    });
    // A guardian of another child cannot be invited through this one.
    const kofi = await s.add("Kofi", s.classA);
    await expect(inviteGuardian(conn.app, s.head, kofi.id, mother)).rejects.toMatchObject({
      code: "guardian_not_found",
    });
  });
});

describe("family statements", () => {
  it("put brothers and sisters who share a guardian on one statement, for staff and for the parent", async () => {
    const { s, ama } = await family();
    const kofi = await s.add("Kofi", s.classB);
    await addGuardian(conn.app, s.owner, kofi.id, {
      fullName: "Akosua Mensah",
      phone: "024 555 0101",
      relationship: "mother",
    });
    const loner = await s.add("Yaw", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);

    const staff = (await getFamilyStatement(conn.app, s.bursar, ama.id))!;
    expect(staff.familyName).toBe("Family of Akosua Mensah");
    expect(staff.children.map((c) => c.account.student.name).sort()).toEqual(["Ama Mensah", "Kofi Mensah"]);
    expect(staff.children.map((c) => c.account.balancePesewas)).toEqual([100000, 100000]);
    // The East accountant sees only Kofi's account (Basic 4B is at East); Ama's page is out of reach.
    expect(await getFamilyStatement(conn.app, s.eastBursar, ama.id)).toBeNull();
    expect(
      (await getFamilyStatement(conn.app, s.eastBursar, kofi.id))!.children.map((c) => c.account.student.id),
    ).toEqual([kofi.id]);
    expect((await getFamilyStatement(conn.app, s.bursar, loner.id))!.children).toHaveLength(1);

    const parent = (await getParentFamilyStatement(conn.app, MOTHER, s.tenant.slug))!;
    expect(parent.children.map((c) => c.account.student.id).sort()).toEqual([ama.id, kofi.id].sort());
    expect(await getParentFamilyStatement(conn.app, "+233200000000", s.tenant.slug)).toBeNull();
    const pdf = await renderFamilyStatementPdf({
      familyName: staff.familyName,
      children: staff.children,
      schoolName: s.tenant.name,
      asOf: todayIn(s.tenant.timezone),
      from: null,
      to: null,
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
  });
});
