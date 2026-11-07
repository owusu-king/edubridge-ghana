import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { toCsv, type CsvValue } from "../../lib/csv";
import { formatScore } from "../../lib/assessment";
import { pesewasToDecimal } from "../../lib/money";
import { recordAudit } from "../audit/record";
import { assertAllowed, type Permission } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  assessmentScores,
  attendanceMarks,
  attendanceRegisters,
  auditEvents,
  campuses,
  classes,
  enrolments,
  feeItems,
  guardians,
  ledgerEntries,
  levels,
  payments,
  paymentVoids,
  studentGuardians,
  students,
  subjects,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * A school's own records as CSV files, for its accountant, an inspection, or moving to another system.
 * Exports cover the whole school, so they need access to every campus; every download is audited. Exports
 * do not depend on the plan: a school can always take out what it has recorded.
 */

export const DATASETS = {
  students: {
    name: "Students",
    description: "Every student: admission number, names, sex, date of birth, status and this term's class.",
    permission: "data.export",
  },
  guardians: {
    name: "Guardians",
    description: "Each student's guardians, with phone, email, relationship and the primary contact.",
    permission: "data.export",
  },
  classes: {
    name: "Classes by term",
    description: "Which class each student was in, for every term.",
    permission: "data.export",
  },
  fee_ledger: {
    name: "Fee accounts",
    description: "Every entry on every fee account: charges, discounts, payments, adjustments and reversals.",
    permission: "fees.export",
  },
  payments: {
    name: "Payments and receipts",
    description: "Every receipt issued, with method, reference and payer, including voided ones.",
    permission: "fees.export",
  },
  balances: {
    name: "Balances",
    description: "What each student owes today (negative means in credit).",
    permission: "fees.export",
  },
  attendance: {
    name: "Attendance",
    description: "Every register mark: day, class, student, status and reason.",
    permission: "data.export",
  },
  marks: {
    name: "Marks",
    description: "Every mark entered, by term, class, subject and part.",
    permission: "data.export",
  },
  audit_log: {
    name: "Audit log",
    description: "Every recorded change: when, who, what and the details kept with it.",
    permission: "data.export",
  },
} as const satisfies Record<string, { name: string; description: string; permission: Permission }>;

export type Dataset = keyof typeof DATASETS;

export function isDataset(value: string): value is Dataset {
  return Object.hasOwn(DATASETS, value);
}

type Rows = CsvValue[][];
const name = (s: { firstName: string; otherNames: string | null; lastName: string }) =>
  [s.firstName, s.otherNames, s.lastName].filter(Boolean).join(" ");
const iso = (d: Date | null) => (d ? d.toISOString() : "");

/** This term's class per student, for the students and balances files. */
async function currentClasses(tx: Transaction, tenantId: string) {
  const rows = await tx
    .select({ studentId: enrolments.studentId, className: classes.name, campusName: campuses.name })
    .from(enrolments)
    .innerJoin(terms, eq(terms.id, enrolments.termId))
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .innerJoin(campuses, eq(campuses.id, classes.campusId))
    .where(sql`${enrolments.tenantId} = ${tenantId} and ${terms.isCurrent}`);
  return new Map(rows.map((r) => [r.studentId, r]));
}

