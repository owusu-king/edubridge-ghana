import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, learnerRecords, priorRecords, students, transfers } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import {
  exportLearnerRecord,
  importLearnerRecord,
  listPriorRecords,
  revokeLearnerRecord,
  verifyLearnerPackage,
} from "@/server/passport/records";
import { canonicalJson, checkSignature } from "@/server/passport/signing";
import {
  acceptTransfer,
  answerConsent,
  approveTransfer,
  declineTransfer,
  listConsentRequests,
  listTransfers,
  requestTransfer,
  startTransferAsGuardian,
} from "@/server/passport/transfers";
import { addGuardian, listGuardians } from "@/server/students/guardians";
import { getStudent } from "@/server/students/service";
import { normalizePhone } from "@/lib/phone";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);
const randomPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;

/** Two schools; Ama (with her mother's number) at the first. */
async function setUp() {
  const from = await school();
  const to = await school();
  const ama = (await from.add("Ama", from.classA)).id;
  const phone = randomPhone();
  await addGuardian(conn.app, from.owner, ama, { fullName: "Akua Mensah", phone, relationship: "mother" });
  return { from, to, ama, phone: normalizePhone(phone)! };
}

const learnerOf = async (s: School, id: string) =>
  (
    await asSchool(s, (tx) => tx.select({ l: students.learnerId }).from(students).where(eq(students.id, id)))
  )[0]!.l;

describe("learner records", () => {
  it("are signed, verifiable, and refuse any change", async () => {
    const { from, ama } = await setUp();
    const pkg = await exportLearnerRecord(conn.app, from.owner, ama);
    expect(pkg.record).toMatchObject({
      learnerId: await learnerOf(from, ama),
      issuer: { schoolId: from.tenant.id },
      student: { firstName: "Ama", lastName: "Mensah" },
      guardians: [{ fullName: "Akua Mensah", relationship: "mother", primary: true }],
      enrolments: [{ className: "Basic 4A", term: "Term 1" }],
    });
    expect(await verifyLearnerPackage(conn.app, pkg)).toMatchObject({
      status: "valid",
      student: "Ama Mensah",
    });

    // One changed character breaks the signature.
    const forged = structuredClone(pkg);
    (forged.record.student as { lastName: string }).lastName = "Asante";
    expect(await verifyLearnerPackage(conn.app, forged)).toMatchObject({ status: "invalid" });
    // Keys are sorted before signing, so the order of fields in the file does not matter.
    const reordered = JSON.parse(canonicalJson(pkg)) as typeof pkg;
    expect(checkSignature(reordered).status).toBe("valid");

    // The issuing school can revoke a record issued in error.
    const [row] = await asSchool(from, (tx) =>
      tx.select({ id: learnerRecords.id }).from(learnerRecords).where(eq(learnerRecords.studentId, ama)),
    );
    await revokeLearnerRecord(conn.app, from.owner, row!.id, { reason: "Issued to the wrong family" });
    expect(await verifyLearnerPackage(conn.app, pkg)).toMatchObject({ status: "revoked" });
    await expect(exportLearnerRecord(conn.app, from.teacher, ama)).rejects.toThrow(ForbiddenError);
    await expect(exportLearnerRecord(conn.app, from.bursar, ama)).rejects.toThrow(ForbiddenError);
  });

  it("import as verified (keeping the learner identity) or unverified, and changed files are refused", async () => {
    const { from, to, ama } = await setUp();
    const pkg = await exportLearnerRecord(conn.app, from.owner, ama);
    const verified = await importLearnerRecord(conn.app, to.owner, {
      file: JSON.stringify(pkg),
      classId: to.classA,
    });
    expect(verified).toMatchObject({ verified: true, created: true });
    expect(await learnerOf(to, verified.studentId)).toBe(await learnerOf(from, ama));
    const created = (await getStudent(conn.app, to.owner, verified.studentId))!;
    expect(created).toMatchObject({ firstName: "Ama", lastName: "Mensah" });
    expect((await listPriorRecords(conn.app, to.owner, verified.studentId))[0]).toMatchObject({
      verified: true,
      source: "import",
      issuerName: from.tenant.name,
    });
    // The same child cannot be imported twice as two students.
    await expect(
      importLearnerRecord(conn.app, to.owner, { file: JSON.stringify(pkg) }),
    ).rejects.toMatchObject({
      code: "learner_already_here",
    });

    // From a school not on EduBridge: the documented format without a signature, kept as unverified.
    const outside = {
      format: "edubridge.learner-record",
      version: 1,
      record: {
        issuer: { name: "Hilltop Academy" },
        student: { firstName: "Kofi", lastName: "Boadu", sex: "male" },
      },
    };
    const unverified = await importLearnerRecord(conn.app, to.owner, { file: JSON.stringify(outside) });
    expect(unverified.verified).toBe(false);
    const forged = structuredClone(pkg);
    (forged.record.student as { firstName: string }).firstName = "Abena";
    await expect(
      importLearnerRecord(conn.app, to.owner, { file: JSON.stringify(forged) }),
    ).rejects.toMatchObject({
      code: "record_invalid",
    });
    await expect(importLearnerRecord(conn.app, to.owner, { file: "not json" })).rejects.toMatchObject({
      code: "record_invalid",
    });
  });
});

