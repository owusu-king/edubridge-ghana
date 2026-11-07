import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  attendanceMarks,
  attendanceRegisters,
  classes,
  enrolments,
  guardians,
  learnerRecords,
  levels,
  priorRecords,
  reportCards,
  studentGuardians,
  students,
  tenants,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { addGuardian } from "../students/guardians";
import { createStudent } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { checkSignature, signRecord, type SignedPackage } from "./signing";

/**
 * Learner records (Transfer Passport): a child's history at one school, signed so that another school, on
 * EduBridge or not, can trust it. The record carries the learner id (portable identity), the school, the
 * child, guardians, classes by term, published report cards exactly as published (frozen snapshots) and
 * attendance by term. It is built from the school's own records at the moment of issue and never edited.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface LearnerRecord extends Record<string, unknown> {
  id: string;
  learnerId: string;
  purpose: "transfer" | "export";
  issuedAt: string;
  issuer: { schoolId: string; name: string; slug: string; country: string };
  student: {
    firstName: string;
    otherNames: string | null;
    lastName: string;
    sex: "female" | "male";
    dateOfBirth: string | null;
    admissionNumber: string;
    admittedOn: string | null;
    status: string;
  };
  guardians: { fullName: string; relationship: string; phone: string | null; primary: boolean }[];
  enrolments: {
    year: string;
    term: string;
    startsOn: string;
    endsOn: string;
    className: string;
    level: string;
    stage: string;
  }[];
  reportCards: Record<string, unknown>[];
  attendance: { year: string; term: string; present: number; marked: number }[];
  transfer: { toSchool: string } | null;
}

/** Reads everything a record holds, inside a transaction of the issuing school. */
async function buildRecord(
  tx: Transaction,
  tenantId: string,
  studentId: string,
  purpose: "transfer" | "export",
  transfer: { toSchool: string } | null,
): Promise<{ record: LearnerRecord; learnerId: string }> {
  const [school] = await tx
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, country: tenants.countryCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const [student] = await tx
    .select()
    .from(students)
    .where(and(eq(students.tenantId, tenantId), eq(students.id, studentId)));
  if (!school || !student) throw new DomainError("student_not_found", "Student not found.");
  if (!student.learnerId) throw new DomainError("learner_missing", "This student has no learner identity.");
  const guardianRows = await tx
    .select({
      fullName: guardians.fullName,
      phone: guardians.phone,
      relationship: studentGuardians.relationship,
      primary: studentGuardians.isPrimary,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(and(eq(studentGuardians.tenantId, tenantId), eq(studentGuardians.studentId, studentId)))
    .orderBy(desc(studentGuardians.isPrimary), asc(guardians.fullName));
  const enrolmentRows = await tx
    .select({
      year: academicYears.name,
      term: terms.name,
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
      className: classes.name,
      level: levels.name,
      stage: levels.stage,
    })
    .from(enrolments)
    .innerJoin(terms, eq(terms.id, enrolments.termId))
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .where(and(eq(enrolments.tenantId, tenantId), eq(enrolments.studentId, studentId)))
    .orderBy(asc(terms.startsOn));
  const cards = await tx
    .select({ snapshot: reportCards.snapshot, publishedAt: reportCards.publishedAt })
    .from(reportCards)
    .innerJoin(terms, eq(terms.id, reportCards.termId))
    .where(
      and(
        eq(reportCards.tenantId, tenantId),
        eq(reportCards.studentId, studentId),
        eq(reportCards.status, "published"),
      ),
    )
    .orderBy(asc(terms.startsOn));
  const attendance = await tx
    .select({
      year: academicYears.name,
      term: terms.name,
      present: sql<number>`count(*) filter (where ${attendanceMarks.status} in ('present', 'late'))::int`,
      marked: sql<number>`count(*)::int`,
    })
    .from(attendanceMarks)
    .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
    .innerJoin(terms, eq(terms.id, attendanceRegisters.termId))
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(and(eq(attendanceMarks.tenantId, tenantId), eq(attendanceMarks.studentId, studentId)))
    .groupBy(terms.id, terms.startsOn, terms.name, academicYears.name)
    .orderBy(asc(terms.startsOn));
  return {
    learnerId: student.learnerId,
    record: {
      id: crypto.randomUUID(),
      learnerId: student.learnerId,
      purpose,
      issuedAt: new Date().toISOString(),
      issuer: { schoolId: school.id, name: school.name, slug: school.slug, country: school.country },
      student: {
        firstName: student.firstName,
        otherNames: student.otherNames,
        lastName: student.lastName,
        sex: student.sex,
        dateOfBirth: student.dateOfBirth,
        admissionNumber: student.admissionNumber,
        admittedOn: student.admittedOn,
        status: student.status,
      },
      guardians: guardianRows,
      enrolments: enrolmentRows,
      reportCards: cards.map((c) => ({
        ...(c.snapshot ?? {}),
        publishedAt: c.publishedAt?.toISOString() ?? null,
      })),
      attendance,
      transfer,
    },
  };
}

/** Signs and stores a record inside the issuing school's transaction. */
export async function issueRecordInTx(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
  purpose: "transfer" | "export",
  transfer: { toSchool: string } | null = null,
): Promise<{ recordId: string; pkg: SignedPackage }> {
  const { record, learnerId } = await buildRecord(tx, ctx.tenant.id, studentId, purpose, transfer);
  const { pkg, sha256 } = signRecord(record);
  await tx.insert(learnerRecords).values({
    id: record.id,
    tenantId: ctx.tenant.id,
    learnerId,
    studentId,
    purpose,
    record,
    sha256,
    keyId: pkg.signature.keyId,
    signature: pkg.signature.value,
    issuedByUserId: ctx.userId,
  });
  await recordAudit(tx, {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "learner_record.issued",
    entityType: "student",
    entityId: studentId,
    metadata: { recordId: record.id, purpose, sha256, ...(transfer ? { toSchool: transfer.toSchool } : {}) },
  });
  return { recordId: record.id, pkg };
}

/** A signed record of a student to download (for a family, or a school not on EduBridge). */
export async function exportLearnerRecord(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<SignedPackage> {
  assertAllowed(ctx, "transfers.manage");
  if (!z.string().uuid().safeParse(studentId).success)
    throw new DomainError("student_not_found", "Student not found.");
  return withTenant(
    database,
    scope(ctx),
    async (tx) => (await issueRecordInTx(tx, ctx, studentId, "export")).pkg,
  );
}

export interface IssuedRecordRow {
  id: string;
  purpose: "transfer" | "export";
  issuedAt: Date;
  issuedBy: string;
  sha256: string;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export async function listIssuedRecords(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<IssuedRecordRow[]> {
  assertAllowed(ctx, "transfers.manage");
  return withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: learnerRecords.id,
        purpose: learnerRecords.purpose,
        issuedAt: learnerRecords.issuedAt,
        issuedBy: users.name,
        sha256: learnerRecords.sha256,
        revokedAt: learnerRecords.revokedAt,
        revokedReason: learnerRecords.revokedReason,
      })
      .from(learnerRecords)
      .innerJoin(users, eq(users.id, learnerRecords.issuedByUserId))
      .where(and(eq(learnerRecords.tenantId, ctx.tenant.id), eq(learnerRecords.studentId, studentId)))
      .orderBy(desc(learnerRecords.issuedAt)),
  );
}

/** Withdraws trust in a record issued in error; verification then reports it as revoked. */
export async function revokeLearnerRecord(
  database: Database,
  ctx: TenantContext,
  recordId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "transfers.manage");
  const { reason } = z
    .object({
      reason: z.string().trim().min(3, "Say why it is revoked.").max(300, "Use 300 characters or fewer."),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .update(learnerRecords)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(learnerRecords.tenantId, ctx.tenant.id),
          eq(learnerRecords.id, recordId),
          sql`${learnerRecords.revokedAt} is null`,
        ),
      )
      .returning({ studentId: learnerRecords.studentId });
    if (!row) throw new DomainError("record_not_found", "Record not found, or already revoked.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "learner_record.revoked",
      entityType: "student",
      entityId: row.studentId,
      metadata: { recordId, reason },
    });
  });
}

