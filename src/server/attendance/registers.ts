import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  addDays,
  ATTENDANCE_STATUSES,
  decideMark,
  isIsoDate,
  normaliseReason,
  REASON_MAX,
  TEACHER_EDIT_DAYS,
  type AttendanceStatus,
  type AttendanceTotals,
} from "../../lib/attendance";
import { todayIn } from "../../lib/format";
import { readAttendanceTotals } from "./totals";
import { holidayOn } from "../academics/holidays";
import { sendAbsenceAlerts } from "./alerts";
import {
  listAssessableClasses,
  loadAssessableClass,
  seesAllClasses,
  type AssessableClass,
} from "../assessment/access";
import { classStudents, type ClassStudent } from "../assessment/class-data";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  attendanceChanges,
  attendanceMarks,
  attendanceRegisters,
  enrolments,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface TermOnDate {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  /** The school holiday on this date, if it is one (no register is taken). */
  holiday: string | null;
}

/** The term a date falls in (null between terms), and whether it is a school holiday. */
export async function termOn(tx: Transaction, tenantId: string, date: string): Promise<TermOnDate | null> {
  const [row] = await tx
    .select({ id: terms.id, name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), lte(terms.startsOn, date), gte(terms.endsOn, date)));
  return row ? { ...row, holiday: await holidayOn(tx, tenantId, date) } : null;
}

/** Why a register cannot be taken or changed on this date by this member, or null when it can. */
export function registerLock(ctx: TenantContext, date: string, term: TermOnDate | null): string | null {
  const today = todayIn(ctx.tenant.timezone);
  if (date > today) return "Registers can only be taken for today or earlier.";
  if (!term) return "This date is not in a term.";
  if (term.holiday) return `This day is a school holiday (${term.holiday}). No register is taken.`;
  if (!seesAllClasses(ctx) && date < addDays(today, -TEACHER_EDIT_DAYS))
    return `Teachers can take or correct registers up to ${TEACHER_EDIT_DAYS} days back. Ask the head teacher to correct older ones.`;
  return null;
}

function parseDate(value: string): string {
  if (!isIsoDate(value)) throw new DomainError("date_invalid", "Choose a valid date.", "date");
  return value;
}

export interface RegisterSummary {
  cls: AssessableClass;
  students: number;
  register: {
    takenBy: string | null;
    updatedAt: Date;
    marked: number;
    counts: Record<AttendanceStatus, number>;
  } | null;
}

/** The classes this member takes registers for, with each one's register for a day. */
export async function listRegisters(
  database: Database,
  ctx: TenantContext,
  rawDate: string,
): Promise<{ date: string; term: TermOnDate | null; lock: string | null; classes: RegisterSummary[] }> {
  assertAllowed(ctx, "attendance.take");
  const date = parseDate(rawDate);
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await termOn(tx, ctx.tenant.id, date);
    const list = (await listAssessableClasses(tx, ctx, "attendance.take")).filter(
      (c) => c.status === "active",
    );
    if (!term || list.length === 0) return { date, term, lock: registerLock(ctx, date, term), classes: [] };
    const classIds = list.map((c) => c.id);
    const roster = await tx
      .select({ classId: enrolments.classId, n: sql<number>`count(*)::int` })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.termId, term.id),
          inArray(enrolments.classId, classIds),
        ),
      )
      .groupBy(enrolments.classId);
    const registers = await tx
      .select({
        classId: attendanceRegisters.classId,
        takenBy: users.name,
        updatedAt: attendanceRegisters.updatedAt,
        status: attendanceMarks.status,
        n: sql<number>`count(${attendanceMarks.id})::int`,
      })
      .from(attendanceRegisters)
      .leftJoin(users, eq(users.id, attendanceRegisters.takenByUserId))
      .leftJoin(attendanceMarks, eq(attendanceMarks.registerId, attendanceRegisters.id))
      .where(
        and(
          eq(attendanceRegisters.tenantId, ctx.tenant.id),
          eq(attendanceRegisters.date, date),
          inArray(attendanceRegisters.classId, classIds),
        ),
      )
      .groupBy(
        attendanceRegisters.classId,
        users.name,
        attendanceRegisters.updatedAt,
        attendanceMarks.status,
      );
    return {
      date,
      term,
      lock: registerLock(ctx, date, term),
      classes: list.map((cls) => {
        const rows = registers.filter((r) => r.classId === cls.id);
        const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, 0])) as Record<
          AttendanceStatus,
          number
        >;
        for (const r of rows) if (r.status) counts[r.status] += r.n;
        return {
          cls,
          students: roster.find((r) => r.classId === cls.id)?.n ?? 0,
          register: rows[0]
            ? {
                takenBy: rows[0].takenBy,
                updatedAt: rows[0].updatedAt,
                marked: Object.values(counts).reduce((a, b) => a + b, 0),
                counts,
              }
            : null,
        };
      }),
    };
  });
}

