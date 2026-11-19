import "server-only";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { STAFF_ATTENDANCE_MARKS, type StaffAttendanceMark } from "../../lib/staff";
import { holidayOn } from "../academics/holidays";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { campuses, staff, staffAttendance, staffPositions, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { approvedLeaveOn } from "./leave";
import { scopeOf, todayFor } from "./records";

/**
 * Staff attendance (HR-04; module staff_hr). One mark per person per day: present, late, absent or off duty.
 * Approved leave shows as "on leave" and cannot be marked otherwise. A change names the version it was made
 * from and applies only if the mark is still at it; otherwise it comes back as a conflict showing the other
 * mark, so nobody silently overwrites anyone (as class registers do). Every change is audited.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

export interface StaffDayRow {
  staffId: string;
  staffNumber: string;
  name: string;
  position: string | null;
  campus: string | null;
  /** Approved leave covering the day (its type), if any. */
  onLeave: string | null;
  mark: { status: StaffAttendanceMark; note: string | null; version: number; by: string; at: Date } | null;
}

export interface StaffDay {
  date: string;
  holiday: string | null;
  rows: StaffDayRow[];
}

function visibleOn(ctx: TenantContext, date: string) {
  return and(
    eq(staff.tenantId, ctx.tenant.id),
    lte(staff.startedOn, date),
    or(eq(staff.status, "active"), sql`${staff.leftOn} >= ${date}`),
    ctx.campusIds === null ? undefined : or(isNull(staff.campusId), inArray(staff.campusId, ctx.campusIds)),
  );
}

export async function getStaffDay(database: Database, ctx: TenantContext, date: string): Promise<StaffDay> {
  assertAllowed(ctx, "staff.attendance");
  const day = isoDate.parse(date);
  if (day > todayFor(ctx)) throw new DomainError("date_future", "Choose today or an earlier day.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const people = await tx
      .select({
        id: staff.id,
        staffNumber: staff.staffNumber,
        firstName: staff.firstName,
        lastName: staff.lastName,
        position: staffPositions.name,
        campus: campuses.name,
      })
      .from(staff)
      .leftJoin(staffPositions, eq(staffPositions.id, staff.positionId))
      .leftJoin(campuses, eq(campuses.id, staff.campusId))
      .where(visibleOn(ctx, day))
      .orderBy(asc(staff.lastName), asc(staff.firstName));
    const marks = await tx
      .select({ m: staffAttendance, by: users.name })
      .from(staffAttendance)
      .innerJoin(users, eq(users.id, staffAttendance.recordedByUserId))
      .where(and(eq(staffAttendance.tenantId, ctx.tenant.id), eq(staffAttendance.date, day)));
    const byStaff = new Map(marks.map(({ m, by }) => [m.staffId, { m, by }]));
    const leave = await approvedLeaveOn(tx, ctx.tenant.id, day);
    return {
      date: day,
      holiday: await holidayOn(tx, ctx.tenant.id, day),
      rows: people.map((p) => {
        const found = byStaff.get(p.id);
        return {
          staffId: p.id,
          staffNumber: p.staffNumber,
          name: `${p.firstName} ${p.lastName}`,
          position: p.position,
          campus: p.campus,
          onLeave: leave.get(p.id) ?? null,
          mark: found
            ? {
                status: found.m.status,
                note: found.m.note,
                version: found.m.version,
                by: found.by,
                at: found.m.recordedAt,
              }
            : null,
        };
      }),
    };
  });
}

const saveSchema = z.object({
  date: isoDate,
  marks: z
    .array(
      z.object({
        staffId: z.string().uuid(),
        status: z.enum(STAFF_ATTENDANCE_MARKS),
        note: z.preprocess(
          (v) => (typeof v === "string" && v.trim() === "" ? null : v),
          z.string().trim().max(200, "Use 200 characters or fewer.").nullable().optional(),
        ),
        /** The version the change was made from; 0 for a person not marked yet. */
        version: z.number().int().min(0),
      }),
    )
    .max(1000),
});

export interface StaffConflict {
  staffId: string;
  name: string;
  theirs: { status: StaffAttendanceMark; by: string; at: Date; version: number };
  yours: StaffAttendanceMark;
}

/** Saves changed marks for a day. Marks that changed meanwhile come back as conflicts, never overwritten. */
export async function saveStaffDay(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ saved: number; conflicts: StaffConflict[] }> {
  assertAllowed(ctx, "staff.attendance");
  const data = saveSchema.parse(input);
  if (data.date > todayFor(ctx)) throw new DomainError("date_future", "Choose today or an earlier day.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const ids = data.marks.map((m) => m.staffId);
    if (!ids.length) return { saved: 0, conflicts: [] };
    const people = await tx
      .select({ id: staff.id, firstName: staff.firstName, lastName: staff.lastName })
      .from(staff)
      .where(and(visibleOn(ctx, data.date), inArray(staff.id, ids)));
    const known = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
    const leave = await approvedLeaveOn(tx, ctx.tenant.id, data.date);
    let saved = 0;
    const conflicts: StaffConflict[] = [];
    for (const mark of data.marks) {
      const name = known.get(mark.staffId);
      if (!name) throw new DomainError("not_found", "Staff member not found.");
      if (leave.has(mark.staffId))
        throw new DomainError(
          "on_leave",
          `${name} is on approved leave that day. Cancel the leave first to mark them otherwise.`,
        );
      const note = mark.note ?? null;
      const [current] = await tx
        .select({ m: staffAttendance, by: users.name })
        .from(staffAttendance)
        .innerJoin(users, eq(users.id, staffAttendance.recordedByUserId))
        .where(
          and(
            eq(staffAttendance.tenantId, ctx.tenant.id),
            eq(staffAttendance.staffId, mark.staffId),
            eq(staffAttendance.date, data.date),
          ),
        )
        .for("update", { of: staffAttendance });
      if ((current?.m.version ?? 0) !== mark.version) {
        if (current && (current.m.status !== mark.status || current.m.note !== note))
          conflicts.push({
            staffId: mark.staffId,
            name,
            theirs: {
              status: current.m.status,
              by: current.by,
              at: current.m.recordedAt,
              version: current.m.version,
            },
            yours: mark.status,
          });
        continue;
      }
      if (current && current.m.status === mark.status && current.m.note === note) continue;
      if (current)
        await tx
          .update(staffAttendance)
          .set({
            status: mark.status,
            note,
            version: current.m.version + 1,
            recordedByUserId: ctx.userId,
            recordedAt: new Date(),
          })
          .where(eq(staffAttendance.id, current.m.id));
      else
        await tx.insert(staffAttendance).values({
          tenantId: ctx.tenant.id,
          staffId: mark.staffId,
          date: data.date,
          status: mark.status,
          note,
          recordedByUserId: ctx.userId,
        });
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: current ? "staff.attendance_corrected" : "staff.attendance_marked",
        entityType: "staff",
        entityId: mark.staffId,
        metadata: { date: data.date, from: current?.m.status ?? null, to: mark.status },
      });
      saved++;
    }
    return { saved, conflicts };
  });
}
