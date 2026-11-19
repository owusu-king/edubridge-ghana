import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, storedFiles } from "@/server/db/schema";
import { billTerm, getStudentAccount } from "@/server/fees/ledger";
import {
  addPaymentEvidence,
  downloadPaymentEvidence,
  listPaymentEvidence,
  removePaymentEvidence,
} from "@/server/fees/evidence";
import { getReceipt, recordPayment } from "@/server/fees/payments";
import { checkFile, sniff } from "@/server/files/service";
import { todayIn } from "@/lib/format";
import { addGuardian, listGuardians } from "@/server/students/guardians";
import {
  downloadStudentDocument,
  getStudentMedical,
  getStudentPhoto,
  listStudentDocuments,
  removeStudentDocument,
  removeStudentPhoto,
  saveStudentMedical,
  setGuardianFlags,
  setStudentPhoto,
  uploadStudentDocument,
} from "@/server/students/profile";
import { createStudent, getStudent, listStudents, setStudentStatus } from "@/server/students/service";
import {
  getBranding,
  getDocumentLogo,
  readSchoolLogo,
  removeSchoolLogo,
  saveBrandColor,
  setSchoolLogo,
} from "@/server/tenancy/branding";
import { saveAdmissionFormat } from "@/server/tenancy/preferences";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);
const PDF = Buffer.from("%PDF-1.4\n% synthetic test document\n");

const audits = (s: School, action: string) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, action))),
  );

describe("stored files", () => {
  it("decides the type from the bytes, not the name, and applies each purpose's limits", () => {
    expect([sniff(PNG), sniff(JPEG), sniff(WEBP), sniff(PDF), sniff(Buffer.from("MZ\x90\x00"))]).toEqual([
      "png",
      "jpeg",
      "webp",
      "pdf",
      null,
    ]);
    expect(checkFile("school_logo", PNG).mime).toBe("image/png");
    expect(checkFile("student_document", PDF).mime).toBe("application/pdf");
    // A PDF is not a photo; WebP is not accepted as a document; empty and oversized files are refused.
    expect(() => checkFile("student_photo", PDF)).toThrow(/PNG, JPEG or WebP/);
    expect(() => checkFile("student_document", WEBP)).toThrow(/PDF, PNG or JPEG/);
    expect(() => checkFile("student_photo", Buffer.alloc(0))).toThrow(/Choose a file/);
    const bigLogo = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
    expect(() => checkFile("school_logo", bigLogo)).toThrow(/300 KB/);
    expect(checkFile("student_photo", bigLogo).mime).toBe("image/png"); // within 500 KB
  });
});