const READERS: Record<Dataset, (tx: Transaction, tenantId: string) => Promise<Rows>> = {
  async students(tx, tenantId) {
    const current = await currentClasses(tx, tenantId);
    const rows = await tx
      .select()
      .from(students)
      .where(eq(students.tenantId, tenantId))
      .orderBy(asc(students.admissionNumber));
    return [
      [
        "Admission number",
        "First name",
        "Other names",
        "Surname",
        "Sex",
        "Date of birth",
        "Admitted on",
        "Status",
        "Class this term",
        "Campus",
      ],
      ...rows.map((s) => [
        s.admissionNumber,
        s.firstName,
        s.otherNames,
        s.lastName,
        s.sex,
        s.dateOfBirth,
        s.admittedOn,
        s.status,
        current.get(s.id)?.className,
        current.get(s.id)?.campusName,
      ]),
    ];
  },

  async guardians(tx, tenantId) {
    const rows = await tx
      .select({ student: students, guardian: guardians, link: studentGuardians })
      .from(studentGuardians)
      .innerJoin(students, eq(students.id, studentGuardians.studentId))
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(eq(studentGuardians.tenantId, tenantId))
      .orderBy(asc(students.admissionNumber), asc(guardians.fullName));
    return [
      [
        "Admission number",
        "Student",
        "Guardian",
        "Phone",
        "Email",
        "Relationship",
        "Primary contact",
        "Parent view blocked on",
      ],
      ...rows.map((r) => [
        r.student.admissionNumber,
        name(r.student),
        r.guardian.fullName,
        r.guardian.phone,
        r.guardian.email,
        r.link.relationship,
        r.link.isPrimary ? "yes" : "no",
        iso(r.guardian.portalBlockedAt),
      ]),
    ];
  },

  async classes(tx, tenantId) {
    const rows = await tx
      .select({
        year: academicYears.name,
        term: terms.name,
        startsOn: terms.startsOn,
        className: classes.name,
        level: levels.name,
        campus: campuses.name,
        student: students,
      })
      .from(enrolments)
      .innerJoin(terms, eq(terms.id, enrolments.termId))
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .innerJoin(campuses, eq(campuses.id, classes.campusId))
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(eq(enrolments.tenantId, tenantId))
      .orderBy(asc(terms.startsOn), asc(levels.sequence), asc(classes.name), asc(students.admissionNumber));
    return [
      ["Academic year", "Term", "Class", "Level", "Campus", "Admission number", "Student"],
      ...rows.map((r) => [
        r.year,
        r.term,
        r.className,
        r.level,
        r.campus,
        r.student.admissionNumber,
        name(r.student),
      ]),
    ];
  },

  async fee_ledger(tx, tenantId) {
    const rows = await tx
      .select({
        entry: ledgerEntries,
        student: students,
        term: terms.name,
        item: feeItems.name,
        // Written out in full: the outer query joins other tables, so its columns are qualified too.
        reverses: sql<
          number | null
        >`(select r.entry_number from ledger_entries r where r.id = ledger_entries.reverses_entry_id)`,
        receipt: payments.receiptNumber,
        recordedBy: users.name,
      })
      .from(ledgerEntries)
      .innerJoin(students, eq(students.id, ledgerEntries.studentId))
      .leftJoin(terms, eq(terms.id, ledgerEntries.termId))
      .leftJoin(feeItems, eq(feeItems.id, ledgerEntries.feeItemId))
      .leftJoin(payments, eq(payments.id, ledgerEntries.paymentId))
      .leftJoin(users, eq(users.id, ledgerEntries.recordedByUserId))
      .where(eq(ledgerEntries.tenantId, tenantId))
      .orderBy(asc(ledgerEntries.entryNumber));
    return [
      [
        "Entry",
        "Effective on",
        "Admission number",
        "Student",
        "Kind",
        "Description",
        "Term",
        "Fee item",
        "Amount (GHS)",
        "Reverses entry",
        "Receipt",
        "Recorded by",
        "Recorded at",
      ],
      ...rows.map((r) => [
        r.entry.entryNumber,
        r.entry.effectiveOn,
        r.student.admissionNumber,
        name(r.student),
        r.entry.kind,
        r.entry.description,
        r.term,
        r.item,
        pesewasToDecimal(r.entry.amountPesewas),
        r.reverses,
        r.receipt,
        r.recordedBy,
        iso(r.entry.recordedAt),
      ]),
    ];
  },

  async payments(tx, tenantId) {
    const rows = await tx
      .select({ payment: payments, student: students, recordedBy: users.name, voided: paymentVoids })
      .from(payments)
      .innerJoin(students, eq(students.id, payments.studentId))
      .leftJoin(users, eq(users.id, payments.recordedByUserId))
      .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
      .where(eq(payments.tenantId, tenantId))
      .orderBy(asc(payments.receiptNumber));
    return [
      [
        "Receipt",
        "Paid on",
        "Admission number",
        "Student",
        "Amount (GHS)",
        "Method",
        "Reference",
        "Payer",
        "Recorded by",
        "Recorded at",
        "Voided",
        "Void reason",
        "Voided at",
      ],
      ...rows.map((r) => [
        r.payment.receiptNumber,
        r.payment.paidOn,
        r.student.admissionNumber,
        name(r.student),
        pesewasToDecimal(r.payment.amountPesewas),
        r.payment.method,
        r.payment.reference,
        r.payment.payerName,
        r.recordedBy,
        iso(r.payment.recordedAt),
        r.voided ? "yes" : "no",
        r.voided?.reason,
        iso(r.voided?.voidedAt ?? null),
      ]),
    ];
  },

  async balances(tx, tenantId) {
    const current = await currentClasses(tx, tenantId);
    const rows = await tx
      .select({ student: students, balance: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
      .from(students)
      .leftJoin(ledgerEntries, eq(ledgerEntries.studentId, students.id))
      .where(eq(students.tenantId, tenantId))
      .groupBy(students.id)
      .orderBy(asc(students.admissionNumber));
    return [
      ["Admission number", "Student", "Status", "Class this term", "Balance (GHS)"],
      ...rows.map((r) => [
        r.student.admissionNumber,
        name(r.student),
        r.student.status,
        current.get(r.student.id)?.className,
        pesewasToDecimal(Number(r.balance)),
      ]),
    ];
  },

  async attendance(tx, tenantId) {
    const rows = await tx
      .select({
        date: attendanceRegisters.date,
        term: terms.name,
        className: classes.name,
        student: students,
        status: attendanceMarks.status,
        reason: attendanceMarks.reason,
      })
      .from(attendanceMarks)
      .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
      .innerJoin(terms, eq(terms.id, attendanceRegisters.termId))
      .innerJoin(classes, eq(classes.id, attendanceRegisters.classId))
      .innerJoin(students, eq(students.id, attendanceMarks.studentId))
      .where(eq(attendanceMarks.tenantId, tenantId))
      .orderBy(asc(attendanceRegisters.date), asc(classes.name), asc(students.admissionNumber));
    return [
      ["Date", "Term", "Class", "Admission number", "Student", "Status", "Reason"],
      ...rows.map((r) => [
        r.date,
        r.term,
        r.className,
        r.student.admissionNumber,
        name(r.student),
        r.status,
        r.reason,
      ]),
    ];
  },

  async marks(tx, tenantId) {
    const rows = await tx
      .select({
        year: academicYears.name,
        term: terms.name,
        className: classes.name,
        subject: subjects.name,
        student: students,
        part: assessmentScores.componentKey,
        tenths: assessmentScores.scoreTenths,
      })
      .from(assessmentScores)
      .innerJoin(terms, eq(terms.id, assessmentScores.termId))
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .innerJoin(subjects, eq(subjects.id, assessmentScores.subjectId))
      .innerJoin(students, eq(students.id, assessmentScores.studentId))
      .leftJoin(
        enrolments,
        sql`${enrolments.studentId} = ${assessmentScores.studentId} and ${enrolments.termId} = ${assessmentScores.termId}`,
      )
      .leftJoin(classes, eq(classes.id, enrolments.classId))
      .where(eq(assessmentScores.tenantId, tenantId))
      .orderBy(asc(terms.startsOn), asc(classes.name), asc(subjects.name), asc(students.admissionNumber));
    return [
      ["Academic year", "Term", "Class", "Subject", "Admission number", "Student", "Part", "Mark"],
      ...rows.map((r) => [
        r.year,
        r.term,
        r.className,
        r.subject,
        r.student.admissionNumber,
        name(r.student),
        r.part,
        formatScore(r.tenths),
      ]),
    ];
  },

  async audit_log(tx, tenantId) {
    const rows = await tx
      .select({ event: auditEvents, actor: users.name, email: users.email })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(eq(auditEvents.tenantId, tenantId))
      .orderBy(asc(auditEvents.occurredAt));
    return [
      ["When", "Who", "Email", "Action", "Record type", "Record", "Details"],
      ...rows.map((r) => [
        iso(r.event.occurredAt),
        r.actor,
        r.email,
        r.event.action,
        r.event.entityType,
        r.event.entityId,
        JSON.stringify(r.event.metadata),
      ]),
    ];
  },
};

export interface ExportFile {
  filename: string;
  csv: string;
  rows: number;
}

/** One dataset as a CSV file, audited. */
export async function exportDataset(
  database: Database,
  ctx: TenantContext,
  dataset: Dataset,
): Promise<ExportFile> {
  assertAllowed(ctx, DATASETS[dataset].permission);
  if (ctx.campusIds !== null)
    throw new DomainError(
      "campus_restricted",
      "Exports cover the whole school. Ask a colleague with access to every campus.",
    );
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    async (tx) => {
      const rows = await READERS[dataset](tx, ctx.tenant.id);
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "data.exported",
        entityType: "export",
        metadata: { dataset, rows: rows.length - 1 },
      });
      const today = new Date().toISOString().slice(0, 10);
      return {
        filename: `${ctx.tenant.slug}-${dataset.replace("_", "-")}-${today}.csv`,
        csv: toCsv(rows),
        rows: rows.length - 1,
      };
    },
  );
}
