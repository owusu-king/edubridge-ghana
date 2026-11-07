import "server-only";
import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm";
import { listAssessableClasses } from "../assessment/access";
import { allowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  attendanceRegisters,
  classes,
  enrolments,
  levels,
  students,
  syncChanges,
  tenants,
  terms,
} from "../db/schema";
import { DomainError } from "../errors";
import { visibleClassIds } from "../students/service";
import type { TenantContext } from "../tenancy/service";

/**
 * The incoming half of sync: what changed since the device last asked, limited to what this person may
 * see now. Without a cursor the device gets a snapshot (students it may see with their class this term, and
 * classes) and a cursor; afterwards it asks for changes after that cursor. Students and classes come with
 * their data; registers and marks come as hints (which register or class to fetch again), because those
 * screens are read whole. Something the person may no longer see is listed as removed, so devices drop it
 * (access revoked, student moved to another teacher's class, record deleted).
 */

/** Change entries are kept this long (the worker purges older ones); older cursors must start again. */
export const CHANGES_KEPT_DAYS = 90;
const CURSOR_MAX_AGE_DAYS = 60;
const PAGE = 500;

export interface SyncStudent {
  id: string;
  admissionNumber: string;
  firstName: string;
  otherNames: string | null;
  lastName: string;
  sex: "female" | "male";
  dateOfBirth: string | null;
  status: "active" | "withdrawn" | "graduated";
  /** The class this term, or null. */
  classId: string | null;
}

export interface SyncClass {
  id: string;
  name: string;
  levelName: string;
  campusId: string;
  status: "active" | "archived";
}

export interface SyncChanges {
  cursor: string;
  snapshot: boolean;
  /** More changes are waiting: ask again with the new cursor. */
  more: boolean;
  students: SyncStudent[];
  removedStudents: string[];
  classes: SyncClass[];
  removedClasses: string[];
  /** Registers whose marks changed: fetch them again. */
  registers: { classId: string; date: string }[];
  /** Classes whose marks changed this term: fetch their score sheets again. */
  marks: { classId: string }[];
}

function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq, t: Date.now() })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const { s, t } = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { s: unknown; t: unknown };
    if (typeof s !== "number" || typeof t !== "number" || !Number.isSafeInteger(s) || s < 0)
      throw new Error();
    if (Date.now() - t > CURSOR_MAX_AGE_DAYS * 86_400_000)
      throw new DomainError(
        "resync_required",
        "This device has not synced for a long time. Start again from a snapshot.",
      );
    return s;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("cursor_invalid", "The sync cursor is not valid. Start again from a snapshot.");
  }
}

async function currentTermId(tx: Transaction, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.isCurrent, true)));
  return row?.id ?? null;
}

/** Students this person may see (all, or only the given ids), with their class this term. */
async function readStudents(tx: Transaction, ctx: TenantContext, ids?: string[]): Promise<SyncStudent[]> {
  if (!allowed(ctx, "students.view") || ids?.length === 0) return [];
  const termId = await currentTermId(tx, ctx.tenant.id);
  const visible = await visibleClassIds(tx, ctx);
  const rows = await tx
    .select({
      id: students.id,
      admissionNumber: students.admissionNumber,
      firstName: students.firstName,
      otherNames: students.otherNames,
      lastName: students.lastName,
      sex: students.sex,
      dateOfBirth: students.dateOfBirth,
      status: students.status,
      classId: enrolments.classId,
    })
    .from(students)
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, students.id),
        eq(enrolments.termId, termId ?? "00000000-0000-0000-0000-000000000000"),
      ),
    )
    .where(and(eq(students.tenantId, ctx.tenant.id), ids ? inArray(students.id, ids) : undefined))
    .orderBy(asc(students.lastName), asc(students.firstName));
  // Staff limited to some classes see only students placed in them this term.
  return visible === null ? rows : rows.filter((r) => r.classId !== null && visible.includes(r.classId));
}

async function readClasses(tx: Transaction, ctx: TenantContext, ids?: string[]): Promise<SyncClass[]> {
  if (!allowed(ctx, "classes.view") || ids?.length === 0) return [];
  return tx
    .select({
      id: classes.id,
      name: classes.name,
      levelName: levels.name,
      campusId: classes.campusId,
      status: classes.status,
    })
    .from(classes)
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .where(
      and(
        eq(classes.tenantId, ctx.tenant.id),
        ids ? inArray(classes.id, ids) : undefined,
        ctx.campusIds !== null
          ? inArray(
              classes.campusId,
              ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"],
            )
          : undefined,
      ),
    )
    .orderBy(asc(levels.sequence), asc(classes.name));
}