describe("student photo and documents", () => {
  it("keeps one photo, readable by anyone who can see the student", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await expect(
      setStudentPhoto(conn.app, s.teacher, ama.id, { filename: "ama.png", bytes: PNG }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      setStudentPhoto(conn.app, s.owner, ama.id, { filename: "virus.png", bytes: PDF }),
    ).rejects.toMatchObject({ code: "file_invalid" });
    await setStudentPhoto(conn.app, s.owner, ama.id, { filename: "ama.png", bytes: PNG });
    await setStudentPhoto(conn.app, s.owner, ama.id, { filename: "ama2.jpg", bytes: JPEG });
    expect((await getStudent(conn.app, s.owner, ama.id))!.photo).toBe(true);
    expect((await getStudentPhoto(conn.app, s.head, ama.id))!.mime).toBe("image/jpeg");
    // The replaced photo is marked removed, not left live.
    const files = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(storedFiles).where(eq(storedFiles.ownerId, ama.id)),
    );
    expect(files.filter((f) => f.removedAt === null)).toHaveLength(1);
    await removeStudentPhoto(conn.app, s.owner, ama.id);
    expect(await getStudentPhoto(conn.app, s.head, ama.id)).toBeNull();
    expect((await getStudent(conn.app, s.owner, ama.id))!.photo).toBe(false);
  });

  it("keeps documents private to office and finance roles, records every download, and isolates schools", async () => {
    const s = await school();
    const other = await school();
    const ama = await s.add("Ama", s.classA);
    const id = await uploadStudentDocument(conn.app, s.owner, ama.id, {
      filename: "birth cert.pdf",
      bytes: PDF,
    });
    expect((await listStudentDocuments(conn.app, s.bursar, ama.id)).map((d) => d.filename)).toEqual([
      "birth cert.pdf",
    ]);
    await expect(listStudentDocuments(conn.app, s.teacher, ama.id)).rejects.toThrow(ForbiddenError);
    await expect(downloadStudentDocument(conn.app, s.teacher, ama.id, id)).rejects.toThrow(ForbiddenError);

    const file = await downloadStudentDocument(conn.app, s.head, ama.id, id);
    expect(file!.content.equals(PDF)).toBe(true);
    const downloads = await audits(s, "student.document_downloaded");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.actorUserId).toBe(s.head.userId);

    // Another school cannot reach the student or the file, even with both ids.
    await expect(downloadStudentDocument(conn.app, other.owner, ama.id, id)).rejects.toMatchObject({
      code: "student_not_found",
    });
    // A document of one student cannot be fetched through another student of the same school.
    const kofi = await s.add("Kofi", s.classA);
    expect(await downloadStudentDocument(conn.app, s.head, kofi.id, id)).toBeNull();
    await expect(removeStudentDocument(conn.app, s.owner, kofi.id, id)).rejects.toMatchObject({
      code: "not_found",
    });

    await removeStudentDocument(conn.app, s.owner, ama.id, id);
    expect(await listStudentDocuments(conn.app, s.owner, ama.id)).toEqual([]);
    expect(await downloadStudentDocument(conn.app, s.owner, ama.id, id)).toBeNull();
  });
});

describe("payment evidence", () => {
  it("attaches files to a payment for finance staff in scope, records downloads, and never changes the payment", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const paid = await recordPayment(conn.app, s.bursar, {
      studentId: ama.id,
      amount: "200",
      method: "bank_deposit",
      reference: "SLIP-1",
      paidOn: todayIn(s.tenant.timezone),
      idempotencyKey: randomUUID(),
    });
    await expect(
      addPaymentEvidence(conn.app, s.head, paid.paymentId, { filename: "slip.pdf", bytes: PDF }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      addPaymentEvidence(conn.app, s.bursar, paid.paymentId, { filename: "slip.webp", bytes: WEBP }),
    ).rejects.toMatchObject({ code: "file_invalid" });
    // The East accountant cannot reach a Main campus payment.
    await expect(
      addPaymentEvidence(conn.app, s.eastBursar, paid.paymentId, { filename: "slip.pdf", bytes: PDF }),
    ).rejects.toMatchObject({ code: "payment_not_found" });
    const fileId = await addPaymentEvidence(conn.app, s.bursar, paid.paymentId, {
      filename: "slip.pdf",
      bytes: PDF,
    });
    expect((await listPaymentEvidence(conn.app, s.owner, paid.paymentId)).map((f) => f.filename)).toEqual([
      "slip.pdf",
    ]);
    expect(await listPaymentEvidence(conn.app, s.eastBursar, paid.paymentId)).toEqual([]);
    expect(
      (await downloadPaymentEvidence(conn.app, s.owner, paid.paymentId, fileId))!.content.equals(PDF),
    ).toBe(true);
    expect(await audits(s, "payment.evidence_downloaded")).toHaveLength(1);
    expect((await getReceipt(conn.app, s.owner, paid.paymentId))!.amountPesewas).toBe(20000);

    await expect(removePaymentEvidence(conn.app, s.bursar, paid.paymentId, fileId)).rejects.toThrow(
      ForbiddenError,
    );
    await removePaymentEvidence(conn.app, s.owner, paid.paymentId, fileId);
    expect(await listPaymentEvidence(conn.app, s.owner, paid.paymentId)).toEqual([]);
  });
});