export type Verification =
  | {
      status: "valid" | "revoked";
      issuer: string;
      issuedAt: string;
      student: string;
      recordId: string;
      revokedReason?: string | null;
      development: boolean;
      record: LearnerRecord;
    }
  | { status: "unsigned"; issuer: string; student: string; record: Record<string, unknown> }
  | { status: "invalid"; reason: string };

const recordShape = z.object({
  id: z.string().uuid(),
  learnerId: z.string().uuid(),
  issuedAt: z.string(),
  issuer: z.object({ schoolId: z.string().uuid(), name: z.string() }).passthrough(),
  student: z
    .object({
      firstName: z.string().min(1).max(60),
      otherNames: z.string().max(60).nullable().optional(),
      lastName: z.string().min(1).max(60),
      sex: z.enum(["female", "male"]),
      dateOfBirth: z.string().nullable().optional(),
    })
    .passthrough(),
});

/**
 * Checks a package: the signature, that EduBridge holds the record it names (same fingerprint), and
 * whether the issuing school has revoked it. Unsigned packages in the documented format are reported as
 * such (a school not on EduBridge can produce them; nobody vouches for them).
 */
export async function verifyLearnerPackage(database: Database, input: unknown): Promise<Verification> {
  const check = checkSignature(input);
  if (check.status === "invalid") return check;
  const shaped = recordShape.safeParse(check.record);
  const name = (r: Record<string, unknown>) => {
    const st = (r.student ?? {}) as { firstName?: string; lastName?: string };
    return [st.firstName, st.lastName].filter(Boolean).join(" ");
  };
  if (check.status === "unsigned") {
    const issuer = ((check.record.issuer as { name?: string } | undefined)?.name ?? "Unknown school").slice(
      0,
      120,
    );
    return { status: "unsigned", issuer, student: name(check.record), record: check.record };
  }
  if (!shaped.success) return { status: "invalid", reason: "The record is incomplete." };
  const r = shaped.data;
  const stored = await withTenant(database, { tenantId: r.issuer.schoolId, userId: "" }, async (tx) => {
    const [row] = await tx
      .select({
        sha256: learnerRecords.sha256,
        revokedAt: learnerRecords.revokedAt,
        revokedReason: learnerRecords.revokedReason,
      })
      .from(learnerRecords)
      .where(and(eq(learnerRecords.tenantId, r.issuer.schoolId), eq(learnerRecords.id, r.id)));
    return row;
  });
  if (!stored || stored.sha256 !== check.sha256)
    return { status: "invalid", reason: "EduBridge has no record of issuing this." };
  return {
    status: stored.revokedAt ? "revoked" : "valid",
    issuer: r.issuer.name,
    issuedAt: r.issuedAt,
    student: name(check.record),
    recordId: r.id,
    revokedReason: stored.revokedReason,
    development: check.development,
    record: check.record as LearnerRecord,
  };
}