export interface RegisterMark {
  status: AttendanceStatus;
  reason: string | null;
  version: number;
  by: string | null;
  at: Date;
}

export interface RegisterView {
  cls: AssessableClass;
  date: string;
  term: TermOnDate | null;
  /** Why it cannot be changed, or null. */
  lock: string | null;
  takenBy: string | null;
  students: (ClassStudent & { mark: RegisterMark | null })[];
}

async function readMarks(tx: Transaction, tenantId: string, registerId: string) {
  return tx
    .select({
      id: attendanceMarks.id,
      studentId: attendanceMarks.studentId,
      status: attendanceMarks.status,
      reason: attendanceMarks.reason,
      version: attendanceMarks.version,
      by: users.name,
      at: attendanceMarks.updatedAt,
    })
    .from(attendanceMarks)
    .leftJoin(users, eq(users.id, attendanceMarks.recordedByUserId))
    .where(and(eq(attendanceMarks.tenantId, tenantId), eq(attendanceMarks.registerId, registerId)));
}

/** One class's register for a day: every student in the class that term, with their mark if taken. */
export async function getRegister(
  database: Database,
  ctx: TenantContext,
  classId: string,
  rawDate: string,
): Promise<RegisterView | null> {
  assertAllowed(ctx, "attendance.take");
  const date = parseDate(rawDate);
  return withTenant(database, scope(ctx), async (tx) => {
    const cls = await loadAssessableClass(tx, ctx, classId, "attendance.take");
    if (!cls) return null;
    const term = await termOn(tx, ctx.tenant.id, date);
    const roster = term ? await classStudents(tx, ctx.tenant.id, term.id, cls.id) : [];
    const [register] = await tx
      .select({ id: attendanceRegisters.id, takenBy: users.name })
      .from(attendanceRegisters)
      .leftJoin(users, eq(users.id, attendanceRegisters.takenByUserId))
      .where(
        and(
          eq(attendanceRegisters.tenantId, ctx.tenant.id),
          eq(attendanceRegisters.classId, cls.id),
          eq(attendanceRegisters.date, date),
        ),
      );
    const marks = register ? await readMarks(tx, ctx.tenant.id, register.id) : [];
    const byStudent = new Map(marks.map((m) => [m.studentId, m]));
    return {
      cls,
      date,
      term,
      lock: registerLock(ctx, date, term),
      takenBy: register?.takenBy ?? null,
      students: roster.map((s) => {
        const m = byStudent.get(s.id);
        return {
          ...s,
          mark: m ? { status: m.status, reason: m.reason, version: m.version, by: m.by, at: m.at } : null,
        };
      }),
    };
  });
}

const syncSchema = z.object({
  classId: z.string().uuid(),
  date: z.string(),
  source: z.enum(["online", "offline", "kept_mine"]),
  /** When the marks were recorded on the device (for changes saved while offline). */
  recordedAt: z.string().datetime().optional(),
  marks: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: z.enum(ATTENDANCE_STATUSES),
        reason: z
          .string()
          .max(REASON_MAX * 2)
          .nullable()
          .optional(),
        baseVersion: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(300),
});