describe("medical information", () => {
  it("is limited to the Proprietor, head and office, and every view is recorded without the contents", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    await expect(getStudentMedical(conn.app, s.teacher, ama.id)).rejects.toThrow(ForbiddenError);
    await expect(getStudentMedical(conn.app, s.bursar, ama.id)).rejects.toThrow(ForbiddenError);
    expect(await getStudentMedical(conn.app, s.head, ama.id)).toBeNull();
    await saveStudentMedical(conn.app, s.head, ama.id, {
      bloodGroup: "O+",
      allergies: "Peanuts",
      conditions: "",
      medications: "",
      doctorName: "",
      doctorPhone: "",
      emergencyNotes: "Inhaler in the office",
    });
    const info = await getStudentMedical(conn.app, s.owner, ama.id);
    expect(info).toMatchObject({ bloodGroup: "O+", allergies: "Peanuts", conditions: null });
    expect(await audits(s, "student.medical_viewed")).toHaveLength(2);
    const [changed] = await audits(s, "student.medical_changed");
    expect(changed!.metadata).toEqual({ fields: ["bloodGroup", "allergies", "emergencyNotes"] });
    expect(JSON.stringify(changed!.metadata)).not.toContain("Peanuts");
  });
});

describe("guardian roles", () => {
  it("records who pays, who is an emergency contact, who may collect, and who gets announcements", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const { guardianId } = await addGuardian(conn.app, s.owner, ama.id, {
      fullName: "Akosua Mensah",
      phone: "024 555 0101",
      relationship: "mother",
    });
    const flags = { isFeePayer: true, isEmergencyContact: false, canPickUp: true, receivesMessages: false };
    await expect(setGuardianFlags(conn.app, s.teacher, ama.id, guardianId, flags)).rejects.toThrow(
      ForbiddenError,
    );
    await setGuardianFlags(conn.app, s.owner, ama.id, guardianId, flags);
    const [link] = (await listGuardians(conn.app, s.owner, ama.id))!;
    expect(link).toMatchObject(flags);
    const kofi = await s.add("Kofi", s.classA);
    await expect(setGuardianFlags(conn.app, s.owner, kofi.id, guardianId, flags)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("student statuses", () => {
  it("allows only sensible changes, records the reason, and bills suspended but not departed students", async () => {
    const s = await school();
    const ama = await s.add("Ama", s.classA);
    const kofi = await s.add("Kofi", s.classA);
    await setStudentStatus(conn.app, s.owner, ama.id, "suspended", "Two weeks, disciplinary");
    await setStudentStatus(conn.app, s.owner, kofi.id, "withdrawn", "Family relocated");
    const detail = await getStudent(conn.app, s.owner, ama.id);
    expect(detail).toMatchObject({ status: "suspended", statusReason: "Two weeks, disciplinary" });
    expect(detail!.currentClass?.name).toBe("Basic 4A"); // still placed

    await expect(setStudentStatus(conn.app, s.owner, kofi.id, "graduated")).rejects.toMatchObject({
      code: "status_change_invalid",
    });
    await expect(setStudentStatus(conn.app, s.owner, ama.id, "graduated")).rejects.toMatchObject({
      code: "status_change_invalid",
    });
    await expect(setStudentStatus(conn.app, s.teacher, ama.id, "active")).rejects.toThrow(ForbiddenError);

    await billTerm(conn.app, s.bursar, s.termId);
    expect((await getStudentAccount(conn.app, s.bursar, ama.id))!.balancePesewas).toBe(100000);
    expect((await getStudentAccount(conn.app, s.bursar, kofi.id))!.balancePesewas).toBe(0);

    await setStudentStatus(conn.app, s.owner, ama.id, "active");
    expect(await getStudent(conn.app, s.owner, ama.id)).toMatchObject({
      status: "active",
      statusReason: null,
    });
    const [suspended] = await audits(s, "student.suspended");
    expect(suspended!.metadata).toMatchObject({
      from: "active",
      to: "suspended",
      reason: "Two weeks, disciplinary",
    });
  });

  it("keeps a preferred name", async () => {
    const s = await school();
    const created = await createStudent(conn.app, s.owner, {
      firstName: "Nana Akua",
      lastName: "Boateng",
      preferredName: "Akua",
      sex: "female",
      classId: s.classA,
    });
    expect((await getStudent(conn.app, s.owner, created.id))!.preferredName).toBe("Akua");
  });
});

describe("finding students", () => {
  it("by a guardian's phone number in any common form, and by preferred name", async () => {
    const s = await school();
    const ama = await createStudent(conn.app, s.owner, {
      firstName: "Nana Ama",
      lastName: "Boateng",
      preferredName: "Maame",
      sex: "female",
      classId: s.classA,
    });
    await s.add("Kofi", s.classA);
    await addGuardian(conn.app, s.owner, ama.id, {
      fullName: "Akosua Boateng",
      phone: "024 555 0101",
      relationship: "mother",
    });
    const find = async (q: string) => (await listStudents(conn.app, s.owner, { q })).rows.map((r) => r.id);
    expect(await find("0245550101")).toEqual([ama.id]);
    expect(await find("+233 24 555 0101")).toEqual([ama.id]);
    expect(await find("555 0101")).toEqual([ama.id]);
    expect(await find("Maame")).toEqual([ama.id]);
    expect(await find("0201234567")).toEqual([]);
  });
});

describe("admission numbers", () => {
  it("follows the school's prefix and digits for new students only", async () => {
    const s = await school();
    const first = await s.add("Ama", s.classA);
    expect(first.admissionNumber).toBe("0001");
    await expect(
      saveAdmissionFormat(conn.app, s.bursar, { admissionPrefix: "KR/", admissionDigits: 5 }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      saveAdmissionFormat(conn.app, s.owner, { admissionPrefix: "K R", admissionDigits: 5 }),
    ).rejects.toThrow();
    await expect(
      saveAdmissionFormat(conn.app, s.owner, { admissionPrefix: "KR/", admissionDigits: 9 }),
    ).rejects.toThrow();
    await saveAdmissionFormat(conn.app, s.owner, { admissionPrefix: "KR/", admissionDigits: 5 });
    expect((await s.add("Kofi", s.classA)).admissionNumber).toBe("KR/00002");
    expect((await getStudent(conn.app, s.owner, first.id))!.admissionNumber).toBe("0001");
  });
});

describe("school branding", () => {
  it("keeps a readable accent colour and a logo that is public by address and drawn on documents", async () => {
    const s = await school();
    await expect(saveBrandColor(conn.app, s.owner, { brandColor: "#ffd400" })).rejects.toMatchObject({
      code: "colour_contrast",
    });
    await expect(saveBrandColor(conn.app, s.bursar, { brandColor: "#7a1f1f" })).rejects.toThrow(
      ForbiddenError,
    );
    await saveBrandColor(conn.app, s.owner, { brandColor: "#7A1F1F" });
    expect((await getBranding(conn.app, s.owner)).brandColor).toBe("#7a1f1f");

    expect(await readSchoolLogo(conn.app, s.tenant.slug)).toBeNull();
    await expect(
      setSchoolLogo(conn.app, s.owner, { filename: "logo.pdf", bytes: PDF }),
    ).rejects.toMatchObject({
      code: "file_invalid",
    });
    await setSchoolLogo(conn.app, s.owner, { filename: "logo.png", bytes: PNG });
    const logo = await readSchoolLogo(conn.app, s.tenant.slug);
    expect(logo!.mime).toBe("image/png");
    expect((await getBranding(conn.app, s.owner)).logoFileId).toBe(logo!.id);
    expect(await getDocumentLogo(conn.app, s.tenant.id)).toMatchObject({ format: "png" });

    // WebP shows in the app but is left off PDFs (react-pdf draws PNG and JPEG).
    await setSchoolLogo(conn.app, s.owner, { filename: "logo.webp", bytes: WEBP });
    expect(await getDocumentLogo(conn.app, s.tenant.id)).toBeNull();

    await removeSchoolLogo(conn.app, s.owner);
    expect(await readSchoolLogo(conn.app, s.tenant.slug)).toBeNull();
    await saveBrandColor(conn.app, s.owner, { brandColor: "" });
    expect((await getBranding(conn.app, s.owner)).brandColor).toBeNull();
    expect((await audits(s, "school.brand_colour_changed")).length).toBe(2);
  });
});
