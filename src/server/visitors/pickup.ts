import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { normalizePhone } from "../../lib/phone";
import { collectorAllowed, latestByStudent, type PickupOutcome } from "../../lib/visitors";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  guardians,
  levels,
  memberships,
  pickupCollectors,
  pickups,
  studentGuardians,
  students,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { readStoredFile, storeFile } from "../files/service";
import { RELATIONSHIP_LABELS } from "../students/guardian-links";
import { fullName } from "../students/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Pickup (R4-4 VIS-02; module visitors_pickup). Who may collect each child: the child's guardians marked "May
 * collect the child" on the student record (read there, never copied) and named other collectors added by the
 * office. A child is released only to someone allowed at that moment; anyone else is refused and the refusal is
 * recorded. Staff on gate duty (teachers too) release children of every class at their campuses. Records are
 * cancelled once with a reason, never changed or deleted (database).
 */

const UUID = z.string().uuid();
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable().optional());

const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const notFound = () => new DomainError("not_found", "Student not found.");
const today = (ctx: TenantContext) => todayIn(ctx.tenant.timezone);

interface PickupStudent {
  id: string;
  name: string;
  admissionNumber: string;
  status: string;
  hasPhoto: boolean;
  classId: string | null;
  className: string | null;
}

/**
 * The student, with this term's class, if this member may handle their pickup: every class for staff with
 * every campus; for staff limited to some campuses, children in classes there.
 */
async function readStudent(tx: Transaction, ctx: TenantContext, studentId: string): Promise<PickupStudent> {
  if (!UUID.safeParse(studentId).success) throw notFound();
  const [row] = await tx
    .select({
      s: students,
      classId: classes.id,
      className: classes.name,
      campusId: classes.campusId,
    })
    .from(students)
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, students.id),
        sql`${enrolments.termId} = (select id from terms where tenant_id = ${ctx.tenant.id} and is_current)`,
      ),
    )
    .leftJoin(classes, eq(classes.id, enrolments.classId))
    .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, studentId)));
  if (!row) throw notFound();
  if (ctx.campusIds !== null && !(row.campusId && ctx.campusIds.includes(row.campusId))) throw notFound();
  return {
    id: row.s.id,
    name: fullName(row.s),
    admissionNumber: row.s.admissionNumber,
    status: row.s.status,
    hasPhoto: row.s.photoFileId !== null,
    classId: row.classId,
    className: row.className,
  };
}

export interface Collector {
  /** "guardian:<id>" or "collector:<id>", as the release form sends it. */
  key: string;
  kind: "guardian" | "collector";
  id: string;
  name: string;
  relationship: string;
  hasPhoto: boolean;
}

/** Everyone allowed to collect these students today (VIS-02a), per student. */
async function allowedCollectors(
  tx: Transaction,
  ctx: TenantContext,
  studentIds: string[],
): Promise<Map<string, Collector[]>> {
  const result = new Map<string, Collector[]>(studentIds.map((id) => [id, []]));
  if (!studentIds.length) return result;
  const [links, named] = await Promise.all([
    tx
      .select({
        studentId: studentGuardians.studentId,
        id: guardians.id,
        name: guardians.fullName,
        relationship: studentGuardians.relationship,
      })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenant.id),
          inArray(studentGuardians.studentId, studentIds),
          eq(studentGuardians.canPickUp, true),
        ),
      )
      .orderBy(asc(guardians.fullName)),
    tx
      .select()
      .from(pickupCollectors)
      .where(
        and(
          eq(pickupCollectors.tenantId, ctx.tenant.id),
          inArray(pickupCollectors.studentId, studentIds),
          isNull(pickupCollectors.endedAt),
        ),
      )
      .orderBy(asc(pickupCollectors.fullName)),
  ]);
  for (const g of links)
    result.get(g.studentId)!.push({
      key: `guardian:${g.id}`,
      kind: "guardian",
      id: g.id,
      name: g.name,
      relationship: RELATIONSHIP_LABELS[g.relationship],
      hasPhoto: false,
    });
  const day = today(ctx);
  for (const c of named.filter((c) => collectorAllowed(c, day)))
    result.get(c.studentId)!.push({
      key: `collector:${c.id}`,
      kind: "collector",
      id: c.id,
      name: c.fullName,
      relationship: c.relationship,
      hasPhoto: c.photoFileId !== null,
    });
  return result;
}

// ——— The day's list (VIS-02d) ———

export interface PickupClass {
  id: string;
  name: string;
  levelName: string;
}