describe("transfers between schools", () => {
  it("need the family's consent, the first school's approval and the new school's acceptance", async () => {
    const { from, to, ama, phone } = await setUp();
    await billTerm(conn.app, from.bursar, from.termId);
    const id = await requestTransfer(conn.app, to.head, {
      fromSchoolId: from.tenant.id,
      firstName: "ama",
      lastName: " MENSAH ",
      guardianPhone: phone,
    });
    // The first school sees nothing until the family consents; the new school only that it is waiting.
    expect(await listTransfers(conn.app, from.owner)).toEqual([]);
    expect((await listTransfers(conn.app, to.head))[0]).toMatchObject({
      status: "awaiting_consent",
      direction: "incoming",
    });

    const requests = await listConsentRequests(conn.app, phone);
    expect(requests).toEqual([
      expect.objectContaining({ id, childName: "ama MENSAH", toSchoolName: to.tenant.name }),
    ]);
    // Another number cannot answer.
    await expect(
      answerConsent(conn.app, normalizePhone(randomPhone())!, {
        slug: from.tenant.slug,
        transferId: id,
        allow: true,
      }),
    ).rejects.toMatchObject({ code: "transfer_not_found" });
    await answerConsent(conn.app, phone, { slug: from.tenant.slug, transferId: id, allow: true });

    const outgoing = (await listTransfers(conn.app, from.owner))[0]!;
    expect(outgoing).toMatchObject({
      status: "awaiting_origin",
      fromStudentId: ama,
      balancePesewas: 100_000,
    });
    // Accepting before approval is not possible, nor approving from the wrong school.
    await expect(acceptTransfer(conn.app, to.head, id, {})).rejects.toMatchObject({
      code: "transfer_not_found",
    });
    await expect(approveTransfer(conn.app, to.head, id)).rejects.toMatchObject({
      code: "transfer_not_found",
    });
    await expect(approveTransfer(conn.app, from.bursar, id)).rejects.toThrow(ForbiddenError);

    await approveTransfer(conn.app, from.head, id);
    const [left] = await asSchool(from, (tx) => tx.select().from(students).where(eq(students.id, ama)));
    expect(left).toMatchObject({ status: "withdrawn", leftReason: `Transferred to ${to.tenant.name}` });

    const joined = await acceptTransfer(conn.app, to.head, id, { classId: to.classA });
    expect(await learnerOf(to, joined.studentId)).toBe(await learnerOf(from, ama));
    const guardiansThere = await listGuardians(conn.app, to.owner, joined.studentId);
    expect(guardiansThere!.map((g) => g.fullName)).toEqual(["Akua Mensah"]);
    const [prior] = await listPriorRecords(conn.app, to.owner, joined.studentId);
    expect(prior).toMatchObject({ source: "transfer", verified: true, issuerName: from.tenant.name });
    expect((await listTransfers(conn.app, to.head))[0]).toMatchObject({
      status: "completed",
      toStudentId: joined.studentId,
    });

    // Each school audits its own steps.
    const actions = async (s: School) =>
      (
        await asSchool(s, (tx) =>
          tx
            .select({ action: auditEvents.action })
            .from(auditEvents)
            .where(eq(auditEvents.tenantId, s.tenant.id)),
        )
      ).map((a) => a.action);
    expect(await actions(from)).toEqual(
      expect.arrayContaining(["transfer.consented", "learner_record.issued", "transfer.approved"]),
    );
    expect(await actions(to)).toEqual(expect.arrayContaining(["transfer.requested", "transfer.accepted"]));
    // Completed transfers cannot move again; the stored package never changes.
    await expect(
      asSchool(to, (tx) =>
        tx.update(transfers).set({ status: "awaiting_origin" }).where(eq(transfers.id, id)),
      ),
    ).rejects.toThrow();
    await expect(
      asSchool(to, (tx) => tx.delete(priorRecords).where(eq(priorRecords.studentId, joined.studentId))),
    ).rejects.toThrow();
  });

  it("never tell the requesting school whether the child was found", async () => {
    const { from, to, phone } = await setUp();
    // Wrong name: the request exists for the requester, but reaches no family.
    const id = await requestTransfer(conn.app, to.head, {
      fromSchoolId: from.tenant.id,
      firstName: "Esi",
      lastName: "Mensah",
      guardianPhone: phone,
    });
    expect((await listTransfers(conn.app, to.head))[0]).toMatchObject({ id, status: "awaiting_consent" });
    expect(await listConsentRequests(conn.app, phone)).toEqual([]);
    await expect(
      answerConsent(conn.app, phone, { slug: from.tenant.slug, transferId: id, allow: true }),
    ).rejects.toMatchObject({ code: "transfer_not_found" });
  });

  it("can be started by the family and declined by the first school", async () => {
    const { from, to, ama, phone } = await setUp();
    const id = await startTransferAsGuardian(conn.app, phone, {
      slug: from.tenant.slug,
      studentId: ama,
      toSchoolId: to.tenant.id,
    });
    await expect(
      startTransferAsGuardian(conn.app, phone, {
        slug: from.tenant.slug,
        studentId: ama,
        toSchoolId: to.tenant.id,
      }),
    ).rejects.toMatchObject({ code: "transfer_open" });
    // A number that does not reach the child cannot start one.
    await expect(
      startTransferAsGuardian(conn.app, normalizePhone(randomPhone())!, {
        slug: from.tenant.slug,
        studentId: ama,
        toSchoolId: to.tenant.id,
      }),
    ).rejects.toMatchObject({ code: "student_not_found" });
    expect((await listTransfers(conn.app, from.owner))[0]).toMatchObject({ id, requestedBy: "guardian" });
    await declineTransfer(conn.app, from.owner, id, { reason: "Please see the head teacher first." });
    expect((await listTransfers(conn.app, to.head))[0]).toMatchObject({
      status: "declined",
      declineReason: "Please see the head teacher first.",
    });
    const [still] = await asSchool(from, (tx) =>
      tx
        .select({ status: students.status })
        .from(students)
        .where(and(eq(students.id, ama))),
    );
    expect(still!.status).toBe("active");
  });
});
