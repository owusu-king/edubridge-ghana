import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ReportCardSnapshot, StudentResult } from "../../lib/assessment";
import { todayIn } from "../../lib/format";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { academicYears, enrolments, reportCards, terms, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { loadAssessableClass, loadTerm, type AssessableClass, type TermRef } from "./access";
import { buildSnapshot, loadClassTermData, termContext, type ClassTermData } from "./class-data";

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface ClassOverview {
  term: TermRef;
  cls: AssessableClass;
  subjects: { id: string; name: string; complete: number; entered: number }[];
  students: {
    id: string;
    name: string;
    admissionNumber: string;
    result: Omit<StudentResult, "subjects" | "studentId">;
    status: "none" | "draft" | "published";
    hasClassTeacherRemark: boolean;
    hasHeadTeacherRemark: boolean;
  }[];
  showPositions: boolean;
  componentsLabel: string;
}

async function loadClass(tx: Transaction, ctx: TenantContext, termId: string, classId: string) {
  const term = await loadTerm(tx, ctx.tenant.id, termId);
  const cls = await loadAssessableClass(tx, ctx, classId);
  if (!term || !cls) return null;
  return loadClassTermData(tx, ctx.tenant.id, term, cls);
}

/** A class in a term: how complete each subject is, and each student's results and report-card status. */
export async function getClassOverview(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
): Promise<ClassOverview | null> {
  assertAllowed(ctx, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const data = await loadClass(tx, ctx, termId, classId);
    if (!data) return null;
    return {
      term: data.term,
      cls: data.cls,
      showPositions: data.showPositions,
      componentsLabel: data.components.map((c) => `${c.name} ${c.weight}%`).join(" · "),
      subjects: data.subjects.map((subject) => {
        const counts = data.students.map(
          (s) =>
            data.components.filter((c) => data.scores.get(s.id)?.get(subject.id)?.[c.key] !== undefined)
              .length,
        );
        return {
          ...subject,
          complete: counts.filter((n) => n === data.components.length).length,
          entered: counts.filter((n) => n > 0).length,
        };
      }),
      students: data.students.map((s) => {
        const { subjects: _subjects, studentId: _id, ...result } = data.results.get(s.id)!;
        const card = data.cards.get(s.id);
        return {
          id: s.id,
          name: s.name,
          admissionNumber: s.admissionNumber,
          result,
          status: card?.status ?? "none",
          hasClassTeacherRemark: Boolean(card?.classTeacherRemark),
          hasHeadTeacherRemark: Boolean(card?.headTeacherRemark),
        };
      }),
    };
  });
}

export interface ReportCardView {
  term: TermRef;
  cls: AssessableClass;
  studentId: string;
  status: "draft" | "published";
  /** Frozen when published; worked out live for drafts. */
  snapshot: ReportCardSnapshot;
  remarks: {
    attitude: string;
    conduct: string;
    interest: string;
    classTeacherRemark: string;
    headTeacherRemark: string;
    daysPresent: string;
    daysOpen: string;
  };
  publishedAt: Date | null;
  canPublish: boolean;
  /** Attendance from this term's registers (null before any register). */
  registers: { present: number; open: number } | null;
}

async function snapshotExtras(tx: Transaction, ctx: TenantContext, data: ClassTermData) {
  const { yearName, nextTermBeginsOn } = await termContext(tx, ctx.tenant.id, data.term);
  return { schoolName: ctx.tenant.name, yearName, nextTermBeginsOn };
}