/** This term's classes at the member's campuses, and the class to open first (their own, for a class teacher). */
export async function listPickupClasses(
  database: Database,
  ctx: TenantContext,
): Promise<{ classes: PickupClass[]; ownClassId: string | null }> {
  assertAllowed(ctx, "pickup.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: classes.id,
        name: classes.name,
        levelName: levels.name,
        campusId: classes.campusId,
        teacher: classes.classTeacherMembershipId,
      })
      .from(classes)
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")))
      .orderBy(asc(levels.sequence), asc(classes.name));
    const visible = rows.filter((r) => ctx.campusIds === null || ctx.campusIds.includes(r.campusId));
    const [me] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
    return {
      classes: visible.map(({ id, name, levelName }) => ({ id, name, levelName })),
      ownClassId: visible.find((r) => me && r.teacher === me.id)?.id ?? null,
    };
  });
}

export interface PickupRecord {
  id: string;
  studentId: string;
  outcome: PickupOutcome;
  personName: string;
  relationship: string | null;
  reason: string | null;
  note: string | null;
  recordedAt: Date;
  recordedBy: string;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

async function readRecords(
  tx: Transaction,
  ctx: TenantContext,
  where: ReturnType<typeof and>,
  limit?: number,
) {
  const q = tx
    .select({ p: pickups, by: users.name })
    .from(pickups)
    .innerJoin(users, eq(users.id, pickups.recordedByUserId))
    .where(and(eq(pickups.tenantId, ctx.tenant.id), where))
    .orderBy(desc(pickups.recordedAt));
  const rows = limit ? await q.limit(limit) : await q;
  return rows.map(({ p, by }): PickupRecord => ({
    id: p.id,
    studentId: p.studentId,
    outcome: p.outcome,
    personName: p.personName,
    relationship: p.relationship,
    reason: p.reason,
    note: p.note,
    recordedAt: p.recordedAt,
    recordedBy: by,
    cancelledAt: p.cancelledAt,
    cancelReason: p.cancelReason,
  }));
}

export interface PickupDayStudent {
  id: string;
  name: string;
  admissionNumber: string;
  hasPhoto: boolean;
  latest: PickupRecord | null;
  collectors: Collector[];
}

export interface PickupDay {
  date: string;
  className: string;
  students: PickupDayStudent[];
  refusals: PickupRecord[];
}

/** One class's pickup list for today: each active child's latest record and who may collect them. */
export async function getPickupDay(
  database: Database,
  ctx: TenantContext,
  classId: string,
): Promise<PickupDay> {
  assertAllowed(ctx, "pickup.view");
  if (!UUID.safeParse(classId).success) throw new DomainError("not_found", "Class not found.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [cls] = await tx
      .select({ name: classes.name, campusId: classes.campusId })
      .from(classes)
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.id, classId)));
    if (!cls || (ctx.campusIds !== null && !ctx.campusIds.includes(cls.campusId)))
      throw new DomainError("not_found", "Class not found.");
    const rows = await tx
      .select({ s: students })
      .from(enrolments)
      .innerJoin(terms, eq(terms.id, enrolments.termId))
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.classId, classId),
          eq(terms.isCurrent, true),
          eq(students.status, "active"),
        ),
      )
      .orderBy(asc(students.firstName), asc(students.lastName));
    const ids = rows.map((r) => r.s.id);
    const date = today(ctx);
    const [records, collectors] = await Promise.all([
      ids.length
        ? readRecords(tx, ctx, and(eq(pickups.onDate, date), inArray(pickups.studentId, ids)))
        : Promise.resolve([]),
      allowedCollectors(tx, ctx, ids),
    ]);
    const latest = latestByStudent(records);
    return {
      date,
      className: cls.name,
      students: rows.map(({ s }) => ({
        id: s.id,
        name: fullName(s),
        admissionNumber: s.admissionNumber,
        hasPhoto: s.photoFileId !== null,
        latest: latest.get(s.id) ?? null,
        collectors: collectors.get(s.id) ?? [],
      })),
      refusals: records.filter((r) => r.outcome === "refused" && !r.cancelledAt),
    };
  });
}

