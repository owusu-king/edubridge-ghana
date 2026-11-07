import "server-only";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { allowed, type Permission } from "../authz/permissions";
import type { Transaction } from "../db/client";
import { campuses, classes, levels, memberships, terms, users } from "../db/schema";
import type { TenantContext } from "../tenancy/service";
import type { Stage } from "../academics/classes";

export interface AssessableClass {
  id: string;
  name: string;
  levelId: string;
  levelName: string;
  stage: Stage;
  campusName: string;
  status: "active" | "archived";
  classTeacherName: string | null;
}

/** Staff who oversee academics reach every class (at their campuses); others only enter for their own. */
export function seesAllClasses(ctx: TenantContext): boolean {
  return allowed(ctx, "academics.manage") || allowed(ctx, "reports.publish");
}

const NONE = "00000000-0000-0000-0000-000000000000";

/** Class work that follows the class-teacher rule: entering marks and remarks, and taking the register. */
export type ClassWork = Extract<Permission, "assessment.enter" | "attendance.take">;

/**
 * Conditions for the classes this member may do class work for (marks, remarks, registers): all classes
 * (within campus scope) for academic leads; for teachers, the classes they are class teacher of. Null when
 * they may see none.
 */
async function classConditions(tx: Transaction, ctx: TenantContext, work: ClassWork): Promise<SQL[] | null> {
  if (!allowed(ctx, work)) return null;
  const conditions: SQL[] = [eq(classes.tenantId, ctx.tenant.id)];
  if (ctx.campusIds !== null)
    conditions.push(inArray(classes.campusId, ctx.campusIds.length ? ctx.campusIds : [NONE]));
  if (!seesAllClasses(ctx)) {
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
    conditions.push(eq(classes.classTeacherMembershipId, membership?.id ?? NONE));
  }
  return conditions;
}

const classColumns = {
  id: classes.id,
  name: classes.name,
  levelId: classes.levelId,
  levelName: levels.name,
  stage: levels.stage,
  campusName: campuses.name,
  status: classes.status,
  classTeacherName: users.name,
};

function classQuery(tx: Transaction) {
  return tx
    .select(classColumns)
    .from(classes)
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .innerJoin(campuses, eq(campuses.id, classes.campusId))
    .leftJoin(memberships, eq(memberships.id, classes.classTeacherMembershipId))
    .leftJoin(users, eq(users.id, memberships.userId));
}

/** Classes this member may assess, in level then name order. */
export async function listAssessableClasses(
  tx: Transaction,
  ctx: TenantContext,
  work: ClassWork = "assessment.enter",
): Promise<AssessableClass[]> {
  const conditions = await classConditions(tx, ctx, work);
  if (!conditions) return [];
  return classQuery(tx)
    .where(and(...conditions))
    .orderBy(asc(levels.sequence), asc(classes.name));
}

/** One class this member may assess, or null (unknown and out of reach look the same). */
export async function loadAssessableClass(
  tx: Transaction,
  ctx: TenantContext,
  classId: string,
  work: ClassWork = "assessment.enter",
): Promise<AssessableClass | null> {
  if (!z.string().uuid().safeParse(classId).success) return null;
  const conditions = await classConditions(tx, ctx, work);
  if (!conditions) return null;
  const [row] = await classQuery(tx).where(and(...conditions, eq(classes.id, classId)));
  return row ?? null;
}

export interface TermRef {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

export async function loadTerm(tx: Transaction, tenantId: string, termId: string): Promise<TermRef | null> {
  if (!z.string().uuid().safeParse(termId).success) return null;
  const [row] = await tx
    .select({
      id: terms.id,
      name: terms.name,
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
      isCurrent: terms.isCurrent,
    })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.id, termId)));
  return row ?? null;
}
