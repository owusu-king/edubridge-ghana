import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { classes, enrolments, guardians, studentGuardians, students, terms } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import { enqueue } from "../notifications/outbox";
import type { TenantContext } from "../tenancy/service";
import { localizePhoneField } from "../../lib/phone";
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
  isFeePayer: boolean;
  isEmergencyContact: boolean;
  canPickUp: boolean;
  receivesMessages: boolean;
  /** When the school stopped this guardian using the parent view; null when they may use it. */
  portalBlockedAt: Date | null;
  /** When the school last invited them to the parent view (PAR-01). */
  portalInvitedAt: Date | null;
  /** Other students (siblings) linked to the same guardian. */
  otherStudents: { id: string; name: string; className: string | null }[];
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

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
        isFeePayer: studentGuardians.isFeePayer,
        isEmergencyContact: studentGuardians.isEmergencyContact,
        canPickUp: studentGuardians.canPickUp,
        receivesMessages: studentGuardians.receivesMessages,
        portalBlockedAt: guardians.portalBlockedAt,
        portalInvitedAt: guardians.portalInvitedAt,
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
  assertAllowed(ctx, "students.manage");
  // Numbers typed in the school's national form (0712 345 678 in Kenya) are read in its country.
  const data = addGuardianSchema.parse(localizePhoneField(input, ctx.tenant.countryCode));
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
  assertAllowed(ctx, "students.manage");
  const data = contactSchema.parse(localizePhoneField(input, ctx.tenant.countryCode));
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
  assertAllowed(ctx, "students.manage");
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
  assertAllowed(ctx, "students.manage");
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

/**
 * Stops (or allows again) a guardian using the parent view, for every child they are linked to. Parent
 * access is checked on every request, so a block applies to their next page, and their balance links stop
 * working too.
 */
export async function setParentAccess(
  database: Database,
  ctx: TenantContext,
  guardianId: string,
  input: { blocked: boolean },
): Promise<void> {
  assertAllowed(ctx, "parents.access.manage");
  if (!z.string().uuid().safeParse(guardianId).success)
    throw new DomainError("guardian_not_found", "Guardian not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [guardian] = await tx
      .select({ id: guardians.id, portalBlockedAt: guardians.portalBlockedAt })
      .from(guardians)
      .where(and(eq(guardians.tenantId, ctx.tenant.id), eq(guardians.id, guardianId)))
      .for("update");
    if (!guardian) throw new DomainError("guardian_not_found", "Guardian not found.");
    if ((guardian.portalBlockedAt !== null) === input.blocked) return;
    await tx
      .update(guardians)
      .set(
        input.blocked
          ? { portalBlockedAt: new Date(), portalBlockedByUserId: ctx.userId }
          : { portalBlockedAt: null, portalBlockedByUserId: null },
      )
      .where(eq(guardians.id, guardian.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: input.blocked ? "guardian.parent_access_blocked" : "guardian.parent_access_allowed",
      entityType: "guardian",
      entityId: guardian.id,
    });
  });
}

/** At most one invitation a day per guardian, so a double tap or a forgotten repeat costs no extra SMS. */
const INVITE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Invites a guardian to the parent view by SMS (PAR-01). There is no link to accept: the parent signs in
 * with a one-time code sent to the number on file, so only that phone can use it, and a school can block
 * the guardian at any time. Not for demo schools, blocked guardians or guardians without a phone.
 */
export async function inviteGuardian(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  guardianId: string,
  now = new Date(),
): Promise<void> {
  assertAllowed(ctx, "parents.access.manage");
  if (!z.string().uuid().safeParse(guardianId).success || !z.string().uuid().safeParse(studentId).success)
    throw new DomainError("guardian_not_found", "Guardian not found.");
  if (ctx.tenant.isDemo)
    throw new DomainError("demo_school", "Demo schools do not send SMS: their numbers are made up.");
  if (ctx.billing.state === "limited")
    throw new DomainError("sms_paused", "SMS to families are paused while an EduBridge invoice is overdue.");
  const student = await getStudent(database, ctx, studentId);
  if (!student) throw new DomainError("student_not_found", "Student not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [guardian] = await tx
      .select({
        id: guardians.id,
        phone: guardians.phone,
        blocked: guardians.portalBlockedAt,
        invitedAt: guardians.portalInvitedAt,
      })
      .from(guardians)
      .innerJoin(studentGuardians, eq(studentGuardians.guardianId, guardians.id))
      .where(
        and(
          eq(guardians.tenantId, ctx.tenant.id),
          eq(guardians.id, guardianId),
          eq(studentGuardians.studentId, student.id),
        ),
      )
      .for("update", { of: guardians });
    if (!guardian) throw new DomainError("guardian_not_found", "Guardian not found.");
    if (!guardian.phone) throw new DomainError("no_phone", "Add a phone number for this guardian first.");
    if (guardian.blocked)
      throw new DomainError("parent_blocked", "This guardian is blocked from the parent view.");
    if (guardian.invitedAt && now.getTime() - guardian.invitedAt.getTime() < INVITE_INTERVAL_MS)
      throw new DomainError("invited_recently", "An invitation was sent in the last 24 hours.");
    const left = await smsAllowance(tx, ctx.tenant.id, ctx.tenant.timezone);
    if (left !== null && left <= 0)
      throw new DomainError("sms_limit", "Your plan has no SMS left this month.");
    const outboxId = await enqueue(tx, {
      channel: "sms",
      recipient: guardian.phone,
      template: "portal_invitation",
      payload: { schoolName: ctx.tenant.name, studentFirstName: student.firstName },
    });
    await recordSmsUsage(tx, ctx.tenant.id, "portal_invitation", outboxId, student.id);
    await tx.update(guardians).set({ portalInvitedAt: now }).where(eq(guardians.id, guardian.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "guardian.parent_view_invited",
      entityType: "guardian",
      entityId: guardian.id,
      metadata: { studentId: student.id },
    });
  });
}
