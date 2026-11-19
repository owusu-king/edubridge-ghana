import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { toCsv, type CsvValue } from "../../lib/csv";
import { formatScore } from "../../lib/assessment";
import { pesewasToDecimal } from "../../lib/money";
import { WEEKDAY_NAMES } from "../../lib/timetable";
import { recordAudit } from "../audit/record";
import { audienceLabels } from "../messages/audience";
import { assertAllowed, type Permission } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  applications,
  assets,
  boardingAssignments,
  boardingBeds,
  boardingExeats,
  boardingHouses,
  boardingRooms,
  inventorySuppliers,
  libraryCopies,
  libraryLoans,
  libraryTitles,
  maintenanceRequests,
  purchaseRequestLines,
  purchaseRequests,
  stockItems,
  stockMovements,
  assessmentScores,
  attendanceMarks,
  attendanceRegisters,
  auditEvents,
  campuses,
  classes,
  consentAnswers,
  consentForms,
  enrolments,
  feeItems,
  guardians,
  ledgerEntries,
  lessonMarks,
  lessonRegisters,
  levels,
  memberships,
  payments,
  paymentVoids,
  pickupCollectors,
  pickups,
  schoolEvents,
  studentGuardians,
  students,
  subjects,
  terms,
  timetableLessons,
  transportAssignments,
  transportRoutes,
  transportStops,
  transportTripMarks,
  transportTrips,
  timetablePeriods,
  users,
  visitorVisits,
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
  lesson_attendance: {
    name: "Lesson attendance",
    description: "Every lesson register mark: day, period, class, subject, student, status and reason.",
    permission: "data.export",
  },
  timetables: {
    name: "Timetables",
    description: "Every class's lessons by term: day, period, times, subject and teacher.",
    permission: "data.export",
  },
  marks: {
    name: "Marks",
    description: "Every mark entered, by term, class, subject and part.",
    permission: "data.export",
  },
  applications: {
    name: "Applications",
    description:
      "Every inquiry and application: stage, source, child, level, starting term and parent (removed details stay removed).",
    permission: "data.export",
  },
  events: {
    name: "Events",
    description: "Every school event: dates, times, place, who it was for, reminders and cancellations.",
    permission: "data.export",
  },
  consent_answers: {
    name: "Consent answers",
    description:
      "Every answer to every consent form, including changed answers: child, answer, note, guardian, how and when.",
    permission: "data.export",
  },
  visitors: {
    name: "Visitor log",
    description: "Every visitor: name, phone, organisation, purpose, who they visited, campus, in and out.",
    permission: "data.export",
  },
  pickups: {
    name: "Pickups",
    description:
      "Every child released or refused at collection: who came, who recorded it, and cancellations.",
    permission: "data.export",
  },
  collectors: {
    name: "Collectors",
    description:
      "Everyone other than a guardian named as allowed to collect a child, with last day and when ended.",
    permission: "data.export",
  },
  transport: {
    name: "Transport",
    description:
      "Who rode which route and stop each term, both ways or one way, including assignments that ended.",
    permission: "data.export",
  },
  transport_trips: {
    name: "Bus trips",
    description: "Every child marked on a bus: route, day, morning or afternoon, when they got on and off.",
    permission: "data.export",
  },
  stock: {
    name: "Stock movements",
    description:
      "Every item received, issued or counted, with the supplier, cost, who it went to and who recorded it.",
    permission: "data.export",
  },
  assets: {
    name: "Asset register",
    description:
      "Every asset with its tag, location, custodian, condition, cost, and when and why it was disposed of.",
    permission: "data.export",
  },
  purchases: {
    name: "Purchase requests",
    description:
      "Every line of every purchase request: status, who asked and decided, prices and what arrived.",
    permission: "data.export",
  },
  maintenance: {
    name: "Maintenance requests",
    description:
      "Every maintenance request: what, where, how urgent, status, who it is with and who reported it.",
    permission: "data.export",
  },
  library_catalogue: {
    name: "Library catalogue",
    description:
      "Every copy of every book: number, title, author, ISBN, shelf, and when and why it was withdrawn.",
    permission: "data.export",
  },
  library_loans: {
    name: "Library loans",
    description:
      "Every loan: book, borrower, due date, renewals, when returned or lost, and any fine charged.",
    permission: "data.export",
  },
  boarding: {
    name: "Boarders",
    description:
      "Who slept in which house, room and bed each term, including moves and placements that ended.",
    permission: "data.export",
  },
  exeats: {
    name: "Exeats",
    description:
      "Every boarder signed out and back in: why, who collected them, when due back and when back.",
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

/** Amounts are written in the school's currency, as plain decimals with its own number of decimal places. */
const READERS: Record<Dataset, (tx: Transaction, tenantId: string, currency: string) => Promise<Rows>> = {
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

  async fee_ledger(tx, tenantId, currency) {
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
        pesewasToDecimal(r.entry.amountPesewas, currency),
        r.reverses,
        r.receipt,
        r.recordedBy,
        iso(r.entry.recordedAt),
      ]),
    ];
  },

  async payments(tx, tenantId, currency) {
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
        pesewasToDecimal(r.payment.amountPesewas, currency),
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

  async balances(tx, tenantId, currency) {
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
        pesewasToDecimal(Number(r.balance), currency),
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

  async lesson_attendance(tx, tenantId) {
    const rows = await tx
      .select({
        date: lessonRegisters.date,
        term: terms.name,
        period: timetablePeriods.name,
        className: classes.name,
        subject: subjects.name,
        student: students,
        status: lessonMarks.status,
        reason: lessonMarks.reason,
      })
      .from(lessonMarks)
      .innerJoin(lessonRegisters, eq(lessonRegisters.id, lessonMarks.registerId))
      .innerJoin(terms, eq(terms.id, lessonRegisters.termId))
      .innerJoin(timetablePeriods, eq(timetablePeriods.id, lessonRegisters.periodId))
      .innerJoin(classes, eq(classes.id, lessonRegisters.classId))
      .innerJoin(subjects, eq(subjects.id, lessonRegisters.subjectId))
      .innerJoin(students, eq(students.id, lessonMarks.studentId))
      .where(eq(lessonMarks.tenantId, tenantId))
      .orderBy(
        asc(lessonRegisters.date),
        asc(timetablePeriods.startsAt),
        asc(classes.name),
        asc(students.admissionNumber),
      );
    return [
      ["Date", "Term", "Period", "Class", "Subject", "Admission number", "Student", "Status", "Reason"],
      ...rows.map((r) => [
        r.date,
        r.term,
        r.period,
        r.className,
        r.subject,
        r.student.admissionNumber,
        name(r.student),
        r.status,
        r.reason,
      ]),
    ];
  },

  async timetables(tx, tenantId) {
    const rows = await tx
      .select({
        term: terms.name,
        termStart: terms.startsOn,
        className: classes.name,
        weekday: timetableLessons.weekday,
        period: timetablePeriods.name,
        startsAt: timetablePeriods.startsAt,
        endsAt: timetablePeriods.endsAt,
        subject: subjects.name,
        teacher: users.name,
      })
      .from(timetableLessons)
      .innerJoin(terms, eq(terms.id, timetableLessons.termId))
      .innerJoin(classes, eq(classes.id, timetableLessons.classId))
      .innerJoin(timetablePeriods, eq(timetablePeriods.id, timetableLessons.periodId))
      .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
      .leftJoin(memberships, eq(memberships.id, timetableLessons.membershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(timetableLessons.tenantId, tenantId))
      .orderBy(
        asc(terms.startsOn),
        asc(classes.name),
        asc(timetableLessons.weekday),
        asc(timetablePeriods.startsAt),
      );
    return [
      ["Term", "Class", "Day", "Period", "Starts", "Ends", "Subject", "Teacher"],
      ...rows.map((r) => [
        r.term,
        r.className,
        WEEKDAY_NAMES[r.weekday],
        r.period,
        r.startsAt,
        r.endsAt,
        r.subject,
        r.teacher,
      ]),
    ];
  },

  async applications(tx, tenantId) {
    const rows = await tx
      .select({
        a: applications,
        level: levels.name,
        term: terms.name,
        admissionNumber: students.admissionNumber,
      })
      .from(applications)
      .innerJoin(levels, eq(levels.id, applications.levelId))
      .leftJoin(terms, eq(terms.id, applications.entryTermId))
      .leftJoin(students, eq(students.id, applications.studentId))
      .where(eq(applications.tenantId, tenantId))
      .orderBy(asc(applications.createdAt));
    return [
      [
        "Reference",
        "Stage",
        "Source",
        "Child",
        "Sex",
        "Date of birth",
        "Level",
        "Starting term",
        "Parent or guardian",
        "Phone",
        "Email",
        "Created",
        "Closed",
        "Admission number",
      ],
      ...rows.map(({ a, level, term, admissionNumber }) => [
        a.reference,
        a.status,
        a.source,
        a.erasedAt
          ? "Details removed"
          : [a.childFirstName, a.childOtherNames, a.childLastName].filter(Boolean).join(" "),
        a.sex,
        a.dateOfBirth,
        level,
        term,
        a.guardianName,
        a.guardianPhone,
        a.guardianEmail,
        iso(a.createdAt),
        iso(a.closedAt),
        admissionNumber,
      ]),
    ];
  },

  async events(tx, tenantId) {
    const rows = await tx
      .select({ e: schoolEvents, by: users.name })
      .from(schoolEvents)
      .innerJoin(users, eq(users.id, schoolEvents.createdByUserId))
      .where(eq(schoolEvents.tenantId, tenantId))
      .orderBy(asc(schoolEvents.startsOn));
    const label = await audienceLabels(
      tx,
      tenantId,
      rows.map((r) => r.e),
    );
    return [
      [
        "Event",
        "Starts",
        "Ends",
        "Start time",
        "End time",
        "Place",
        "For",
        "Reminder",
        "Reminded",
        "Reminder SMS",
        "Reminder notifications",
        "Cancelled",
        "Created by",
        "Created",
      ],
      ...rows.map(({ e, by }) => [
        e.title,
        e.startsOn,
        e.endsOn,
        e.startTime,
        e.endTime,
        e.location,
        label(e),
        e.reminder === "none" ? "none" : `${e.reminder}, ${e.reminderDaysBefore} days before`,
        iso(e.remindedAt),
        e.reminderSmsCount,
        e.reminderPushCount,
        iso(e.cancelledAt),
        by,
        iso(e.createdAt),
      ]),
    ];
  },

  async consent_answers(tx, tenantId) {
    const recorder = sql<
      string | null
    >`(select u.name from ${users} u where u.id = ${consentAnswers.recordedByUserId})`;
    const rows = await tx
      .select({
        form: consentForms.title,
        deadline: consentForms.deadline,
        student: students,
        guardian: guardians.fullName,
        a: consentAnswers,
        recorder,
      })
      .from(consentAnswers)
      .innerJoin(consentForms, eq(consentForms.id, consentAnswers.formId))
      .innerJoin(students, eq(students.id, consentAnswers.studentId))
      .innerJoin(guardians, eq(guardians.id, consentAnswers.guardianId))
      .where(eq(consentAnswers.tenantId, tenantId))
      .orderBy(asc(consentForms.createdAt), asc(consentAnswers.createdAt));
    return [
      [
        "Form",
        "Deadline",
        "Admission number",
        "Child",
        "Answer",
        "Note",
        "Guardian",
        "Given",
        "Phone",
        "Recorded by",
        "Answered",
      ],
      ...rows.map((r) => [
        r.form,
        r.deadline,
        r.student.admissionNumber,
        name(r.student),
        r.a.answer,
        r.a.note,
        r.guardian,
        r.a.source === "office" ? "on paper" : "parent view",
        r.a.phone,
        r.recorder,
        iso(r.a.createdAt),
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

  async visitors(tx, tenantId) {
    const host = alias(users, "host_user");
    const inBy = alias(users, "in_by");
    const rows = await tx
      .select({ v: visitorVisits, host: host.name, campus: campuses.name, inBy: inBy.name })
      .from(visitorVisits)
      .leftJoin(memberships, eq(memberships.id, visitorVisits.hostMembershipId))
      .leftJoin(host, eq(host.id, memberships.userId))
      .leftJoin(campuses, eq(campuses.id, visitorVisits.campusId))
      .innerJoin(inBy, eq(inBy.id, visitorVisits.signedInByUserId))
      .where(eq(visitorVisits.tenantId, tenantId))
      .orderBy(asc(visitorVisits.signedInAt));
    return [
      [
        "Signed in",
        "Signed out",
        "Name",
        "Phone",
        "Organisation",
        "Purpose",
        "Visiting",
        "Campus",
        "Badge",
        "Note",
        "Signed in by",
      ],
      ...rows.map((r) => [
        iso(r.v.signedInAt),
        iso(r.v.signedOutAt),
        r.v.fullName,
        r.v.phone,
        r.v.organisation,
        r.v.purpose,
        r.host ?? r.v.hostName,
        r.campus,
        r.v.badge,
        r.v.note,
        r.inBy,
      ]),
    ];
  },

  async pickups(tx, tenantId) {
    const rows = await tx
      .select({ p: pickups, s: students, by: users.name })
      .from(pickups)
      .innerJoin(students, eq(students.id, pickups.studentId))
      .innerJoin(users, eq(users.id, pickups.recordedByUserId))
      .where(eq(pickups.tenantId, tenantId))
      .orderBy(asc(pickups.recordedAt));
    return [
      [
        "When",
        "Day",
        "Admission number",
        "Child",
        "Outcome",
        "Person",
        "Relationship",
        "Why refused",
        "Note",
        "Recorded by",
        "Cancelled",
        "Why cancelled",
      ],
      ...rows.map((r) => [
        iso(r.p.recordedAt),
        r.p.onDate,
        r.s.admissionNumber,
        name(r.s),
        r.p.outcome,
        r.p.personName,
        r.p.relationship,
        r.p.reason,
        r.p.note,
        r.by,
        iso(r.p.cancelledAt),
        r.p.cancelReason,
      ]),
    ];
  },

  async collectors(tx, tenantId) {
    const rows = await tx
      .select({ c: pickupCollectors, s: students })
      .from(pickupCollectors)
      .innerJoin(students, eq(students.id, pickupCollectors.studentId))
      .where(eq(pickupCollectors.tenantId, tenantId))
      .orderBy(asc(students.admissionNumber), asc(pickupCollectors.addedAt));
    return [
      [
        "Admission number",
        "Child",
        "Collector",
        "Relationship",
        "Phone",
        "Last day",
        "Note",
        "Added",
        "Ended",
        "Why ended",
      ],
      ...rows.map((r) => [
        r.s.admissionNumber,
        name(r.s),
        r.c.fullName,
        r.c.relationship,
        r.c.phone,
        r.c.validUntil,
        r.c.note,
        iso(r.c.addedAt),
        iso(r.c.endedAt),
        r.c.endReason,
      ]),
    ];
  },

  async transport(tx, tenantId) {
    const rows = await tx
      .select({
        a: transportAssignments,
        s: students,
        term: terms.name,
        year: academicYears.name,
        route: transportRoutes.name,
        stop: transportStops.name,
      })
      .from(transportAssignments)
      .innerJoin(students, eq(students.id, transportAssignments.studentId))
      .innerJoin(terms, eq(terms.id, transportAssignments.termId))
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .innerJoin(transportRoutes, eq(transportRoutes.id, transportAssignments.routeId))
      .innerJoin(transportStops, eq(transportStops.id, transportAssignments.stopId))
      .where(eq(transportAssignments.tenantId, tenantId))
      .orderBy(asc(terms.startsOn), asc(students.admissionNumber), asc(transportAssignments.createdAt));
    return [
      ["Academic year", "Term", "Admission number", "Student", "Route", "Stop", "Rides", "From", "Ended"],
      ...rows.map((r) => [
        r.year,
        r.term,
        r.s.admissionNumber,
        name(r.s),
        r.route,
        r.stop,
        r.a.direction,
        iso(r.a.createdAt),
        iso(r.a.endedAt),
      ]),
    ];
  },

  async transport_trips(tx, tenantId) {
    const rows = await tx
      .select({ m: transportTripMarks, t: transportTrips, s: students, route: transportRoutes.name })
      .from(transportTripMarks)
      .innerJoin(transportTrips, eq(transportTrips.id, transportTripMarks.tripId))
      .innerJoin(transportRoutes, eq(transportRoutes.id, transportTrips.routeId))
      .innerJoin(students, eq(students.id, transportTripMarks.studentId))
      .where(eq(transportTripMarks.tenantId, tenantId))
      .orderBy(asc(transportTrips.onDate), asc(transportRoutes.name), asc(transportTripMarks.boardedAt));
    return [
      ["Day", "Route", "Direction", "Admission number", "Student", "Got on", "Got off"],
      ...rows.map((r) => [
        r.t.onDate,
        r.route,
        r.t.direction,
        r.s.admissionNumber,
        name(r.s),
        iso(r.m.boardedAt),
        iso(r.m.leftAt),
      ]),
    ];
  },

  async stock(tx, tenantId, currency) {
    const rows = await tx
      .select({
        m: stockMovements,
        item: stockItems.name,
        unit: stockItems.unit,
        supplier: inventorySuppliers.name,
        by: users.name,
      })
      .from(stockMovements)
      .innerJoin(stockItems, eq(stockItems.id, stockMovements.itemId))
      .innerJoin(users, eq(users.id, stockMovements.recordedByUserId))
      .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, stockMovements.supplierId))
      .where(eq(stockMovements.tenantId, tenantId))
      .orderBy(asc(stockMovements.recordedAt));
    return [
      [
        "When",
        "Item",
        "Unit",
        "Movement",
        "Quantity",
        "Unit cost",
        "Supplier",
        "Issued to",
        "Reason",
        "Recorded by",
      ],
      ...rows.map((r) => [
        iso(r.m.recordedAt),
        r.item,
        r.unit,
        r.m.kind,
        r.m.quantity,
        r.m.unitCostMinor === null ? "" : pesewasToDecimal(r.m.unitCostMinor, currency),
        r.supplier,
        r.m.issuedTo,
        r.m.reason,
        r.by,
      ]),
    ];
  },

  async assets(tx, tenantId, currency) {
    const custodian = alias(users, "custodian_user");
    const rows = await tx
      .select({ a: assets, custodian: custodian.name, supplier: inventorySuppliers.name })
      .from(assets)
      .leftJoin(memberships, eq(memberships.id, assets.custodianMembershipId))
      .leftJoin(custodian, eq(custodian.id, memberships.userId))
      .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, assets.supplierId))
      .where(eq(assets.tenantId, tenantId))
      .orderBy(asc(assets.tag));
    return [
      [
        "Tag",
        "Name",
        "Category",
        "Serial number",
        "Location",
        "Custodian",
        "Condition",
        "Acquired on",
        "Cost",
        "Supplier",
        "Status",
        "Disposed",
        "Why disposed",
      ],
      ...rows.map((r) => [
        r.a.tag,
        r.a.name,
        r.a.category,
        r.a.serialNumber,
        r.a.location,
        r.custodian ?? r.a.custodianName,
        r.a.condition,
        r.a.acquiredOn,
        r.a.costMinor === null ? "" : pesewasToDecimal(r.a.costMinor, currency),
        r.supplier,
        r.a.status,
        iso(r.a.disposedAt),
        r.a.disposalReason,
      ]),
    ];
  },

  async purchases(tx, tenantId, currency) {
    const requester = alias(users, "requester");
    const decider = alias(users, "decider");
    const rows = await tx
      .select({
        r: purchaseRequests,
        l: purchaseRequestLines,
        requester: requester.name,
        decider: decider.name,
        supplier: inventorySuppliers.name,
      })
      .from(purchaseRequestLines)
      .innerJoin(purchaseRequests, eq(purchaseRequests.id, purchaseRequestLines.requestId))
      .innerJoin(requester, eq(requester.id, purchaseRequests.requestedByUserId))
      .leftJoin(decider, eq(decider.id, purchaseRequests.decidedByUserId))
      .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, purchaseRequests.supplierId))
      .where(eq(purchaseRequestLines.tenantId, tenantId))
      .orderBy(asc(purchaseRequests.requestedAt), asc(purchaseRequestLines.position));
    return [
      [
        "Reference",
        "Title",
        "Status",
        "Requested by",
        "Requested",
        "Decided by",
        "Decided",
        "Supplier",
        "Line",
        "Quantity",
        "Unit price",
        "Received",
      ],
      ...rows.map((x) => [
        x.r.reference,
        x.r.title,
        x.r.status,
        x.requester,
        iso(x.r.requestedAt),
        x.decider,
        iso(x.r.decidedAt),
        x.supplier,
        x.l.description,
        x.l.quantity,
        x.l.unitPriceMinor === null ? "" : pesewasToDecimal(x.l.unitPriceMinor, currency),
        x.l.receivedQuantity,
      ]),
    ];
  },

  async maintenance(tx, tenantId) {
    const rows = await tx
      .select({ m: maintenanceRequests, by: users.name, asset: assets.tag })
      .from(maintenanceRequests)
      .innerJoin(users, eq(users.id, maintenanceRequests.reportedByUserId))
      .leftJoin(assets, eq(assets.id, maintenanceRequests.assetId))
      .where(eq(maintenanceRequests.tenantId, tenantId))
      .orderBy(asc(maintenanceRequests.reportedAt));
    return [
      [
        "Reference",
        "Title",
        "Location",
        "Asset",
        "Priority",
        "Status",
        "With",
        "Reported by",
        "Reported",
        "Last change",
      ],
      ...rows.map((r) => [
        r.m.reference,
        r.m.title,
        r.m.location,
        r.asset,
        r.m.priority,
        r.m.status,
        r.m.assignedTo,
        r.by,
        iso(r.m.reportedAt),
        iso(r.m.updatedAt),
      ]),
    ];
  },

  async library_catalogue(tx, tenantId) {
    const rows = await tx
      .select({ c: libraryCopies, t: libraryTitles })
      .from(libraryCopies)
      .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
      .where(eq(libraryCopies.tenantId, tenantId))
      .orderBy(asc(libraryCopies.number));
    return [
      [
        "Copy",
        "Title",
        "Author",
        "ISBN",
        "Publisher",
        "Year",
        "Category",
        "Shelf",
        "Status",
        "Withdrawn",
        "Why withdrawn",
      ],
      ...rows.map((r) => [
        r.c.number,
        r.t.title,
        r.t.author,
        r.t.isbn,
        r.t.publisher,
        r.t.publishedYear,
        r.t.category,
        r.c.shelf,
        r.c.status,
        iso(r.c.withdrawnAt),
        r.c.withdrawnReason,
      ]),
    ];
  },

  async library_loans(tx, tenantId, currency) {
    const member = alias(users, "member_user");
    const rows = await tx
      .select({
        l: libraryLoans,
        copy: libraryCopies.number,
        title: libraryTitles.title,
        s: students,
        member: member.name,
      })
      .from(libraryLoans)
      .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
      .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
      .leftJoin(students, eq(students.id, libraryLoans.studentId))
      .leftJoin(memberships, eq(memberships.id, libraryLoans.membershipId))
      .leftJoin(member, eq(member.id, memberships.userId))
      .where(eq(libraryLoans.tenantId, tenantId))
      .orderBy(asc(libraryLoans.loanedAt));
    return [
      [
        "Lent",
        "Copy",
        "Title",
        "Borrower",
        "Admission number",
        "Due",
        "Renewals",
        "Returned",
        "Lost",
        "Fine",
      ],
      ...rows.map((r) => [
        iso(r.l.loanedAt),
        r.copy,
        r.title,
        r.s ? name(r.s) : r.member,
        r.s?.admissionNumber,
        r.l.dueOn,
        r.l.renewals,
        iso(r.l.returnedAt),
        iso(r.l.lostAt),
        r.l.fineMinor === null ? "" : pesewasToDecimal(r.l.fineMinor, currency),
      ]),
    ];
  },

  async boarding(tx, tenantId) {
    const rows = await tx
      .select({
        a: boardingAssignments,
        s: students,
        term: terms.name,
        year: academicYears.name,
        house: boardingHouses.name,
        room: boardingRooms.name,
        bed: boardingBeds.label,
      })
      .from(boardingAssignments)
      .innerJoin(students, eq(students.id, boardingAssignments.studentId))
      .innerJoin(terms, eq(terms.id, boardingAssignments.termId))
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .innerJoin(boardingBeds, eq(boardingBeds.id, boardingAssignments.bedId))
      .innerJoin(boardingRooms, eq(boardingRooms.id, boardingBeds.roomId))
      .innerJoin(boardingHouses, eq(boardingHouses.id, boardingRooms.houseId))
      .where(eq(boardingAssignments.tenantId, tenantId))
      .orderBy(asc(terms.startsOn), asc(students.admissionNumber), asc(boardingAssignments.createdAt));
    return [
      ["Academic year", "Term", "Admission number", "Student", "House", "Room", "Bed", "From", "Ended"],
      ...rows.map((r) => [
        r.year,
        r.term,
        r.s.admissionNumber,
        name(r.s),
        r.house,
        r.room,
        r.bed,
        iso(r.a.createdAt),
        iso(r.a.endedAt),
      ]),
    ];
  },

  async exeats(tx, tenantId) {
    const rows = await tx
      .select({ e: boardingExeats, s: students, house: boardingHouses.name, by: users.name })
      .from(boardingExeats)
      .innerJoin(students, eq(students.id, boardingExeats.studentId))
      .innerJoin(boardingHouses, eq(boardingHouses.id, boardingExeats.houseId))
      .innerJoin(users, eq(users.id, boardingExeats.outByUserId))
      .where(eq(boardingExeats.tenantId, tenantId))
      .orderBy(asc(boardingExeats.outAt));
    return [
      [
        "Out",
        "Admission number",
        "Student",
        "House",
        "Why",
        "Collected by",
        "Due back",
        "Back",
        "Signed out by",
      ],
      ...rows.map((r) => [
        iso(r.e.outAt),
        r.s.admissionNumber,
        name(r.s),
        r.house,
        r.e.reason,
        r.e.collectedBy,
        r.e.expectedBackOn,
        iso(r.e.backAt),
        r.by,
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
      const rows = await READERS[dataset](tx, ctx.tenant.id, ctx.tenant.currencyCode);
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
