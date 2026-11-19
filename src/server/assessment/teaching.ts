import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  campuses,
  classes,
  levels,
  levelSubjects,
  memberships,
  subjectTeachers,
  subjects,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";
import { listAssessableClasses, seesAllClasses, type AssessableClass } from "./access";
import { readLevelSubjects } from "./setup";

/**
 * Who enters marks, by the school's teaching model (configurable per school):
 *
 * - "class": the class teacher enters every subject's marks for their class (and academic leads, any class).
 * - "subject": each subject in a class can have a subject teacher, who enters that subject's marks there;
 *   one teacher can teach the same subject in many classes. The class teacher keeps the register, remarks
 *   and report cards, and enters any subject that has no subject teacher.
 *
 * Teachers and subjects are never duplicated: an assignment links an existing staff member to an existing
 * subject in an existing class. Registers, remarks and report cards follow the class teacher in both
 * models (src/server/assessment/access.ts).
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export type TeachingModel = "class" | "subject";

export async function readTeachingModel(tx: Transaction, tenantId: string): Promise<TeachingModel> {
  return (await readPreferences(tx, tenantId)).teachingModel;
}

async function myMembership(tx: Transaction, ctx: TenantContext): Promise<string | null> {
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
  return row?.id ?? null;
}

/** A class whose score sheets the member may open, and which subjects (all of the class's, or some). */
export interface SheetAccess {
  cls: AssessableClass;
  /** Subject ids this member enters marks for in the class. */
  subjectIds: string[];
  /** Class teacher or academic lead: may open the class overview, remarks and report cards. */
  wholeClass: boolean;
}

/**
 * The score sheets this member may open in each class. Academic leads and (in the class model) class
 * teachers: every subject of their classes. In the subject model: their assigned subjects, plus, as class
 * teacher, the subjects of their class nobody else teaches.
 */
export async function listScoreSheetAccess(tx: Transaction, ctx: TenantContext): Promise<SheetAccess[]> {
  if (!allowed(ctx, "assessment.enter")) return [];
  const homeroom = await listAssessableClasses(tx, ctx, "assessment.enter");
  const subjectsOf = async (cls: { levelId: string }) =>
    (await readLevelSubjects(tx, ctx.tenant.id, cls.levelId)).map((s) => s.id);
  const model = await readTeachingModel(tx, ctx.tenant.id);
  if (seesAllClasses(ctx) || model === "class") {
    const result: SheetAccess[] = [];
    for (const cls of homeroom) result.push({ cls, subjectIds: await subjectsOf(cls), wholeClass: true });
    return result;
  }

  const me = await myMembership(tx, ctx);
  const homeroomIds = homeroom.map((c) => c.id);
  // Every assignment in the member's own classes (to leave out subjects others teach) and the member's own.
  const assignments = await tx
    .select({
      classId: subjectTeachers.classId,
      subjectId: subjectTeachers.subjectId,
      membershipId: subjectTeachers.membershipId,
    })
    .from(subjectTeachers)
    .where(eq(subjectTeachers.tenantId, ctx.tenant.id));
  const mine = assignments.filter((a) => a.membershipId === me);
  const result: SheetAccess[] = [];
  for (const cls of homeroom) {
    const takenByOthers = new Set(
      assignments.filter((a) => a.classId === cls.id && a.membershipId !== me).map((a) => a.subjectId),
    );
    result.push({
      cls,
      subjectIds: (await subjectsOf(cls)).filter((id) => !takenByOthers.has(id)),
      wholeClass: true,
    });
  }
  const otherClassIds = [...new Set(mine.map((a) => a.classId))].filter((id) => !homeroomIds.includes(id));
  if (otherClassIds.length) {
    const rows = await listAssessableClassesById(tx, ctx, otherClassIds);
    for (const cls of rows) {
      const levelSubjectIds = new Set(await subjectsOf(cls));
      result.push({
        cls,
        subjectIds: mine
          .filter((a) => a.classId === cls.id && levelSubjectIds.has(a.subjectId))
          .map((a) => a.subjectId),
        wholeClass: false,
      });
    }
  }
  return result;
}