/** Today's refusals at the member's campuses, with the child and class (VIS-02c). */
export async function listRefusalsToday(
  database: Database,
  ctx: TenantContext,
): Promise<(PickupRecord & { student: string; className: string | null })[]> {
  assertAllowed(ctx, "pickup.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const rows = await tx
      .select({
        p: pickups,
        by: users.name,
        s: students,
        className: classes.name,
        campusId: classes.campusId,
      })
      .from(pickups)
      .innerJoin(users, eq(users.id, pickups.recordedByUserId))
      .innerJoin(students, eq(students.id, pickups.studentId))
      .leftJoin(
        enrolments,
        and(
          eq(enrolments.studentId, pickups.studentId),
          sql`${enrolments.termId} = (select id from terms where tenant_id = ${ctx.tenant.id} and is_current)`,
        ),
      )
      .leftJoin(classes, eq(classes.id, enrolments.classId))
      .where(
        and(
          eq(pickups.tenantId, ctx.tenant.id),
          eq(pickups.onDate, today(ctx)),
          eq(pickups.outcome, "refused"),
          isNull(pickups.cancelledAt),
        ),
      )
      .orderBy(desc(pickups.recordedAt));
    return rows
      .filter((r) => ctx.campusIds === null || (r.campusId !== null && ctx.campusIds.includes(r.campusId)))
      .map(({ p, by, s, className }) => ({
        id: p.id,
        studentId: p.studentId,
        outcome: p.outcome,
        personName: p.personName,
        relationship: p.relationship,
        reason: p.reason,
        note: p.note,
        recordedAt: p.recordedAt,
        recordedBy: by,
        cancelledAt: p.cancelledAt,
        cancelReason: p.cancelReason,
        student: fullName(s),
        className,
      }));
  });
}

// ——— Releasing and refusing (VIS-02b, VIS-02c) ———

const releaseSchema = z.object({
  collector: z
    .string({ message: "Choose who is collecting the child." })
    .regex(/^(guardian|collector):[0-9a-f-]{36}$/i, "Choose who is collecting the child."),
  note: optionalText(300),
});

/** Releases a child to someone allowed to collect them now; anyone else is refused by the server. */
export async function releaseStudent(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: Record<string, unknown>,
): Promise<{ personName: string }> {
  assertAllowed(ctx, "pickup.record");
  const data = releaseSchema.parse(input);
  const [kind, id] = data.collector.split(":") as ["guardian" | "collector", string];
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const student = await readStudent(tx, ctx, studentId);
    if (student.status !== "active")
      throw new DomainError("student_inactive", "Only a child at the school can be released.");
    const refuse = () =>
      new DomainError(
        "not_allowed",
        "This person may not collect the child. Do not release the child; record a refusal instead.",
        "collector",
      );
    let person: { name: string; relationship: string };
    if (kind === "guardian") {
      // Locks the link, so the flag cannot be turned off between this check and the record.
      const [link] = await tx
        .select({ name: guardians.fullName, relationship: studentGuardians.relationship })
        .from(studentGuardians)
        .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
        .where(
          and(
            eq(studentGuardians.tenantId, ctx.tenant.id),
            eq(studentGuardians.studentId, student.id),
            eq(studentGuardians.guardianId, id),
            eq(studentGuardians.canPickUp, true),
          ),
        )
        .for("update", { of: studentGuardians });
      if (!link) throw refuse();
      person = { name: link.name, relationship: RELATIONSHIP_LABELS[link.relationship] };
    } else {
      const [c] = await tx
        .select()
        .from(pickupCollectors)
        .where(
          and(
            eq(pickupCollectors.tenantId, ctx.tenant.id),
            eq(pickupCollectors.id, id),
            eq(pickupCollectors.studentId, student.id),
          ),
        )
        .for("update");
      if (!c || !collectorAllowed(c, today(ctx))) throw refuse();
      person = { name: c.fullName, relationship: c.relationship };
    }
    await tx.insert(pickups).values({
      tenantId: ctx.tenant.id,
      studentId: student.id,
      onDate: today(ctx),
      outcome: "released",
      guardianId: kind === "guardian" ? id : null,
      collectorId: kind === "collector" ? id : null,
      personName: person.name,
      relationship: person.relationship,
      note: data.note ?? null,
      recordedByUserId: ctx.userId,
    });
    return { personName: person.name };
  });
}

const refuseSchema = z.object({
  personName: z
    .string({ message: "Enter the person's name." })
    .trim()
    .min(2, "Enter the person's name.")
    .max(120, "Use 120 characters or fewer."),
  relationship: optionalText(60),
  reason: z
    .string({ message: "Say why the child was not released." })
    .trim()
    .min(3, "Say why the child was not released.")
    .max(500, "Use 500 characters or fewer."),
  note: optionalText(300),
});

