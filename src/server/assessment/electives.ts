import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { classes, levelSubjects, studentSubjectChoices } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { classStudents, readSubjectChoices } from "./class-data";
import { readLevelSubjects } from "./setup";

/**
 * Elective subjects (2026-11-18): a level's subject can be an elective, taken only by the students chosen for it (SHS
 * programmes: Science, Business, General Arts...). Score sheets list only its takers; report cards, totals, averages
 * and positions count only the subjects each student takes.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** Makes a level's subject an elective, or a subject the whole level takes again. */
export async function setSubjectElective(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const data = z
    .object({ levelId: z.string().uuid(), subjectId: z.string().uuid(), elective: z.boolean() })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .update(levelSubjects)
      .set({ elective: data.elective })
      .where(
        and(
          eq(levelSubjects.tenantId, ctx.tenant.id),
          eq(levelSubjects.levelId, data.levelId),
          eq(levelSubjects.subjectId, data.subjectId),
        ),
      )
      .returning({ levelId: levelSubjects.levelId });
    if (!row) throw new DomainError("subject_not_found", "This level does not take that subject.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: data.elective ? "subject.made_elective" : "subject.made_core",
      entityType: "subject",
      entityId: data.subjectId,
      metadata: { levelId: data.levelId },
    });
  });
}

export interface ElectiveTakers {
  subject: { id: string; name: string };
  students: { id: string; name: string; admissionNumber: string; takes: boolean }[];
}

/** A class's students for a term, with whether each takes an elective subject. Null when it is not an elective there. */
export async function getElectiveTakers(
  database: Database,
  ctx: TenantContext,
  termId: string,
  classId: string,
  subjectId: string,
): Promise<ElectiveTakers | null> {
  assertAllowed(ctx, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const found = await electiveIn(tx, ctx.tenant.id, classId, subjectId);
    if (!found) return null;
    const roster = await classStudents(tx, ctx.tenant.id, termId, classId);
    const choices = await readSubjectChoices(
      tx,
      ctx.tenant.id,
      roster.map((s) => s.id),
      [subjectId],
    );
    return {
      subject: found,
      students: roster.map((s) => ({
        id: s.id,
        name: s.name,
        admissionNumber: s.admissionNumber,
        takes: choices.get(s.id)?.has(subjectId) ?? false,
      })),
    };
  });
}

async function electiveIn(
  tx: Transaction,
  tenantId: string,
  classId: string,
  subjectId: string,
): Promise<{ id: string; name: string } | null> {
  if (!z.string().uuid().safeParse(classId).success || !z.string().uuid().safeParse(subjectId).success)
    return null;
  const [cls] = await tx
    .select({ levelId: classes.levelId })
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), eq(classes.id, classId)));
  if (!cls) return null;
  const subject = (await readLevelSubjects(tx, tenantId, cls.levelId)).find((s) => s.id === subjectId);
  return subject?.elective ? { id: subject.id, name: subject.name } : null;
}

/**
 * Chooses which of a class's students take an elective: those listed take it, the class's other students do not.
 * Students in other classes keep their choices. Marks already entered stay saved, and count again if a student takes
 * the subject again.
 */
export async function setElectiveTakers(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ takers: number }> {
  assertAllowed(ctx, "academics.manage");
  const data = z
    .object({
      termId: z.string().uuid(),
      classId: z.string().uuid(),
      subjectId: z.string().uuid(),
      studentIds: z.array(z.string().uuid()).max(500),
    })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const subject = await electiveIn(tx, ctx.tenant.id, data.classId, data.subjectId);
    if (!subject) throw new DomainError("not_elective", "That subject is not an elective for this class.");
    const roster = (await classStudents(tx, ctx.tenant.id, data.termId, data.classId)).map((s) => s.id);
    const want = new Set(data.studentIds);
    if ([...want].some((id) => !roster.includes(id)))
      throw new DomainError("roster_changed", "The class list has changed. Reload the page.");
    if (roster.length)
      await tx
        .delete(studentSubjectChoices)
        .where(
          and(
            eq(studentSubjectChoices.tenantId, ctx.tenant.id),
            eq(studentSubjectChoices.subjectId, data.subjectId),
            inArray(studentSubjectChoices.studentId, roster),
          ),
        );
    if (want.size)
      await tx
        .insert(studentSubjectChoices)
        .values(
          [...want].map((studentId) => ({ tenantId: ctx.tenant.id, studentId, subjectId: data.subjectId })),
        );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subject.takers_set",
      entityType: "subject",
      entityId: data.subjectId,
      metadata: { classId: data.classId, takers: want.size },
    });
    return { takers: want.size };
  });
}
