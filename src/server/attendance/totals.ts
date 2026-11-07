import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NO_ATTENDANCE, type AttendanceTotals } from "../../lib/attendance";
import type { Transaction } from "../db/client";
import { attendanceMarks, attendanceRegisters } from "../db/schema";

/** Attendance totals for students in a term, from the registers they were on. */
export async function readAttendanceTotals(
  tx: Transaction,
  tenantId: string,
  termId: string,
  studentIds: string[],
): Promise<Map<string, AttendanceTotals>> {
  const totals = new Map<string, AttendanceTotals>(studentIds.map((id) => [id, { ...NO_ATTENDANCE }]));
  if (studentIds.length === 0) return totals;
  const rows = await tx
    .select({
      studentId: attendanceMarks.studentId,
      status: attendanceMarks.status,
      n: sql<number>`count(*)::int`,
    })
    .from(attendanceMarks)
    .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
    .where(
      and(
        eq(attendanceMarks.tenantId, tenantId),
        eq(attendanceRegisters.termId, termId),
        inArray(attendanceMarks.studentId, studentIds),
      ),
    )
    .groupBy(attendanceMarks.studentId, attendanceMarks.status);
  for (const row of rows) {
    const t = totals.get(row.studentId)!;
    t[row.status] += row.n;
    t.open += row.n;
  }
  return totals;
}