/** Classes by id, within the member's campuses (for subject teachers, who are not their class teacher). */
async function listAssessableClassesById(
  tx: Transaction,
  ctx: TenantContext,
  ids: string[],
): Promise<AssessableClass[]> {
  const conditions = [eq(classes.tenantId, ctx.tenant.id), inArray(classes.id, ids)];
  if (ctx.campusIds !== null)
    conditions.push(
      inArray(
        classes.campusId,
        ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"],
      ),
    );
  const teacher = users;
  return tx
    .select({
      id: classes.id,
      name: classes.name,
      levelId: classes.levelId,
      levelName: levels.name,
      stage: levels.stage,
      campusName: campuses.name,
      status: classes.status,
      classTeacherName: teacher.name,
    })
    .from(classes)
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .innerJoin(campuses, eq(campuses.id, classes.campusId))
    .leftJoin(memberships, eq(memberships.id, classes.classTeacherMembershipId))
    .leftJoin(teacher, eq(teacher.id, memberships.userId))
    .where(and(...conditions))
    .orderBy(asc(levels.sequence), asc(classes.name));
}

/** The class, when this member may open its score sheet for this subject; otherwise null. */
export async function loadScoreSheetClass(
  tx: Transaction,
  ctx: TenantContext,
  classId: string,
  subjectId: string,
): Promise<AssessableClass | null> {
  if (!z.string().uuid().safeParse(classId).success || !z.string().uuid().safeParse(subjectId).success)
    return null;
  const access = (await listScoreSheetAccess(tx, ctx)).find((a) => a.cls.id === classId);
  return access && access.subjectIds.includes(subjectId) ? access.cls : null;
}

/** Subject teachers of one class, for its overview. */
export async function subjectTeachersIn(
  tx: Transaction,
  tenantId: string,
  classId: string,
): Promise<{ subjectId: string; teacherName: string }[]> {
  if ((await readTeachingModel(tx, tenantId)) !== "subject") return [];
  return tx
    .select({ subjectId: subjectTeachers.subjectId, teacherName: users.name })
    .from(subjectTeachers)
    .innerJoin(memberships, eq(memberships.id, subjectTeachers.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(subjectTeachers.tenantId, tenantId), eq(subjectTeachers.classId, classId)));
}

// ——— Assigning subject teachers ———

export interface SubjectTeacherRow {
  id: string;
  classId: string;
  className: string;
  levelName: string;
  subjectId: string;
  subjectName: string;
  membershipId: string;
  teacherName: string;
}

export interface TeachingOverview {
  model: TeachingModel;
  assignments: SubjectTeacherRow[];
  /** Active classes with the subjects their level takes, for choosing what to assign. */
  classes: { id: string; name: string; levelName: string; subjectIds: string[] }[];
  subjects: { id: string; name: string }[];
}

export async function getTeachingOverview(database: Database, ctx: TenantContext): Promise<TeachingOverview> {
  assertAllowed(ctx, "classes.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const model = await readTeachingModel(tx, ctx.tenant.id);
    const assignments = await tx
      .select({
        id: subjectTeachers.id,
        classId: classes.id,
        className: classes.name,
        levelName: levels.name,
        subjectId: subjects.id,
        subjectName: subjects.name,
        membershipId: subjectTeachers.membershipId,
        teacherName: users.name,
      })
      .from(subjectTeachers)
      .innerJoin(classes, eq(classes.id, subjectTeachers.classId))
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .innerJoin(subjects, eq(subjects.id, subjectTeachers.subjectId))
      .innerJoin(memberships, eq(memberships.id, subjectTeachers.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(subjectTeachers.tenantId, ctx.tenant.id))
      .orderBy(asc(users.name), asc(subjects.name), asc(levels.sequence), asc(classes.name));
    const classRows = await tx
      .select({ id: classes.id, name: classes.name, levelId: classes.levelId, levelName: levels.name })
      .from(classes)
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")))
      .orderBy(asc(levels.sequence), asc(classes.name));
    const links = await tx
      .select({ levelId: levelSubjects.levelId, subjectId: levelSubjects.subjectId })
      .from(levelSubjects)
      .where(eq(levelSubjects.tenantId, ctx.tenant.id));
    const subjectRows = await tx
      .select({ id: subjects.id, name: subjects.name })
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenant.id), eq(subjects.status, "active")))
      .orderBy(asc(subjects.name));
    return {
      model,
      assignments,
      classes: classRows.map((c) => ({
        id: c.id,
        name: c.name,
        levelName: c.levelName,
        subjectIds: links.filter((l) => l.levelId === c.levelId).map((l) => l.subjectId),
      })),
      subjects: subjectRows,
    };
  });
}

