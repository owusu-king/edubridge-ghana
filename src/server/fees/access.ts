import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { assertCan } from "../authz/permissions";
import type { Transaction } from "../db/client";
import { classes, enrolments, students, terms } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/** School-wide finance changes (structures, billing) need fees.manage and access to every campus. */
export function assertCanManageSchoolFees(ctx: TenantContext): void {
  assertCan(ctx.roles, "fees.manage");
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
