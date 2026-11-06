import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { formatScore, parseScore, type AssessmentComponent, type GradeBand } from "../../lib/assessment";
import { recordAudit } from "../audit/record";
import { assertCan, can } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { assessmentScores, enrolments, reportCards } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import {
  listAssessableClasses,
  loadAssessableClass,
  loadTerm,
  type AssessableClass,
  type TermRef,
} from "./access";
import { classStudents, loadClassTermData } from "./class-data";
import { ensureScheme, readLevelSubjects, readScheme } from "./setup";

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

export interface ClassProgress {
  cls: AssessableClass;
  students: number;
  subjects: number;
  /** Subject sheets where every student has every part scored. */
  completeSheets: number;
  published: number;
}

/** The classes this member can assess in a term, with how far scores and report cards have got. */
export async function listAssessmentClasses(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<{ term: TermRef; classes: ClassProgress[] } | null> {
  assertCan(ctx.roles, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    if (!term) return null;
    const list = await listAssessableClasses(tx, ctx);
    const classes: ClassProgress[] = [];
    for (const cls of list) {
      const enrolled = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(enrolments)
        .where(
          and(
            eq(enrolments.tenantId, ctx.tenant.id),
            eq(enrolments.termId, term.id),
            eq(enrolments.classId, cls.id),
          ),
        );
      const count = enrolled[0]?.n ?? 0;
      // Archived classes only appear when they have students this term.
      if (cls.status === "archived" && count === 0) continue;
      const data = await loadClassTermData(tx, ctx.tenant.id, term, cls);
      const completeSheets = data.subjects.filter(
        (subject) =>
          data.students.length > 0 &&
          data.students.every((s) =>
            data.components.every((c) => data.scores.get(s.id)?.get(subject.id)?.[c.key] !== undefined),
          ),
      ).length;
      classes.push({
        cls,
        students: data.students.length,
        subjects: data.subjects.length,
        completeSheets,
        published: [...data.cards.values()].filter((c) => c.status === "published").length,
      });
    }
    return { term, classes };
  });
}

export interface ScoreSheet {
  term: TermRef;
  cls: AssessableClass;
  subject: { id: string; name: string };
  components: AssessmentComponent[];
  bands: GradeBand[];
  students: {
    id: string;
    name: string;
    admissionNumber: string;
    /** Entered marks as text ("37.5"), "" when empty; keyed by component. */
    scores: Record<string, string>;
    /** Report card published: marks are locked. */
    locked: boolean;
  }[];
}

/** One subject's marks for a class in a term, for the score sheet. */
export async function getScoreSheet(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  subjectId: string,
): Promise<ScoreSheet | null> {
  assertCan(ctx.roles, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    const cls = await loadAssessableClass(tx, ctx, classId);
    if (!term || !cls) return null;
    const subject = (await readLevelSubjects(tx, ctx.tenant.id, cls.levelId)).find((s) => s.id === subjectId);
    if (!subject) return null;
    const data = await loadClassTermData(tx, ctx.tenant.id, term, cls);
    return {
      term,
      cls,
      subject,
      components: data.components,
      bands: data.bands,
      students: data.students.map((s) => {
        const entered = data.scores.get(s.id)?.get(subject.id) ?? {};
        return {
          id: s.id,
          name: s.name,
          admissionNumber: s.admissionNumber,
          scores: Object.fromEntries(
            data.components.map((c) => [
              c.key,
              entered[c.key] === undefined ? "" : formatScore(entered[c.key]!),
            ]),
          ),
          locked: data.cards.get(s.id)?.status === "published",
        };
      }),
    };
  });
}

const cellSchema = z.object({
  studentId: z.string().uuid(),
  key: z.string().min(1).max(20),
  /** What the sheet showed when it was opened. */
  original: z.string().max(10),
  value: z.string().max(10),
});

export interface SaveScoresResult {
  saved: number;
  /** Marks someone else changed since the sheet was opened; left as they are. */
  conflicts: number;
  /** Marks on report cards published since the sheet was opened; left as they are. */
  locked: number;
}

/**
 * Saves the marks that changed on a score sheet. Each change applies only if the mark is still what the
 * sheet showed when it was opened, so two people entering the same sheet never silently overwrite each other.
 * Every change is audited (old and new mark).
 */