const assignSchema = z.object({
  membershipId: z.string().uuid({ message: "Choose a teacher." }),
  subjectId: z.string().uuid({ message: "Choose a subject." }),
  classIds: z.array(z.string().uuid()).min(1, "Choose at least one class.").max(200),
});

/**
 * Makes one teacher the subject teacher of a subject in several classes at once. A class that already has
 * another teacher for the subject is moved to this teacher (the change is audited with both names).
 */
export async function assignSubjectTeacher(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ assigned: number }> {
  assertAllowed(ctx, "academics.manage");
  const data = assignSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const [teacher] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.id, data.membershipId),
          eq(memberships.status, "active"),
        ),
      );
    if (!teacher)
      throw new DomainError("teacher_invalid", "Choose an active member of staff.", "membershipId");
    const [subject] = await tx
      .select({ id: subjects.id, name: subjects.name })
      .from(subjects)
      .where(
        and(
          eq(subjects.tenantId, ctx.tenant.id),
          eq(subjects.id, data.subjectId),
          eq(subjects.status, "active"),
        ),
      );
    if (!subject) throw new DomainError("subject_not_found", "Choose a subject.", "subjectId");
    const chosen = await tx
      .select({ id: classes.id, levelId: classes.levelId, name: classes.name })
      .from(classes)
      .where(
        and(
          eq(classes.tenantId, ctx.tenant.id),
          inArray(classes.id, data.classIds),
          eq(classes.status, "active"),
        ),
      );
    if (chosen.length !== new Set(data.classIds).size)
      throw new DomainError("class_not_found", "One of the classes no longer exists.", "classIds");
    const taking = new Set(
      (
        await tx
          .select({ levelId: levelSubjects.levelId })
          .from(levelSubjects)
          .where(and(eq(levelSubjects.tenantId, ctx.tenant.id), eq(levelSubjects.subjectId, subject.id)))
      ).map((l) => l.levelId),
    );
    const notTaking = chosen.filter((c) => !taking.has(c.levelId));
    if (notTaking.length)
      throw new DomainError(
        "subject_not_taken",
        `${notTaking.map((c) => c.name).join(", ")} ${notTaking.length === 1 ? "does" : "do"} not take ${subject.name}.`,
        "classIds",
      );
    const before = await tx
      .select({ classId: subjectTeachers.classId, membershipId: subjectTeachers.membershipId })
      .from(subjectTeachers)
      .where(
        and(
          eq(subjectTeachers.tenantId, ctx.tenant.id),
          eq(subjectTeachers.subjectId, subject.id),
          inArray(subjectTeachers.classId, data.classIds),
        ),
      );
    const now = new Date();
    for (const cls of chosen)
      await tx
        .insert(subjectTeachers)
        .values({
          tenantId: ctx.tenant.id,
          classId: cls.id,
          subjectId: subject.id,
          membershipId: teacher.id,
          assignedByUserId: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [subjectTeachers.tenantId, subjectTeachers.classId, subjectTeachers.subjectId],
          set: { membershipId: teacher.id, assignedByUserId: ctx.userId, updatedAt: now },
        });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subject_teacher.assigned",
      entityType: "subject",
      entityId: subject.id,
      metadata: {
        membershipId: teacher.id,
        classIds: chosen.map((c) => c.id),
        replaced: before.filter((b) => b.membershipId !== teacher.id),
      },
    });
    return { assigned: chosen.length };
  });
}

/** Ends one subject-teacher assignment; the class teacher enters that subject again. */
export async function removeSubjectTeacher(
  database: Database,
  ctx: TenantContext,
  assignmentId: string,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  if (!z.string().uuid().safeParse(assignmentId).success)
    throw new DomainError("not_found", "Assignment not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [removed] = await tx
      .delete(subjectTeachers)
      .where(and(eq(subjectTeachers.tenantId, ctx.tenant.id), eq(subjectTeachers.id, assignmentId)))
      .returning();
    if (!removed) throw new DomainError("not_found", "Assignment not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subject_teacher.removed",
      entityType: "subject",
      entityId: removed.subjectId,
      metadata: { classId: removed.classId, membershipId: removed.membershipId },
    });
  });
}