/** Records that someone came for a child and was refused (VIS-02c). */
export async function refusePickup(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "pickup.record");
  const data = refuseSchema.parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const student = await readStudent(tx, ctx, studentId);
    await tx.insert(pickups).values({
      tenantId: ctx.tenant.id,
      studentId: student.id,
      onDate: today(ctx),
      outcome: "refused",
      personName: data.personName,
      relationship: data.relationship ?? null,
      reason: data.reason,
      note: data.note ?? null,
      recordedByUserId: ctx.userId,
    });
  });
}

/** Cancels a release or refusal recorded by mistake, once, with a reason; it stays on record (VIS-02d). */
export async function cancelPickup(
  database: Database,
  ctx: TenantContext,
  pickupId: string,
  reasonInput: unknown,
): Promise<void> {
  assertAllowed(ctx, "pickup.record");
  const reason = z
    .string({ message: "Say why it is cancelled." })
    .trim()
    .min(3, "Say why it is cancelled.")
    .max(300, "Use 300 characters or fewer.")
    .safeParse(reasonInput);
  if (!reason.success) throw new DomainError("reason_required", "Say why it is cancelled.", "reason");
  if (!UUID.safeParse(pickupId).success) throw new DomainError("not_found", "Record not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({ studentId: pickups.studentId, cancelledAt: pickups.cancelledAt })
      .from(pickups)
      .where(and(eq(pickups.tenantId, ctx.tenant.id), eq(pickups.id, pickupId)))
      .for("update");
    if (!row) throw new DomainError("not_found", "Record not found.");
    await readStudent(tx, ctx, row.studentId);
    if (row.cancelledAt) throw new DomainError("cancelled", "This record has already been cancelled.");
    await tx
      .update(pickups)
      .set({ cancelledAt: new Date(), cancelledByUserId: ctx.userId, cancelReason: reason.data })
      .where(eq(pickups.id, pickupId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "pickup.cancelled",
      entityType: "student",
      entityId: row.studentId,
      metadata: { pickupId },
    });
  });
}

// ——— A child's collectors and history (VIS-02a) ———

export interface NamedCollector {
  id: string;
  fullName: string;
  relationship: string;
  /** Shown to the office (`pickup.manage`) only. */
  phone: string | null;
  hasPhoto: boolean;
  validUntil: string | null;
  note: string | null;
  addedAt: Date;
  addedBy: string;
  endedAt: Date | null;
  endReason: string | null;
  /** May collect the child today. */
  allowed: boolean;
}

export interface StudentPickup {
  student: PickupStudent;
  guardians: { id: string; name: string; relationship: string; phone: string | null; allowed: boolean }[];
  collectors: NamedCollector[];
  history: PickupRecord[];
}

export async function getStudentPickup(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<StudentPickup> {
  assertAllowed(ctx, "pickup.view");
  const office = allowed(ctx, "pickup.manage");
  const addedBy = alias(users, "added_by");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const student = await readStudent(tx, ctx, studentId);
    const [links, named, history] = await Promise.all([
      tx
        .select({
          id: guardians.id,
          name: guardians.fullName,
          phone: guardians.phone,
          relationship: studentGuardians.relationship,
          allowed: studentGuardians.canPickUp,
        })
        .from(studentGuardians)
        .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
        .where(and(eq(studentGuardians.tenantId, ctx.tenant.id), eq(studentGuardians.studentId, student.id)))
        .orderBy(desc(studentGuardians.canPickUp), asc(guardians.fullName)),
      tx
        .select({ c: pickupCollectors, by: addedBy.name })
        .from(pickupCollectors)
        .innerJoin(addedBy, eq(addedBy.id, pickupCollectors.addedByUserId))
        .where(and(eq(pickupCollectors.tenantId, ctx.tenant.id), eq(pickupCollectors.studentId, student.id)))
        .orderBy(sql`${pickupCollectors.endedAt} is not null`, asc(pickupCollectors.fullName)),
      readRecords(tx, ctx, eq(pickups.studentId, student.id), 60),
    ]);
    const day = today(ctx);
    return {
      student,
      guardians: links.map((g) => ({
        id: g.id,
        name: g.name,
        relationship: RELATIONSHIP_LABELS[g.relationship],
        phone: office ? g.phone : null,
        allowed: g.allowed,
      })),
      collectors: named.map(({ c, by }) => ({
        id: c.id,
        fullName: c.fullName,
        relationship: c.relationship,
        phone: office ? c.phone : null,
        hasPhoto: c.photoFileId !== null,
        validUntil: c.validUntil,
        note: c.note,
        addedAt: c.addedAt,
        addedBy: by,
        endedAt: c.endedAt,
        endReason: c.endReason,
        allowed: collectorAllowed(c, day),
      })),
      history,
    };
  });
}

