import "server-only";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { assertAllowed } from "../authz/permissions";
import type { Transaction } from "../db/client";
import { classes, enrolments, students, terms } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/** School-wide finance changes (structures, billing) need fees.manage and access to every campus. */
export function assertCanManageSchoolFees(ctx: TenantContext): void {
  assertAllowed(ctx, "fees.manage");
  if (ctx.campusIds !== null) {
    throw new DomainError(
      "campus_restricted",
      "Fees apply to the whole school. Ask a colleague with access to every campus.",
    );
  }
}

/**
 * Loads a student for finance work. Staff limited to some campuses only reach students whose class this
 * term is at one of those campuses. Unknown and out-of-scope students look the same: not found.
 */
export async function loadFinanceStudent(tx: Transaction, ctx: TenantContext, studentId: string) {
  const [student] = await tx
    .select({
      id: students.id,
      firstName: students.firstName,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
    })
    .from(students)
    .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, studentId)));
  if (!student) return null;
  if (ctx.campusIds === null) return student;
  if (ctx.campusIds.length === 0) return null;
  const [inScope] = await tx
    .select({ id: enrolments.id })
    .from(enrolments)
    .innerJoin(terms, eq(terms.id, enrolments.termId))
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .where(
      and(
        eq(enrolments.tenantId, ctx.tenant.id),
        eq(enrolments.studentId, studentId),
        eq(terms.isCurrent, true),
        inArray(classes.campusId, ctx.campusIds),
      ),
    );
  return inScope ? student : null;
}

/**
 * A WHERE condition for list queries: staff limited to some campuses see only students whose class this
 * term is at one of those campuses. Undefined (no condition) for staff with every campus.
 */
export function campusScopeFilter(ctx: TenantContext, studentId: AnyPgColumn): SQL | undefined {
  if (ctx.campusIds === null) return undefined;
  const campusIds = ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"];
  return sql`exists (
    select 1 from ${enrolments}
    join ${terms} on ${terms.id} = ${enrolments.termId} and ${terms.isCurrent}
    join ${classes} on ${classes.id} = ${enrolments.classId}
    where ${enrolments.studentId} = ${studentId} and ${inArray(classes.campusId, campusIds)}
  )`;
}