export async function saveScores(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  subjectId: string,
  input: unknown,
): Promise<SaveScoresResult> {
  assertCan(ctx.roles, "assessment.enter");
  const { cells } = z.object({ cells: z.array(cellSchema).max(2000) }).parse(input);
  const changed = cells.filter((c) => c.value.trim() !== c.original.trim());
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    const cls = await loadAssessableClass(tx, ctx, classId);
    if (!term || !cls) throw new DomainError("class_not_found", "Class not found.");
    const subject = (await readLevelSubjects(tx, ctx.tenant.id, cls.levelId)).find((s) => s.id === subjectId);
    if (!subject) throw new DomainError("subject_not_found", "This class does not take that subject.");
    if (changed.length === 0) return { saved: 0, conflicts: 0, locked: 0 };

    const scheme = (await readScheme(tx, ctx.tenant.id, term.id)).components;
    const byKey = new Map(scheme.map((c) => [c.key, c]));
    const fieldErrors: string[] = [];
    const parsed = changed.map((cell) => {
      const component = byKey.get(cell.key);
      if (!component)
        throw new DomainError("scheme_changed", "How this term is assessed has changed. Reload the sheet.");
      const tenths = parseScore(cell.value);
      if (tenths !== null && (Number.isNaN(tenths) || tenths > component.outOf * 10))
        fieldErrors.push(`${cell.studentId}:${cell.key}`);
      return { ...cell, tenths, originalTenths: parseScore(cell.original) };
    });
    if (fieldErrors.length)
      throw new DomainError(
        "score_invalid",
        `${fieldErrors.length === 1 ? "One mark is" : `${fieldErrors.length} marks are`} not valid. Enter a number up to the part's maximum, with at most one decimal place.`,
        fieldErrors[0],
      );

    const roster = new Set((await classStudents(tx, ctx.tenant.id, term.id, cls.id)).map((s) => s.id));
    if (parsed.some((p) => !roster.has(p.studentId)))
      throw new DomainError("roster_changed", "The class list has changed. Reload the sheet.");
    await ensureScheme(tx, ctx, term.id);

    const studentIds = [...new Set(parsed.map((p) => p.studentId))];
    const published = new Set(
      (
        await tx
          .select({ studentId: reportCards.studentId })
          .from(reportCards)
          .where(
            and(
              eq(reportCards.tenantId, ctx.tenant.id),
              eq(reportCards.termId, term.id),
              eq(reportCards.status, "published"),
              inArray(reportCards.studentId, studentIds),
            ),
          )
      ).map((r) => r.studentId),
    );
    const current = await tx
      .select({
        id: assessmentScores.id,
        studentId: assessmentScores.studentId,
        key: assessmentScores.componentKey,
        tenths: assessmentScores.scoreTenths,
      })
      .from(assessmentScores)
      .where(
        and(
          eq(assessmentScores.tenantId, ctx.tenant.id),
          eq(assessmentScores.termId, term.id),
          eq(assessmentScores.subjectId, subject.id),
          inArray(assessmentScores.studentId, studentIds),
        ),
      )
      .for("update");
    const currentOf = new Map(current.map((c) => [`${c.studentId}:${c.key}`, c]));

    const result: SaveScoresResult = { saved: 0, conflicts: 0, locked: 0 };
    const audit: { studentId: string; part: string; from: number | null; to: number | null }[] = [];
    for (const cell of parsed) {
      if (published.has(cell.studentId)) {
        result.locked++;
        continue;
      }
      const existing = currentOf.get(`${cell.studentId}:${cell.key}`);
      const now = existing?.tenths ?? null;
      if (now !== cell.originalTenths) {
        result.conflicts++;
        continue;
      }
      if (cell.tenths === now) continue;
      if (cell.tenths === null) {
        await tx.delete(assessmentScores).where(eq(assessmentScores.id, existing!.id));
      } else if (existing) {
        await tx
          .update(assessmentScores)
          .set({ scoreTenths: cell.tenths, enteredByUserId: ctx.userId, updatedAt: new Date() })
          .where(eq(assessmentScores.id, existing.id));
      } else {
        await tx.insert(assessmentScores).values({
          tenantId: ctx.tenant.id,
          termId: term.id,
          studentId: cell.studentId,
          subjectId: subject.id,
          componentKey: cell.key,
          scoreTenths: cell.tenths,
          enteredByUserId: ctx.userId,
        });
      }
      audit.push({ studentId: cell.studentId, part: cell.key, from: now, to: cell.tenths });
      result.saved++;
    }
    if (audit.length)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "assessment.scores_saved",
        entityType: "class",
        entityId: cls.id,
        metadata: { term: term.name, class: cls.name, subject: subject.name, marks: audit },
      });
    return result;
  });
}

/** Whether this member may publish and write the head teacher's remark. */
export function canPublish(ctx: TenantContext): boolean {
  return can(ctx.roles, "reports.publish");
}