export interface SyncConflict {
  studentId: string;
  name: string;
  yours: { status: AttendanceStatus; reason: string | null };
  theirs: RegisterMark;
}

export interface SyncResult {
  applied: number;
  unchanged: number;
  conflicts: SyncConflict[];
  /** Students no longer in the class on that date; their marks were not saved. */
  skipped: string[];
  /** SMS queued to families whose absences reached the school's thresholds. */
  alerts: number;
}

/**
 * Saves marks on a class register, from the screen or replayed from a device that was offline. Each mark
 * applies only if it was made from the mark's current version; otherwise it comes back as a conflict with
 * the current mark, for the person to decide. Every change is kept in `attendance_changes`.
 */
export async function syncRegister(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<SyncResult> {
  assertAllowed(ctx, "attendance.take");
  const data = syncSchema.parse(input);
  const date = parseDate(data.date);
  const recordedAt = data.recordedAt ? new Date(data.recordedAt) : null;
  return withTenant(database, scope(ctx), async (tx) => {
    const cls = await loadAssessableClass(tx, ctx, data.classId, "attendance.take");
    if (!cls) throw new DomainError("class_not_found", "Class not found.");
    const term = await termOn(tx, ctx.tenant.id, date);
    const lock = registerLock(ctx, date, term);
    if (lock || !term) throw new DomainError("register_locked", lock ?? "This date is not in a term.");
    // One writer per register at a time: creating it and comparing versions must not interleave.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`register:${cls.id}:${date}`}))`);
    const roster = new Map((await classStudents(tx, ctx.tenant.id, term.id, cls.id)).map((s) => [s.id, s]));

    let [register] = await tx
      .select({ id: attendanceRegisters.id })
      .from(attendanceRegisters)
      .where(
        and(
          eq(attendanceRegisters.tenantId, ctx.tenant.id),
          eq(attendanceRegisters.classId, cls.id),
          eq(attendanceRegisters.date, date),
        ),
      );
    if (!register)
      [register] = await tx
        .insert(attendanceRegisters)
        .values({
          tenantId: ctx.tenant.id,
          classId: cls.id,
          termId: term.id,
          date,
          takenByUserId: ctx.userId,
        })
        .returning({ id: attendanceRegisters.id });
    const current = new Map((await readMarks(tx, ctx.tenant.id, register!.id)).map((m) => [m.studentId, m]));

    const result: SyncResult = { applied: 0, unchanged: 0, conflicts: [], skipped: [], alerts: 0 };
    const nowAbsent: string[] = [];
    const now = new Date();
    for (const change of data.marks) {
      const student = roster.get(change.studentId);
      if (!student) {
        result.skipped.push(change.studentId);
        continue;
      }
      const reason = normaliseReason(change.status, change.reason);
      const existing = current.get(change.studentId) ?? null;
      const decision = decideMark(existing, {
        status: change.status,
        reason,
        baseVersion: change.baseVersion,
      });
      if (decision === "unchanged") {
        result.unchanged++;
        continue;
      }
      if (decision === "conflict") {
        result.conflicts.push({
          studentId: student.id,
          name: student.name,
          yours: { status: change.status, reason },
          theirs: {
            status: existing!.status,
            reason: existing!.reason,
            version: existing!.version,
            by: existing!.by,
            at: existing!.at,
          },
        });
        continue;
      }
      let markId: string;
      let version: number;
      if (decision === "insert") {
        const [row] = await tx
          .insert(attendanceMarks)
          .values({
            tenantId: ctx.tenant.id,
            registerId: register!.id,
            studentId: student.id,
            status: change.status,
            reason,
            recordedByUserId: ctx.userId,
          })
          .returning({ id: attendanceMarks.id, version: attendanceMarks.version });
        markId = row!.id;
        version = row!.version;
      } else {
        version = existing!.version + 1;
        markId = existing!.id;
        await tx
          .update(attendanceMarks)
          .set({ status: change.status, reason, version, recordedByUserId: ctx.userId, updatedAt: now })
          .where(eq(attendanceMarks.id, existing!.id));
      }
      await tx.insert(attendanceChanges).values({
        tenantId: ctx.tenant.id,
        markId,
        studentId: student.id,
        fromStatus: existing?.status ?? null,
        toStatus: change.status,
        fromReason: existing?.reason ?? null,
        toReason: reason,
        version,
        source: data.source,
        recordedOnDeviceAt: data.source === "online" ? null : recordedAt,
        changedByUserId: ctx.userId,
      });
      if (change.status === "absent") nowAbsent.push(student.id);
      result.applied++;
    }
    result.alerts = await sendAbsenceAlerts(tx, ctx, { termId: term.id, date, absentStudentIds: nowAbsent });
    if (result.applied) {
      await tx
        .update(attendanceRegisters)
        .set({ takenByUserId: ctx.userId, updatedAt: now })
        .where(eq(attendanceRegisters.id, register!.id));
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "attendance.register_saved",
        entityType: "class",
        entityId: cls.id,
        metadata: {
          class: cls.name,
          date,
          marks: result.applied,
          conflicts: result.conflicts.length,
          source: data.source,
        },
      });
    }
    return result;
  });
}

