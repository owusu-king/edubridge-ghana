import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "@/lib/format";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  guardians,
  ledgerEntries,
  payments,
  paymentVoids,
  studentGuardians,
  students,
  terms,
} from "../db/schema";
import type { ReportCardSnapshot } from "@/lib/assessment";
import { readPublishedReportCards, readPublishedSnapshot } from "../assessment/report-cards";
import { readStudentAccount, type StudentAccount } from "../fees/ledger";
import { readPaymentPlan, type PaymentPlan } from "../fees/payment-plans";
import { readReceipt, type PaymentMethod, type Receipt } from "../fees/payments";
import { fullName } from "../students/service";
import { schoolBySlug, schoolsForPhone, type ParentSchoolRef } from "./schools";

/**
 * What a signed-in parent sees: the children linked to guardians with their number, at every school,
 * each school read in its own tenant transaction (`02` §5.3). Access is worked out on every request from
 * the guardian records, so a school's change (new number, unlinking, blocking) applies at once.
 * Reads use the same functions as staff screens, so parents and the accountant see the same figures.
 */

/** No user: parents are not school members. Audit entries made in these transactions have no actor. */
const parentScope = (tenantId: string) => ({ tenantId, userId: "" });

export interface ChildSummary {
  studentId: string;
  name: string;
  firstName: string;
  className: string | null;
  status: "active" | "withdrawn" | "graduated";
  balancePesewas: number;
  lastPayment: { paidOn: string; amountPesewas: number } | null;
  /** The next unpaid instalment of an active payment plan, with what is left to pay on it. */
  nextDue: { dueOn: string; amountPesewas: number } | null;
  overduePesewas: number;
}

export interface ParentSchool {
  slug: string;
  name: string;
  children: ChildSummary[];
}

/** Students linked to a guardian with this number at the current school who is not blocked. */
async function linkedStudents(tx: Transaction, tenantId: string, phone: string, studentId?: string) {
  return tx
    .selectDistinct({
      id: students.id,
      firstName: students.firstName,
      otherNames: students.otherNames,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
      status: students.status,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .innerJoin(students, eq(students.id, studentGuardians.studentId))
    .where(
      and(
        eq(studentGuardians.tenantId, tenantId),
        eq(guardians.phone, phone),
        isNull(guardians.portalBlockedAt),
        studentId ? eq(students.id, studentId) : undefined,
      ),
    )
    .orderBy(asc(students.firstName), asc(students.lastName));
}

async function currentClass(tx: Transaction, tenantId: string, studentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: classes.name })
    .from(enrolments)
    .innerJoin(terms, eq(terms.id, enrolments.termId))
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .where(
      and(eq(enrolments.tenantId, tenantId), eq(enrolments.studentId, studentId), eq(terms.isCurrent, true)),
    );
  return row?.name ?? null;
}

/** Balance, last payment, plan position and class of one student, inside a tenant transaction. */
export async function readChildSummary(
  tx: Transaction,
  tenantId: string,
  student: {
    id: string;
    firstName: string;
    otherNames: string | null;
    lastName: string;
    status: ChildSummary["status"];
  },
  today: string,
): Promise<ChildSummary> {
  const [balance] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.studentId, student.id)));
  const [lastPayment] = await tx
    .select({ paidOn: payments.paidOn, amountPesewas: payments.amountPesewas })
    .from(payments)
    .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
    .where(
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.studentId, student.id),
        isNull(paymentVoids.paymentId),
      ),
    )
    .orderBy(desc(payments.paidOn), desc(payments.recordedAt))
    .limit(1);
  const plan = await readPaymentPlan(tx, tenantId, student.id, today);
  const next = plan?.progress.nextDue;
  return {
    studentId: student.id,
    name: fullName(student),
    firstName: student.firstName,
    className: await currentClass(tx, tenantId, student.id),
    status: student.status,
    balancePesewas: Number(balance!.total),
    lastPayment: lastPayment ?? null,
    nextDue: next ? { dueOn: next.dueOn, amountPesewas: next.amountPesewas - next.paidPesewas } : null,
    overduePesewas: plan?.progress.overduePesewas ?? 0,
  };
}

