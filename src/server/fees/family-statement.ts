import "server-only";
import type { Database } from "../db/client";
import { listGuardians } from "../students/guardians";
import { getStudent } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { getStudentAccount, type StudentAccount } from "./ledger";

export interface FamilyStatement {
  /** The student's primary guardian, naming the family on the statement. */
  familyName: string;
  children: { account: StudentAccount; className: string | null }[];
}

/**
 * A student and the brothers and sisters who share a guardian with them (FIN-12, PRT-04), each with their
 * account, for a family statement. Only children the person can see the fees of are included (campus
 * scope), and only active ones besides the student asked about. Null when the student is not visible.
 */
export async function getFamilyStatement(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<FamilyStatement | null> {
  const first = await getStudentAccount(database, ctx, studentId);
  if (!first) return null;
  const guardians = (await listGuardians(database, ctx, studentId)) ?? [];
  const siblingIds = [...new Set(guardians.flatMap((g) => g.otherStudents.map((o) => o.id)))];
  const children: FamilyStatement["children"] = [];
  for (const id of [studentId, ...siblingIds]) {
    const account = id === studentId ? first : await getStudentAccount(database, ctx, id);
    if (!account) continue;
    const student = await getStudent(database, ctx, id);
    children.push({ account, className: student?.currentClass?.name ?? null });
  }
  const primary = guardians.find((g) => g.isPrimary) ?? guardians[0];
  return { familyName: primary ? `Family of ${primary.fullName}` : first.student.name, children };
}