export interface ClassAttendance {
  registers: number;
  students: (ClassStudent & { totals: AttendanceTotals })[];
}

/** A class's attendance so far in the term containing a date: registers taken and each student's totals. */
export async function getClassAttendance(
  database: Database,
  ctx: TenantContext,
  classId: string,
  rawDate: string,
): Promise<ClassAttendance | null> {
  assertAllowed(ctx, "attendance.take");
  const date = parseDate(rawDate);
  return withTenant(database, scope(ctx), async (tx) => {
    const cls = await loadAssessableClass(tx, ctx, classId, "attendance.take");
    const term = await termOn(tx, ctx.tenant.id, date);
    if (!cls || !term) return null;
    const roster = await classStudents(tx, ctx.tenant.id, term.id, cls.id);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attendanceRegisters)
      .where(
        and(
          eq(attendanceRegisters.tenantId, ctx.tenant.id),
          eq(attendanceRegisters.classId, cls.id),
          eq(attendanceRegisters.termId, term.id),
        ),
      );
    const totals = await readAttendanceTotals(
      tx,
      ctx.tenant.id,
      term.id,
      roster.map((s) => s.id),
    );
    return { registers: count?.n ?? 0, students: roster.map((s) => ({ ...s, totals: totals.get(s.id)! })) };
  });
}

/** A student's attendance this term and their latest days away (for the parent view; no reasons shown). */
export async function readStudentAttendance(
  tx: Transaction,
  tenantId: string,
  studentId: string,
  today: string,
): Promise<{
  termName: string;
  totals: AttendanceTotals;
  recent: { date: string; status: AttendanceStatus }[];
} | null> {
  const term = await termOn(tx, tenantId, today);
  if (!term) return null;
  const totals = (await readAttendanceTotals(tx, tenantId, term.id, [studentId])).get(studentId)!;
  if (totals.open === 0) return null;
  const recent = await tx
    .select({ date: attendanceRegisters.date, status: attendanceMarks.status })
    .from(attendanceMarks)
    .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
    .where(
      and(
        eq(attendanceMarks.tenantId, tenantId),
        eq(attendanceMarks.studentId, studentId),
        eq(attendanceRegisters.termId, term.id),
        inArray(attendanceMarks.status, ["late", "absent", "excused"]),
      ),
    )
    .orderBy(desc(attendanceRegisters.date), asc(attendanceMarks.status))
    .limit(5);
  return { termName: term.name, totals, recent };
}