/** Stores a received record against the receiving school's student, inside its transaction. */
export async function storePriorRecordInTx(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
  source: "transfer" | "import",
  input: { pkg: Record<string, unknown>; verification: Verification },
): Promise<void> {
  const v = input.verification;
  if (v.status === "invalid") throw new DomainError("record_invalid", v.reason);
  const check = checkSignature(input.pkg);
  if (check.status === "invalid") throw new DomainError("record_invalid", check.reason);
  await tx.insert(priorRecords).values({
    tenantId: ctx.tenant.id,
    studentId,
    source,
    verified: v.status === "valid",
    issuerName: v.issuer,
    issuedAt: v.status === "valid" || v.status === "revoked" ? new Date(v.issuedAt) : null,
    sourceRecordId: v.status === "valid" || v.status === "revoked" ? v.recordId : null,
    sha256: check.sha256,
    package: input.pkg,
    importedByUserId: ctx.userId,
  });
}

const importSchema = z.object({
  /** The file's text. */
  file: z
    .string()
    .min(2, "Choose a learner record file.")
    .max(2_000_000, "The file is too large (at most 2 MB)."),
  /** Attach to this student, or create a new one (optionally placed in a class this term). */
  studentId: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid().optional()),
  classId: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid().optional()),
});

/**
 * Imports a learner record from a file. A valid EduBridge signature makes it verified and keeps the
 * child's learner identity; a record in the documented format without a signature (from a school not on
 * EduBridge) is kept as unverified; a signature that does not match (a changed record) is refused, as is
 * a revoked record.
 */