/** One student's report card in a class the member can assess. */
export async function getReportCard(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  studentId: string,
): Promise<ReportCardView | null> {
  assertAllowed(ctx, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const data = await loadClass(tx, ctx, termId, classId);
    const student = data?.students.find((s) => s.id === studentId);
    if (!data || !student) return null;
    const card = data.cards.get(student.id);
    const published = card?.status === "published" && card.snapshot;
    const snapshot = published
      ? card.snapshot!
      : buildSnapshot(data, student, {
          ...(await snapshotExtras(tx, ctx, data)),
          approvedBy: null,
          approvedOn: null,
        });
    return {
      term: data.term,
      cls: data.cls,
      studentId: student.id,
      status: published ? "published" : "draft",
      snapshot,
      remarks: {
        attitude: card?.attitude ?? "",
        conduct: card?.conduct ?? "",
        interest: card?.interest ?? "",
        classTeacherRemark: card?.classTeacherRemark ?? "",
        headTeacherRemark: card?.headTeacherRemark ?? "",
        daysPresent: card?.daysPresent?.toString() ?? "",
        daysOpen: card?.daysOpen?.toString() ?? "",
      },
      publishedAt: card?.publishedAt ?? null,
      registers: (() => {
        const t = data.attendance.get(student.id);
        return t && t.open > 0 ? { present: t.present + t.late, open: t.open } : null;
      })(),
      canPublish: allowed(ctx, "reports.publish"),
    };
  });
}

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer for ${label}.`)
    .transform((v) => (v ? v : null));
const optionalDays = z
  .string()
  .trim()
  .regex(/^\d{0,3}$/, "Enter a number of days.")
  .transform((v) => (v ? Number(v) : null));

const remarksSchema = z
  .object({
    attitude: optionalText(60, "attitude"),
    conduct: optionalText(60, "conduct"),
    interest: optionalText(60, "interest"),
    classTeacherRemark: optionalText(500, "the remark"),
    headTeacherRemark: optionalText(500, "the remark").optional(),
    daysPresent: optionalDays,
    daysOpen: optionalDays,
  })
  .superRefine((v, issue) => {
    if (v.daysOpen !== null && v.daysOpen > 366)
      issue.addIssue({ code: "custom", message: "Enter at most 366 days.", path: ["daysOpen"] });
    if (v.daysPresent !== null && v.daysOpen !== null && v.daysPresent > v.daysOpen)
      issue.addIssue({
        code: "custom",
        message: "Days present cannot be more than days open.",
        path: ["daysPresent"],
      });
  });

/**
 * Saves the remarks on a draft report card. The class teacher (or academic staff) writes attitude, conduct,
 * interest, attendance and their remark; only those who publish write the head teacher's remark.
 */
export async function saveReportRemarks(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  studentId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "assessment.enter");
  const data = remarksSchema.parse(input);
  const head = allowed(ctx, "reports.publish");
  await withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    const cls = await loadAssessableClass(tx, ctx, classId);
    if (!term || !cls) throw new DomainError("class_not_found", "Class not found.");
    const [enrolled] = await tx
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.termId, term.id),
          eq(enrolments.classId, cls.id),
          eq(enrolments.studentId, studentId),
        ),
      );
    if (!enrolled) throw new DomainError("student_not_found", "Student not found in this class.");
    const [card] = await tx
      .select()
      .from(reportCards)
      .where(
        and(
          eq(reportCards.tenantId, ctx.tenant.id),
          eq(reportCards.termId, term.id),
          eq(reportCards.studentId, studentId),
        ),
      )
      .for("update");
    if (card?.status === "published")
      throw new DomainError(
        "report_published",
        "This report card is published. Withdraw it to make changes.",
      );
    const values = {
      attitude: data.attitude,
      conduct: data.conduct,
      interest: data.interest,
      classTeacherRemark: data.classTeacherRemark,
      daysPresent: data.daysPresent,
      daysOpen: data.daysOpen,
      ...(head && data.headTeacherRemark !== undefined ? { headTeacherRemark: data.headTeacherRemark } : {}),
      updatedByUserId: ctx.userId,
      updatedAt: new Date(),
    };
    if (card) await tx.update(reportCards).set(values).where(eq(reportCards.id, card.id));
    else
      await tx.insert(reportCards).values({ tenantId: ctx.tenant.id, termId: term.id, studentId, ...values });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "report_card.remarks_saved",
      entityType: "student",
      entityId: studentId,
      metadata: { term: term.name, class: cls.name },
    });
  });
}

/**
 * Publishes report cards (the head teacher's approval): each one's results, remarks, grade bands and positions
 * are frozen as they are now, the student's marks lock, and families see it in the parent view. Students
 * missing marks are published with those subjects "Not graded"; the screen warns before this.
 */
export async function publishReportCards(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  input: unknown = {},
): Promise<number> {
  assertAllowed(ctx, "reports.publish");
  const { studentIds } = z
    .object({ studentIds: z.array(z.string().uuid()).max(500).optional() })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const data = await loadClass(tx, ctx, termId, classId);
    if (!data) throw new DomainError("class_not_found", "Class not found.");
    const extras = await snapshotExtras(tx, ctx, data);
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId));
    const approvedOn = todayIn(ctx.tenant.timezone);
    const targets = data.students.filter(
      (s) => (!studentIds || studentIds.includes(s.id)) && data.cards.get(s.id)?.status !== "published",
    );
    const now = new Date();
    for (const student of targets) {
      const snapshot = buildSnapshot(data, student, { ...extras, approvedBy: me?.name ?? null, approvedOn });
      const card = data.cards.get(student.id);
      const values = {
        status: "published" as const,
        snapshot,
        publishedAt: now,
        publishedByUserId: ctx.userId,
        updatedAt: now,
      };
      if (card) await tx.update(reportCards).set(values).where(eq(reportCards.id, card.id));
      else
        await tx
          .insert(reportCards)
          .values({ tenantId: ctx.tenant.id, termId: data.term.id, studentId: student.id, ...values });
    }
    if (targets.length)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "report_cards.published",
        entityType: "class",
        entityId: data.cls.id,
        metadata: { term: data.term.name, class: data.cls.name, count: targets.length },
      });
    return targets.length;
  });
}

/** Takes a published report card back to draft (e.g. to correct a mark), with the reason audited. */
export async function withdrawReportCard(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  studentId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "reports.publish");
  const { reason } = z
    .object({
      reason: z
        .string()
        .trim()
        .min(3, "Say why it is being withdrawn.")
        .max(300, "Use 300 characters or fewer."),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    const cls = await loadAssessableClass(tx, ctx, classId);
    if (!term || !cls) throw new DomainError("class_not_found", "Class not found.");
    if (!z.string().uuid().safeParse(studentId).success)
      throw new DomainError("report_not_found", "Report card not found.");
    const [card] = await tx
      .select()
      .from(reportCards)
      .where(
        and(
          eq(reportCards.tenantId, ctx.tenant.id),
          eq(reportCards.termId, term.id),
          eq(reportCards.studentId, studentId),
        ),
      )
      .for("update");
    if (!card || card.status !== "published")
      throw new DomainError("report_not_published", "This report card is not published.");
    await tx
      .update(reportCards)
      .set({
        status: "draft",
        snapshot: null,
        publishedAt: null,
        publishedByUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(reportCards.id, card.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "report_card.withdrawn",
      entityType: "student",
      entityId: studentId,
      metadata: { term: term.name, class: cls.name, reason },
    });
  });
}

/** Published report cards for one student, newest term first (used by the parent view). */
export async function readPublishedReportCards(
  tx: Transaction,
  tenantId: string,
  studentId: string,
): Promise<{ id: string; termName: string; yearName: string; publishedAt: Date }[]> {
  const rows = await tx
    .select({
      id: reportCards.id,
      termName: terms.name,
      yearName: academicYears.name,
      publishedAt: reportCards.publishedAt,
    })
    .from(reportCards)
    .innerJoin(terms, eq(terms.id, reportCards.termId))
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(
      and(
        eq(reportCards.tenantId, tenantId),
        eq(reportCards.studentId, studentId),
        eq(reportCards.status, "published"),
      ),
    )
    .orderBy(desc(terms.startsOn));
  return rows.map((r) => ({ ...r, publishedAt: r.publishedAt! }));
}

/** One published report card's frozen contents, for a student. */
export async function readPublishedSnapshot(
  tx: Transaction,
  tenantId: string,
  studentId: string,
  reportCardId: string,
): Promise<ReportCardSnapshot | null> {
  if (!z.string().uuid().safeParse(reportCardId).success) return null;
  const [row] = await tx
    .select({ snapshot: reportCards.snapshot })
    .from(reportCards)
    .where(
      and(
        eq(reportCards.tenantId, tenantId),
        eq(reportCards.studentId, studentId),
        eq(reportCards.id, reportCardId),
        eq(reportCards.status, "published"),
      ),
    );
  return row?.snapshot ?? null;
}
