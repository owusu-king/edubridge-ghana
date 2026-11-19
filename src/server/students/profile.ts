import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { studentGuardians, studentMedical, students } from "../db/schema";
import { DomainError } from "../errors";
import { listFiles, markRemoved, readStoredFile, storeFile } from "../files/service";
import type { TenantContext } from "../tenancy/service";
import { getStudent } from "./service";

/**
 * Student profile extras (SIS-01, SIS-04, SIS-06, SIS-08): photograph, documents, guardian flags and medical
 * information. Every function first checks that the person can see the student (campus and class scope),
 * through the same service the student page uses.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

async function assertVisible(database: Database, ctx: TenantContext, studentId: string) {
  const student = z.string().uuid().safeParse(studentId).success
    ? await getStudent(database, ctx, studentId)
    : null;
  if (!student) throw new DomainError("student_not_found", "Student not found.");
  return student;
}

export async function setStudentPhoto(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  file: { filename: string; bytes: Buffer },
): Promise<void> {
  assertAllowed(ctx, "students.manage");
  await assertVisible(database, ctx, studentId);
  await withTenant(database, scope(ctx), async (tx) => {
    const fileId = await storeFile(tx, ctx, { purpose: "student_photo", ownerId: studentId, ...file });
    const [before] = await tx
      .select({ photo: students.photoFileId })
      .from(students)
      .where(eq(students.id, studentId));
    if (before?.photo) await markRemoved(tx, ctx, before.photo, "student_photo");
    await tx
      .update(students)
      .set({ photoFileId: fileId, updatedAt: new Date() })
      .where(eq(students.id, studentId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.photo_changed",
      entityType: "student",
      entityId: studentId,
    });
  });
}

export async function removeStudentPhoto(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<void> {
  assertAllowed(ctx, "students.manage");
  await assertVisible(database, ctx, studentId);
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({ photo: students.photoFileId })
      .from(students)
      .where(eq(students.id, studentId));
    if (!row?.photo) return;
    await markRemoved(tx, ctx, row.photo, "student_photo");
    await tx
      .update(students)
      .set({ photoFileId: null, updatedAt: new Date() })
      .where(eq(students.id, studentId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.photo_removed",
      entityType: "student",
      entityId: studentId,
    });
  });
}

/** The student's photo for someone who can see the student, or null. */
export async function getStudentPhoto(database: Database, ctx: TenantContext, studentId: string) {
  assertAllowed(ctx, "students.view");
  await assertVisible(database, ctx, studentId);
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({ photo: students.photoFileId })
      .from(students)
      .where(eq(students.id, studentId));
    return row?.photo ? readStoredFile(tx, ctx.tenant.id, row.photo, "student_photo") : null;
  });
}

export async function uploadStudentDocument(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  file: { filename: string; bytes: Buffer },
): Promise<string> {
  assertAllowed(ctx, "students.manage");
  await assertVisible(database, ctx, studentId);
  return withTenant(database, scope(ctx), async (tx) => {
    const id = await storeFile(tx, ctx, { purpose: "student_document", ownerId: studentId, ...file });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.document_added",
      entityType: "student",
      entityId: studentId,
      metadata: { fileId: id, filename: file.filename.slice(0, 120) },
    });
    return id;
  });
}

export async function listStudentDocuments(database: Database, ctx: TenantContext, studentId: string) {
  assertAllowed(ctx, "students.view_all");
  await assertVisible(database, ctx, studentId);
  return withTenant(database, scope(ctx), (tx) =>
    listFiles(tx, ctx.tenant.id, "student_document", studentId),
  );
}

/** Downloads a document; every download is recorded in the audit log. */
export async function downloadStudentDocument(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  fileId: string,
) {
  assertAllowed(ctx, "students.view_all");
  await assertVisible(database, ctx, studentId);
  if (!z.string().uuid().safeParse(fileId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const file = await readStoredFile(tx, ctx.tenant.id, fileId, "student_document");
    if (!file || file.ownerId !== studentId) return null;
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.document_downloaded",
      entityType: "student",
      entityId: studentId,
      metadata: { fileId, filename: file.filename },
    });
    return file;
  });
}

export async function removeStudentDocument(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  fileId: string,
) {
  assertAllowed(ctx, "students.manage");
  await assertVisible(database, ctx, studentId);
  await withTenant(database, scope(ctx), async (tx) => {
    const removed = await markRemoved(tx, ctx, fileId, "student_document");
    if (!removed || removed.ownerId !== studentId) throw new DomainError("not_found", "Document not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.document_removed",
      entityType: "student",
      entityId: studentId,
      metadata: { fileId, filename: removed.filename },
    });
  });
}

const flagsSchema = z.object({
  isFeePayer: z.boolean(),
  isEmergencyContact: z.boolean(),
  canPickUp: z.boolean(),
  receivesMessages: z.boolean(),
});

/** SIS-04: fee payer, emergency contact, may pick up, and whether the guardian gets announcements by SMS. */
export async function setGuardianFlags(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  guardianId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "students.manage");
  const flags = flagsSchema.parse(input);
  await assertVisible(database, ctx, studentId);
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .update(studentGuardians)
      .set(flags)
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenant.id),
          eq(studentGuardians.studentId, studentId),
          eq(studentGuardians.guardianId, guardianId),
        ),
      )
      .returning({ guardianId: studentGuardians.guardianId });
    if (!row) throw new DomainError("not_found", "Guardian not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "guardian.flags_changed",
      entityType: "student",
      entityId: studentId,
      metadata: { guardianId, ...flags },
    });
  });
}

export type MedicalInfo = Omit<
  typeof studentMedical.$inferSelect,
  "tenantId" | "studentId" | "updatedByUserId"
>;

/** Medical and emergency information for permitted roles; viewing it is recorded (SIS-06). */
export async function getStudentMedical(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<MedicalInfo | null> {
  assertAllowed(ctx, "students.medical");
  await assertVisible(database, ctx, studentId);
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select()
      .from(studentMedical)
      .where(and(eq(studentMedical.tenantId, ctx.tenant.id), eq(studentMedical.studentId, studentId)));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.medical_viewed",
      entityType: "student",
      entityId: studentId,
    });
    if (!row) return null;
    const { tenantId: _t, studentId: _s, updatedByUserId: _u, ...info } = row;
    return info;
  });
}

const text = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable(),
  );

const medicalSchema = z.object({
  bloodGroup: text(10),
  allergies: text(500),
  conditions: text(500),
  medications: text(500),
  doctorName: text(120),
  doctorPhone: text(30),
  emergencyNotes: text(500),
});

export async function saveStudentMedical(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "students.medical");
  const data = medicalSchema.parse(input);
  await assertVisible(database, ctx, studentId);
  await withTenant(database, scope(ctx), async (tx) => {
    const values = { ...data, updatedByUserId: ctx.userId, updatedAt: new Date() };
    await tx
      .insert(studentMedical)
      .values({ tenantId: ctx.tenant.id, studentId, ...values })
      .onConflictDoUpdate({ target: studentMedical.studentId, set: values });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.medical_changed",
      entityType: "student",
      entityId: studentId,
      // Which fields changed, not their contents: the audit log is wider than medical access.
      metadata: {
        fields: Object.entries(data)
          .filter(([, v]) => v !== null)
          .map(([k]) => k),
      },
    });
  });
}