export async function importLearnerRecord(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ studentId: string; verified: boolean; created: boolean }> {
  assertAllowed(ctx, "transfers.manage");
  assertAllowed(ctx, "students.manage");
  const data = importSchema.parse(input);
  let pkg: unknown;
  try {
    pkg = JSON.parse(data.file);
  } catch {
    throw new DomainError("record_invalid", "This file is not a learner record (it is not JSON).", "file");
  }
  const verification = await verifyLearnerPackage(database, pkg);
  if (verification.status === "invalid") throw new DomainError("record_invalid", verification.reason, "file");
  if (verification.status === "revoked")
    throw new DomainError("record_revoked", "The school that issued this record has revoked it.", "file");
  const record = verification.record as Partial<LearnerRecord>;
  const unsignedShape = recordShape.shape.student.safeParse(record.student);
  if (!unsignedShape.success)
    throw new DomainError("record_invalid", "The record does not name the child.", "file");
  if (verification.status === "valid" && verification.development && process.env.NODE_ENV === "production")
    throw new DomainError("record_invalid", "This record was signed with a development key.", "file");

  return withTenant(database, scope(ctx), async (tx) => {
    let studentId = data.studentId;
    const created = !studentId;
    if (studentId) {
      const [found] = await tx
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, studentId)));
      if (!found) throw new DomainError("student_not_found", "Student not found.", "studentId");
    } else {
      const s = unsignedShape.data;
      const made = await createStudent(
        tx as unknown as Database,
        ctx,
        {
          firstName: s.firstName,
          otherNames: s.otherNames ?? undefined,
          lastName: s.lastName,
          sex: s.sex,
          dateOfBirth: s.dateOfBirth ?? undefined,
          classId: data.classId,
        },
        // Only a verified record carries the learner identity across.
        verification.status === "valid" ? { learnerId: verification.record.learnerId } : {},
      );
      studentId = made.id;
      await addGuardiansFrom(tx, ctx, studentId, record.guardians);
    }
    await storePriorRecordInTx(tx, ctx, studentId, "import", {
      pkg: pkg as Record<string, unknown>,
      verification,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "learner_record.imported",
      entityType: "student",
      entityId: studentId,
      metadata: { verified: verification.status === "valid", issuer: verification.issuer, created },
    });
    return { studentId, verified: verification.status === "valid", created };
  });
}

/** Adds the record's guardians (those with a phone number) to a newly created student. */
export async function addGuardiansFrom(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
  list: unknown,
): Promise<void> {
  const parsed = z
    .array(
      z.object({
        fullName: z.string().min(1).max(100),
        phone: z.string().nullable().optional(),
        relationship: z.string(),
      }),
    )
    .safeParse(list);
  if (!parsed.success) return;
  const allowedRelationships = new Set(["mother", "father", "guardian", "grandparent", "sibling", "other"]);
  for (const g of parsed.data.slice(0, 6)) {
    if (!g.phone) continue;
    await addGuardian(tx as unknown as Database, ctx, studentId, {
      fullName: g.fullName,
      phone: g.phone,
      relationship: allowedRelationships.has(g.relationship) ? g.relationship : "guardian",
    });
  }
}

export interface PriorRecordRow {
  id: string;
  source: "transfer" | "import";
  verified: boolean;
  issuerName: string;
  issuedAt: Date | null;
  importedAt: Date;
  importedBy: string;
  record: LearnerRecord | Record<string, unknown>;
}

/** Records received from a student's previous schools, for the student page. */
export async function listPriorRecords(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<PriorRecordRow[]> {
  assertAllowed(ctx, "students.view_all");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: priorRecords.id,
        source: priorRecords.source,
        verified: priorRecords.verified,
        issuerName: priorRecords.issuerName,
        issuedAt: priorRecords.issuedAt,
        importedAt: priorRecords.importedAt,
        importedBy: users.name,
        pkg: priorRecords.package,
      })
      .from(priorRecords)
      .innerJoin(users, eq(users.id, priorRecords.importedByUserId))
      .where(and(eq(priorRecords.tenantId, ctx.tenant.id), eq(priorRecords.studentId, studentId)))
      .orderBy(desc(priorRecords.importedAt));
    return rows.map(({ pkg, ...r }) => ({ ...r, record: (pkg.record ?? {}) as Record<string, unknown> }));
  });
}