export async function getSyncChanges(
  database: Database,
  ctx: TenantContext,
  cursor?: string | null,
): Promise<SyncChanges> {
  const since = cursor ? decodeCursor(cursor) : null;
  return withTenant(database, { tenantId: ctx.tenant.id, userId: ctx.userId }, async (tx) => {
    const empty = { registers: [], marks: [], removedStudents: [], removedClasses: [] };
    if (since === null) {
      // Read the position first: anything changing during the snapshot comes again in the next page.
      const [top] = await tx
        .select({ seq: max(syncChanges.seq) })
        .from(syncChanges)
        .where(eq(syncChanges.tenantId, ctx.tenant.id));
      return {
        cursor: encodeCursor(top?.seq ?? 0),
        snapshot: true,
        more: false,
        students: await readStudents(tx, ctx),
        classes: await readClasses(tx, ctx),
        ...empty,
      };
    }
    const entries = await tx
      .select({ seq: syncChanges.seq, entity: syncChanges.entity, entityId: syncChanges.entityId })
      .from(syncChanges)
      .where(and(eq(syncChanges.tenantId, ctx.tenant.id), gt(syncChanges.seq, since)))
      .orderBy(asc(syncChanges.seq))
      .limit(PAGE + 1);
    const page = entries.slice(0, PAGE);
    const last = page.at(-1)?.seq ?? since;
    const idsOf = (entity: string) => [
      ...new Set(page.filter((e) => e.entity === entity).map((e) => e.entityId)),
    ];

    const studentIds = idsOf("student");
    const changedStudents = await readStudents(tx, ctx, studentIds);
    const classIds = idsOf("class");
    const changedClasses = await readClasses(tx, ctx, classIds);

    // Hints only for classes this person does class work for.
    const registerIds = idsOf("register");
    let registers: SyncChanges["registers"] = [];
    if (registerIds.length && allowed(ctx, "attendance.take")) {
      const reach = new Set((await listAssessableClasses(tx, ctx, "attendance.take")).map((c) => c.id));
      registers = (
        await tx
          .select({ classId: attendanceRegisters.classId, date: attendanceRegisters.date })
          .from(attendanceRegisters)
          .where(
            and(
              eq(attendanceRegisters.tenantId, ctx.tenant.id),
              inArray(attendanceRegisters.id, registerIds),
            ),
          )
      ).filter((r) => reach.has(r.classId));
    }
    const markStudents = idsOf("score");
    let marks: SyncChanges["marks"] = [];
    if (markStudents.length && allowed(ctx, "assessment.enter")) {
      const reach = new Set((await listAssessableClasses(tx, ctx, "assessment.enter")).map((c) => c.id));
      const termId = await currentTermId(tx, ctx.tenant.id);
      const placed = termId
        ? await tx
            .selectDistinct({ classId: enrolments.classId })
            .from(enrolments)
            .where(
              and(
                eq(enrolments.tenantId, ctx.tenant.id),
                eq(enrolments.termId, termId),
                inArray(enrolments.studentId, markStudents),
              ),
            )
        : [];
      marks = placed.filter((p) => reach.has(p.classId));
    }

    const seenStudents = new Set(changedStudents.map((s) => s.id));
    const seenClasses = new Set(changedClasses.map((c) => c.id));
    return {
      cursor: encodeCursor(last),
      snapshot: false,
      more: entries.length > PAGE,
      students: changedStudents,
      removedStudents: allowed(ctx, "students.view") ? studentIds.filter((id) => !seenStudents.has(id)) : [],
      classes: changedClasses,
      removedClasses: allowed(ctx, "classes.view") ? classIds.filter((id) => !seenClasses.has(id)) : [],
      registers,
      marks,
    };
  });
}

/** Removes change entries older than the retention period, school by school (run by the worker). */
export async function purgeSyncChanges(database: Database): Promise<number> {
  const schools = await database.select({ id: tenants.id }).from(tenants);
  let removed = 0;
  for (const school of schools) {
    const result = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
      tx.execute(
        sql`delete from sync_changes where tenant_id = ${school.id} and at < now() - make_interval(days => ${CHANGES_KEPT_DAYS})`,
      ),
    );
    removed += result.rowCount ?? 0;
  }
  return removed;
}
