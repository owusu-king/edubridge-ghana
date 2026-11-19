import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { reportCards, subjectComments } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { loadTerm, type AssessableClass, type TermRef } from "./access";
import { classStudents } from "./class-data";
import { readLevelSubjects } from "./setup";
import { loadScoreSheetClass } from "./teaching";

/**
 * Subject comments: the subject teacher's few words on each student's subject for the term, printed on
 * report cards (the Cambridge, IB and American layouts give them a line each). Written by whoever enters
 * that subject's marks in the class. Like marks, a comment saves only if it is still what the screen showed
 * (two people never silently overwrite each other), and it is locked while the report card is published.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export const COMMENT_MAX = 400;

export interface SubjectCommentsView {
  term: TermRef;
  cls: AssessableClass;
  subject: { id: string; name: string };
  students: { id: string; name: string; admissionNumber: string; comment: string; locked: boolean }[];
}

export async function getSubjectComments(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  subjectId: string,
): Promise<SubjectCommentsView | null> {
  assertAllowed(ctx, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    const cls = await loadScoreSheetClass(tx, ctx, classId, subjectId);
    if (!term || !cls) return null;
    const subject = (await readLevelSubjects(tx, ctx.tenant.id, cls.levelId)).find((s) => s.id === subjectId);
    if (!subject) return null;
    const roster = await classStudents(tx, ctx.tenant.id, term.id, cls.id);
    const ids = roster.map((s) => s.id);
    const rows = ids.length
      ? await tx
          .select({ studentId: subjectComments.studentId, comment: subjectComments.comment })
          .from(subjectComments)
          .where(
            and(
              eq(subjectComments.tenantId, ctx.tenant.id),
              eq(subjectComments.termId, term.id),
              eq(subjectComments.subjectId, subject.id),
              inArray(subjectComments.studentId, ids),
            ),
          )
      : [];
    const published = ids.length
      ? await tx
          .select({ studentId: reportCards.studentId })
          .from(reportCards)
          .where(
            and(
              eq(reportCards.tenantId, ctx.tenant.id),
              eq(reportCards.termId, term.id),
              eq(reportCards.status, "published"),
              inArray(reportCards.studentId, ids),
            ),
          )
      : [];
    const comments = new Map(rows.map((r) => [r.studentId, r.comment]));
    const locked = new Set(published.map((p) => p.studentId));
    return {
      term,
      cls,
      subject,
      students: roster.map((s) => ({
        id: s.id,
        name: s.name,
        admissionNumber: s.admissionNumber,
        comment: comments.get(s.id) ?? "",
        locked: locked.has(s.id),
      })),
    };
  });
}

const saveSchema = z.object({
  comments: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        /** What the screen showed before the change. */
        original: z.string().max(COMMENT_MAX * 2),
        value: z.string().max(COMMENT_MAX * 2),
      }),
    )
    .min(1)
    .max(300),
});

export interface SaveCommentsResult {
  saved: number;
  /** Students whose comment someone else changed since the screen was opened (nothing saved for them). */
  conflicts: string[];
  /** Students whose report card is published (withdraw it to change the comment). */
  locked: string[];
}

const clean = (v: string) => v.replace(/\s+/g, " ").trim();

/** Saves changed comments; an empty comment removes it. */
export async function saveSubjectComments(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  subjectId: string,
  input: unknown,
): Promise<SaveCommentsResult> {
  assertAllowed(ctx, "assessment.enter");
  const data = saveSchema.parse(input);
  for (const c of data.comments)
    if (clean(c.value).length > COMMENT_MAX)
      throw new DomainError("comment_too_long", `Keep each comment to ${COMMENT_MAX} characters or fewer.`);
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    const cls = await loadScoreSheetClass(tx, ctx, classId, subjectId);
    if (!term || !cls) throw new DomainError("class_not_found", "Class not found.");
    const subject = (await readLevelSubjects(tx, ctx.tenant.id, cls.levelId)).find((s) => s.id === subjectId);
    if (!subject) throw new DomainError("subject_not_found", "Subject not found.");
    const roster = new Map((await classStudents(tx, ctx.tenant.id, term.id, cls.id)).map((s) => [s.id, s]));
    const ids = data.comments.map((c) => c.studentId).filter((id) => roster.has(id));
    const current = ids.length
      ? await tx
          .select({
            id: subjectComments.id,
            studentId: subjectComments.studentId,
            comment: subjectComments.comment,
          })
          .from(subjectComments)
          .where(
            and(
              eq(subjectComments.tenantId, ctx.tenant.id),
              eq(subjectComments.termId, term.id),
              eq(subjectComments.subjectId, subject.id),
              inArray(subjectComments.studentId, ids),
            ),
          )
          .for("update")
      : [];
    const published = new Set(
      (ids.length
        ? await tx
            .select({ studentId: reportCards.studentId })
            .from(reportCards)
            .where(
              and(
                eq(reportCards.tenantId, ctx.tenant.id),
                eq(reportCards.termId, term.id),
                eq(reportCards.status, "published"),
                inArray(reportCards.studentId, ids),
              ),
            )
        : []
      ).map((r) => r.studentId),
    );
    const byStudent = new Map(current.map((c) => [c.studentId, c]));
    const result: SaveCommentsResult = { saved: 0, conflicts: [], locked: [] };
    const now = new Date();
    for (const change of data.comments) {
      const student = roster.get(change.studentId);
      if (!student) continue;
      const value = clean(change.value);
      const existing = byStudent.get(student.id);
      if ((existing?.comment ?? "") === value) continue;
      if ((existing?.comment ?? "") !== clean(change.original)) {
        result.conflicts.push(student.name);
        continue;
      }
      if (published.has(student.id)) {
        result.locked.push(student.name);
        continue;
      }
      if (!value) {
        await tx.delete(subjectComments).where(eq(subjectComments.id, existing!.id));
      } else if (existing) {
        await tx
          .update(subjectComments)
          .set({ comment: value, updatedByUserId: ctx.userId, updatedAt: now })
          .where(eq(subjectComments.id, existing.id));
      } else {
        await tx.insert(subjectComments).values({
          tenantId: ctx.tenant.id,
          termId: term.id,
          studentId: student.id,
          subjectId: subject.id,
          comment: value,
          updatedByUserId: ctx.userId,
        });
      }
      result.saved++;
    }
    if (result.saved)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "assessment.comments_saved",
        entityType: "class",
        entityId: cls.id,
        metadata: { term: term.name, class: cls.name, subject: subject.name, comments: result.saved },
      });
    return result;
  });
}
