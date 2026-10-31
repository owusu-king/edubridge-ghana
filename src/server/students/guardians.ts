import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { classes, enrolments, guardians, studentGuardians, students, terms } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { fullName, getStudent } from "./service";
import {
  addGuardianSchema,
  contactSchema,
  linkGuardianInTx,
  mapRace,
  setPrimaryInTx,
  type Relationship,
} from "./guardian-links";

export { addGuardianSchema, RELATIONSHIP_LABELS, RELATIONSHIPS, type Relationship } from "./guardian-links";

export interface GuardianLink {
  guardianId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  relationship: Relationship;
  isPrimary: boolean;
  /** Other students (siblings) linked to the same guardian. */
  otherStudents: { id: string; name: string; className: string | null }[];
}

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

/** Guardians of a student, visible to anyone who can see the student. */
export async function listGuardians(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<GuardianLink[] | null> {
  const student = await getStudent(database, ctx, studentId);
  if (!student) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const links = await tx
      .select({
        guardianId: guardians.id,
        fullName: guardians.fullName,
        phone: guardians.phone,
        email: guardians.email,
        relationship: studentGuardians.relationship,
        isPrimary: studentGuardians.isPrimary,
      })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(and(eq(studentGuardians.tenantId, ctx.tenant.id), eq(studentGuardians.studentId, student.id)))
      .orderBy(sql`${studentGuardians.isPrimary} desc`, asc(guardians.fullName));
    const guardianIds = links.map((l) => l.guardianId);
    const siblings = guardianIds.length
      ? await tx
          .select({
            guardianId: studentGuardians.guardianId,
            id: students.id,
            firstName: students.firstName,
            otherNames: students.otherNames,
            lastName: students.lastName,
            className: classes.name,
          })
          .from(studentGuardians)
          .innerJoin(students, eq(students.id, studentGuardians.studentId))
          .leftJoin(terms, and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)))
          .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.termId, terms.id)))
          .leftJoin(classes, eq(classes.id, enrolments.classId))
          .where(
            and(
              eq(studentGuardians.tenantId, ctx.tenant.id),
              inArray(studentGuardians.guardianId, guardianIds),
              ne(studentGuardians.studentId, student.id),
              eq(students.status, "active"),
            ),
          )
      : [];
    return links.map((l) => ({
      ...l,
      otherStudents: siblings
        .filter((s) => s.guardianId === l.guardianId)
        .map((s) => ({ id: s.id, name: fullName(s), className: s.className })),
    }));
  });
}

async function loadStudentForUpdate(tx: Transaction, ctx: TenantContext, studentId: string) {
  if (!z.string().uuid().safeParse(studentId).success)
    throw new DomainError("student_not_found", "Student not found.");
  const [student] = await tx
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, studentId)))
    .for("update");
  if (!student) throw new DomainError("student_not_found", "Student not found.");
  return student;
}

/**
 * Adds a guardian to a student. If the school already has a guardian with this phone number, that record
 * is linked instead (siblings share guardians) and its details are left unchanged.
 */
export async function addGuardian(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<{ guardianId: string; linkedExisting: boolean }> {
  assertCan(ctx.roles, "students.manage");
  const data = addGuardianSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const student = await loadStudentForUpdate(tx, ctx, studentId);
    return linkGuardianInTx(tx, ctx, student.id, data);
  }).catch(mapRace);
}

/** Updates a guardian's name and contact details, for every student they are linked to. */
export async function updateGuardian(
  database: Database,
  ctx: TenantContext,
  guardianId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "students.manage");
  const data = contactSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    if (!z.string().uuid().safeParse(guardianId).success)
      throw new DomainError("guardian_not_found", "Guardian not found.");
    const [before] = await tx
      .select()
      .from(guardians)
      .where(and(eq(guardians.tenantId, ctx.tenant.id), eq(guardians.id, guardianId)))
      .for("update");
    if (!before) throw new DomainError("guardian_not_found", "Guardian not found.");
    await tx
      .update(guardians)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(guardians.id, before.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "guardian.updated",
      entityType: "guardian",
      entityId: before.id,
      metadata: {
        changes: {
          name: { from: before.fullName, to: data.fullName },
          phone: { from: before.phone, to: data.phone },
          email: { from: before.email, to: data.email },
        },
      },
    });
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DomainError(
        "phone_taken",
        "Another guardian at this school already has this phone number.",
        "phone",
      );
    }
    throw error;
  });
}

export async function setPrimaryGuardian(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  guardianId: string,
): Promise<void> {
  assertCan(ctx.roles, "students.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const student = await loadStudentForUpdate(tx, ctx, studentId);
    const [link] = await tx
      .select()
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenant.id),
          eq(studentGuardians.studentId, student.id),
          eq(studentGuardians.guardianId, guardianId),
        ),
      );
    if (!link) throw new DomainError("guardian_not_found", "Guardian not found.");
    if (link.isPrimary) return;
    await setPrimaryInTx(tx, ctx, student.id, guardianId);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "guardian.made_primary",
      entityType: "student",
      entityId: student.id,
      metadata: { guardianId },
    });
  });
}

/** Removes the link (the guardian record stays for siblings). The next guardian becomes primary if needed. */
export async function unlinkGuardian(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  guardianId: string,
): Promise<void> {
  assertCan(ctx.roles, "students.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const student = await loadStudentForUpdate(tx, ctx, studentId);
    if (!z.string().uuid().safeParse(guardianId).success)
      throw new DomainError("guardian_not_found", "Guardian not found.");
    const [removed] = await tx
      .delete(studentGuardians)
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenant.id),
          eq(studentGuardians.studentId, student.id),
          eq(studentGuardians.guardianId, guardianId),
        ),
      )
      .returning();
    if (!removed) throw new DomainError("guardian_not_found", "Guardian not found.");
    if (removed.isPrimary) {
      const [next] = await tx
        .select({ guardianId: studentGuardians.guardianId })
        .from(studentGuardians)
        .where(and(eq(studentGuardians.tenantId, ctx.tenant.id), eq(studentGuardians.studentId, student.id)))
        .orderBy(asc(studentGuardians.createdAt))
        .limit(1);
      if (next) await setPrimaryInTx(tx, ctx, student.id, next.guardianId);
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "guardian.unlinked",
      entityType: "student",
      entityId: student.id,
      metadata: { guardianId },
    });
  });
}