const collectorSchema = (country: string, day: string) =>
  z.object({
    fullName: z
      .string({ message: "Enter their full name." })
      .trim()
      .min(2, "Enter their full name.")
      .max(120, "Use 120 characters or fewer."),
    relationship: z
      .string({ message: "Say who they are to the child, e.g. aunt or driver." })
      .trim()
      .min(2, "Say who they are to the child, e.g. aunt or driver.")
      .max(60, "Use 60 characters or fewer."),
    phone: z.preprocess(
      blank,
      z
        .string()
        .transform((v, c) => {
          const phone = normalizePhone(v, country);
          if (!phone) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
          return phone ?? "";
        })
        .nullable()
        .optional(),
    ),
    validUntil: z.preprocess(
      blank,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
        .refine((v) => v >= day, "Choose today or a later day.")
        .nullable()
        .optional(),
    ),
    note: optionalText(300),
  });

/** Adds a named collector for a child, with an optional photo (VIS-02a). */
export async function addCollector(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: Record<string, unknown>,
  photo?: { filename: string; bytes: Buffer } | null,
): Promise<string> {
  assertAllowed(ctx, "pickup.manage");
  const data = collectorSchema(ctx.tenant.countryCode, today(ctx)).parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const student = await readStudent(tx, ctx, studentId);
    const id = randomUUID();
    // The photo is stored first, so the collector is written once, with it.
    const photoFileId =
      photo && photo.bytes.length
        ? await storeFile(tx, ctx, { purpose: "collector_photo", ownerId: id, ...photo })
        : null;
    await tx.insert(pickupCollectors).values({
      id,
      tenantId: ctx.tenant.id,
      studentId: student.id,
      fullName: data.fullName,
      relationship: data.relationship,
      phone: data.phone || null,
      photoFileId,
      validUntil: data.validUntil ?? null,
      note: data.note ?? null,
      addedByUserId: ctx.userId,
    });
    // Names and numbers stay in the collector record; the audit log says what changed and on whose record.
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "pickup.collector_added",
      entityType: "student",
      entityId: student.id,
      metadata: { collectorId: id },
    });
    return id;
  });
}

/** Ends a collector's permission, once, with a reason; they stay on record (VIS-02a). */
export async function endCollector(
  database: Database,
  ctx: TenantContext,
  collectorId: string,
  reasonInput: unknown,
): Promise<void> {
  assertAllowed(ctx, "pickup.manage");
  const reason = z.string().trim().min(3).max(300).safeParse(reasonInput);
  if (!reason.success)
    throw new DomainError("reason_required", "Say why they may no longer collect the child.", "reason");
  if (!UUID.safeParse(collectorId).success) throw new DomainError("not_found", "Collector not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [c] = await tx
      .select({ studentId: pickupCollectors.studentId, endedAt: pickupCollectors.endedAt })
      .from(pickupCollectors)
      .where(and(eq(pickupCollectors.tenantId, ctx.tenant.id), eq(pickupCollectors.id, collectorId)))
      .for("update");
    if (!c) throw new DomainError("not_found", "Collector not found.");
    await readStudent(tx, ctx, c.studentId);
    if (c.endedAt) throw new DomainError("ended", "This collector has already been ended.");
    await tx
      .update(pickupCollectors)
      .set({ endedAt: new Date(), endedByUserId: ctx.userId, endReason: reason.data })
      .where(eq(pickupCollectors.id, collectorId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "pickup.collector_ended",
      entityType: "student",
      entityId: c.studentId,
      metadata: { collectorId },
    });
  });
}

/** A collector's photo, for staff who handle the child's pickup. */
export async function getCollectorPhoto(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  collectorId: string,
) {
  assertAllowed(ctx, "pickup.view");
  if (!UUID.safeParse(collectorId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const student = await readStudent(tx, ctx, studentId);
    const [c] = await tx
      .select({ photo: pickupCollectors.photoFileId })
      .from(pickupCollectors)
      .where(
        and(
          eq(pickupCollectors.tenantId, ctx.tenant.id),
          eq(pickupCollectors.id, collectorId),
          eq(pickupCollectors.studentId, student.id),
        ),
      );
    return c?.photo ? readStoredFile(tx, ctx.tenant.id, c.photo, "collector_photo") : null;
  });
}