/** Every child the number reaches, grouped by school. Schools with no linked child are left out. */
export async function listParentChildren(database: Database, phone: string): Promise<ParentSchool[]> {
  const schools = await schoolsForPhone(database, phone);
  const result: ParentSchool[] = [];
  for (const school of schools) {
    const children = await withTenant(database, parentScope(school.id), async (tx) => {
      const today = todayIn(school.timezone);
      const rows = await linkedStudents(tx, school.id, phone);
      const summaries: ChildSummary[] = [];
      for (const row of rows) summaries.push(await readChildSummary(tx, school.id, row, today));
      return summaries;
    });
    if (children.length > 0) result.push({ slug: school.slug, name: school.name, children });
  }
  return result;
}

export interface ChildPayment {
  id: string;
  receiptNumber: string;
  paidOn: string;
  amountPesewas: number;
  method: PaymentMethod;
  voided: boolean;
}

export interface ParentChildDetail {
  school: ParentSchoolRef;
  summary: ChildSummary;
  admissionNumber: string;
  account: StudentAccount;
  plan: PaymentPlan | null;
  /** Newest first. */
  payments: ChildPayment[];
  /** Published report cards, newest term first. */
  reportCards: { id: string; termName: string; yearName: string; publishedAt: Date }[];
}

/** One child's account, plan and receipts, or null when the number does not reach the child. */
export async function getParentChild(
  database: Database,
  phone: string,
  slug: string,
  studentId: string,
): Promise<ParentChildDetail | null> {
  if (!z.string().uuid().safeParse(studentId).success) return null;
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  return withTenant(database, parentScope(school.id), async (tx) => {
    const [student] = await linkedStudents(tx, school.id, phone, studentId);
    if (!student) return null;
    const today = todayIn(school.timezone);
    const childPayments = await tx
      .select({
        id: payments.id,
        receiptNumber: payments.receiptNumber,
        paidOn: payments.paidOn,
        amountPesewas: payments.amountPesewas,
        method: payments.method,
        voided: sql<boolean>`${paymentVoids.paymentId} is not null`,
      })
      .from(payments)
      .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
      .where(and(eq(payments.tenantId, school.id), eq(payments.studentId, student.id)))
      .orderBy(desc(payments.paidOn), desc(payments.recordedAt));
    return {
      school,
      summary: await readChildSummary(tx, school.id, student, today),
      admissionNumber: student.admissionNumber,
      account: await readStudentAccount(tx, school.id, student),
      plan: await readPaymentPlan(tx, school.id, student.id, today),
      payments: childPayments,
      reportCards: await readPublishedReportCards(tx, school.id, student.id),
    };
  });
}

/** A receipt for one of the parent's children, or null. */
export async function getParentReceipt(
  database: Database,
  phone: string,
  slug: string,
  paymentId: string,
): Promise<{ receipt: Receipt; school: ParentSchoolRef } | null> {
  if (!z.string().uuid().safeParse(paymentId).success) return null;
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  return withTenant(database, parentScope(school.id), async (tx) => {
    const receipt = await readReceipt(tx, school.id, paymentId);
    if (!receipt) return null;
    const [linked] = await linkedStudents(tx, school.id, phone, receipt.student.id);
    return linked ? { receipt, school } : null;
  });
}

/** A published report card of one of the parent's children, or null. */
export async function getParentReportCard(
  database: Database,
  phone: string,
  slug: string,
  studentId: string,
  reportCardId: string,
): Promise<ReportCardSnapshot | null> {
  if (!z.string().uuid().safeParse(studentId).success) return null;
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  return withTenant(database, parentScope(school.id), async (tx) => {
    const [linked] = await linkedStudents(tx, school.id, phone, studentId);
    if (!linked) return null;
    return readPublishedSnapshot(tx, school.id, linked.id, reportCardId);
  });
}
