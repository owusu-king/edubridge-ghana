import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { addDays } from "../../lib/attendance";
import {
  SUGGESTED_LEAVE_TYPES,
  leaveBalances,
  leaveDaysInYear,
  overlaps,
  workingDays,
  type LeaveBalance,
  type LeaveStatus,
} from "../../lib/staff";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { leaveRequests, leaveTypes, memberships, schoolHolidays, staff, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { readOwnStaff, scopeOf, todayFor } from "./records";

/**
 * Leave (HR-03; module staff_hr). A member with a staff record asks for their own leave; leave approvers
 * record leave for anyone (approved as they record it) and decide requests, never their own. Days are working
 * days (Monday to Friday, less the school's holidays). Decisions are made once and requests never change
 * (database trigger); cancelling returns the days.
 */

const UUID = z.string().uuid();
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const isoDate = (message: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, message);

// ——— Leave types (HR-03a) ———

export interface LeaveType {
  id: string;
  name: string;
  daysPerYear: number | null;
  paid: boolean;
  archived: boolean;
}

async function readTypes(tx: Transaction, tenantId: string): Promise<LeaveType[]> {
  const rows = await tx
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.tenantId, tenantId))
    .orderBy(asc(leaveTypes.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    daysPerYear: r.daysPerYear,
    paid: r.paid,
    archived: r.archivedAt !== null,
  }));
}

export async function listLeaveTypes(database: Database, ctx: TenantContext): Promise<LeaveType[]> {
  if (!allowed(ctx, "staff.view")) assertAllowed(ctx, "leave.request");
  return withTenant(database, scopeOf(ctx), (tx) => readTypes(tx, ctx.tenant.id));
}

/** Adds the suggested Ghana leave types the school does not have yet (by name). */
export async function addSuggestedLeaveTypes(database: Database, ctx: TenantContext): Promise<number> {
  assertAllowed(ctx, "staff.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const added = await tx
      .insert(leaveTypes)
      .values(SUGGESTED_LEAVE_TYPES.map((t) => ({ tenantId: ctx.tenant.id, ...t })))
      .onConflictDoNothing()
      .returning({ name: leaveTypes.name });
    if (added.length)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "leave.types_added",
        entityType: "leave_type",
        metadata: { names: added.map((a) => a.name) },
      });
    return added.length;
  });
}

const typeSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters.").max(60, "Use 60 characters or fewer."),
  daysPerYear: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int("Use a whole number.").min(0, "Use 0 or more.").max(366, "Use 366 or fewer.").nullable(),
  ),
  paid: z.boolean(),
});

/** Adds a leave type, or changes one (id given). Changing the days changes balances from now on. */
export async function saveLeaveType(
  database: Database,
  ctx: TenantContext,
  id: string | null,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "staff.manage");
  const data = typeSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    // Names are unique per school, compared without case (citext).
    const [same] = await tx
      .select({ id: leaveTypes.id })
      .from(leaveTypes)
      .where(and(eq(leaveTypes.tenantId, ctx.tenant.id), eq(leaveTypes.name, data.name)));
    if (same && same.id !== id)
      throw new DomainError("name_taken", `There is already a leave type called ${data.name}.`, "name");
    let saved: string;
    if (id) {
      if (!UUID.safeParse(id).success) throw new DomainError("not_found", "Leave type not found.");
      const [row] = await tx
        .update(leaveTypes)
        .set(data)
        .where(and(eq(leaveTypes.tenantId, ctx.tenant.id), eq(leaveTypes.id, id)))
        .returning({ id: leaveTypes.id });
      if (!row) throw new DomainError("not_found", "Leave type not found.");
      saved = row.id;
    } else {
      const [row] = await tx
        .insert(leaveTypes)
        .values({ tenantId: ctx.tenant.id, ...data })
        .returning({ id: leaveTypes.id });
      saved = row!.id;
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: id ? "leave.type_updated" : "leave.type_added",
      entityType: "leave_type",
      entityId: saved,
      metadata: data,
    });
    return saved;
  });
}

export async function setLeaveTypeArchived(
  database: Database,
  ctx: TenantContext,
  id: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "staff.manage");
  if (!UUID.safeParse(id).success) throw new DomainError("not_found", "Leave type not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(leaveTypes)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(leaveTypes.tenantId, ctx.tenant.id), eq(leaveTypes.id, id)))
      .returning({ name: leaveTypes.name });
    if (!row) throw new DomainError("not_found", "Leave type not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: archived ? "leave.type_archived" : "leave.type_restored",
      entityType: "leave_type",
      entityId: id,
      metadata: { name: row.name },
    });
  });
}

// ——— Requests (HR-03b, HR-03c) ———

/** The school's holidays as a set of dates between two days (for counting working days). */
async function holidaySet(tx: Transaction, tenantId: string, from: string, to: string): Promise<Set<string>> {
  const rows = await tx
    .select({ startsOn: schoolHolidays.startsOn, endsOn: schoolHolidays.endsOn })
    .from(schoolHolidays)
    .where(
      and(
        eq(schoolHolidays.tenantId, tenantId),
        lte(schoolHolidays.startsOn, to),
        gte(schoolHolidays.endsOn, from),
      ),
    );
  const days = new Set<string>();
  for (const h of rows) for (let d = h.startsOn; d <= h.endsOn; d = addDays(d, 1)) days.add(d);
  return days;
}

/** Approved leave days of one person in each year a period touches, against each type's days a year. */
async function overBalance(
  tx: Transaction,
  tenantId: string,
  staffId: string,
  type: { id: string; daysPerYear: number | null },
  period: { startsOn: string; endsOn: string },
  excludeId: string | null,
): Promise<number | null> {
  if (type.daysPerYear === null) return null;
  const years = new Set([Number(period.startsOn.slice(0, 4)), Number(period.endsOn.slice(0, 4))]);
  const approved = await tx
    .select({ id: leaveRequests.id, startsOn: leaveRequests.startsOn, endsOn: leaveRequests.endsOn })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenantId, tenantId),
        eq(leaveRequests.staffId, staffId),
        eq(leaveRequests.leaveTypeId, type.id),
        eq(leaveRequests.status, "approved"),
      ),
    );
  let worst: number | null = null;
  for (const year of years) {
    const holidays = await holidaySet(tx, tenantId, `${year}-01-01`, `${year}-12-31`);
    const taken = approved
      .filter((a) => a.id !== excludeId)
      .reduce((sum, a) => sum + leaveDaysInYear(a, year, holidays), 0);
    const over = taken + leaveDaysInYear(period, year, holidays) - type.daysPerYear;
    if (over > 0 && (worst === null || over > worst)) worst = over;
  }
  return worst;
}

const requestSchema = z
  .object({
    staffId: z.preprocess(blank, UUID.nullable().optional()),
    leaveTypeId: UUID,
    startsOn: isoDate("Choose the first day."),
    endsOn: isoDate("Choose the last day."),
    reason: z.preprocess(
      blank,
      z.string().trim().max(300, "Use 300 characters or fewer.").nullable().optional(),
    ),
    confirmOverBalance: z.boolean().default(false),
  })
  .refine((v) => v.endsOn >= v.startsOn, { message: "The last day is before the first.", path: ["endsOn"] });

/**
 * Asks for leave (own record), or records it for someone else (leave approvers: approved as recorded).
 * Refused when it overlaps the person's other waiting or approved leave, or has no working days. Recording
 * beyond the year's balance needs the approver's confirmation; a person's own request may go beyond it and the
 * approver decides.
 */
export async function requestLeave(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string; status: LeaveStatus; days: number }> {
  const data = requestSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const own = await readOwnStaff(tx, ctx);
    const forOther = Boolean(data.staffId && data.staffId !== own?.id);
    if (forOther) assertAllowed(ctx, "leave.approve");
    else assertAllowed(ctx, "leave.request");
    const staffId = forOther ? data.staffId! : own?.id;
    if (!staffId)
      throw new DomainError(
        "no_staff_record",
        "You have no staff record at this school yet. Ask the office to add one.",
      );
    const [person] = await tx
      .select({ id: staff.id, status: staff.status, campusId: staff.campusId, startedOn: staff.startedOn })
      .from(staff)
      .where(and(eq(staff.tenantId, ctx.tenant.id), eq(staff.id, staffId)))
      .for("update");
    if (!person) throw new DomainError("not_found", "Staff member not found.", "staffId");
    if (forOther && ctx.campusIds !== null && person.campusId && !ctx.campusIds.includes(person.campusId))
      throw new DomainError("not_found", "Staff member not found.", "staffId");
    if (person.status !== "active") throw new DomainError("staff_left", "This person has left the school.");
    const [type] = await tx
      .select()
      .from(leaveTypes)
      .where(
        and(
          eq(leaveTypes.tenantId, ctx.tenant.id),
          eq(leaveTypes.id, data.leaveTypeId),
          isNull(leaveTypes.archivedAt),
        ),
      );
    if (!type) throw new DomainError("not_found", "Choose a leave type.", "leaveTypeId");

    const holidays = await holidaySet(tx, ctx.tenant.id, data.startsOn, data.endsOn);
    const days = workingDays(data.startsOn, data.endsOn, holidays).length;
    if (days === 0)
      throw new DomainError(
        "no_working_days",
        "These dates have no working days (weekends and holidays).",
        "endsOn",
      );
    const others = await tx
      .select({ startsOn: leaveRequests.startsOn, endsOn: leaveRequests.endsOn })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, ctx.tenant.id),
          eq(leaveRequests.staffId, staffId),
          inArray(leaveRequests.status, ["pending", "approved"]),
        ),
      );
    if (others.some((o) => overlaps(o, data)))
      throw new DomainError(
        "leave_overlap",
        "This overlaps other leave that is waiting or approved.",
        "startsOn",
      );
    const over = await overBalance(tx, ctx.tenant.id, staffId, type, data, null);
    if (forOther && over !== null && !data.confirmOverBalance)
      throw new DomainError(
        "over_balance",
        `This is ${over} ${over === 1 ? "day" : "days"} more than the year's ${type.name.toLowerCase()} allows. Tick to confirm.`,
        "confirmOverBalance",
      );
    const now = new Date();
    const [row] = await tx
      .insert(leaveRequests)
      .values({
        tenantId: ctx.tenant.id,
        staffId,
        leaveTypeId: type.id,
        startsOn: data.startsOn,
        endsOn: data.endsOn,
        days,
        reason: data.reason ?? null,
        status: forOther ? "approved" : "pending",
        requestedByUserId: ctx.userId,
        decidedByUserId: forOther ? ctx.userId : null,
        decidedAt: forOther ? now : null,
      })
      .returning({ id: leaveRequests.id, status: leaveRequests.status });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: forOther ? "leave.recorded" : "leave.requested",
      entityType: "leave_request",
      entityId: row!.id,
      metadata: {
        staffId,
        type: type.name,
        startsOn: data.startsOn,
        endsOn: data.endsOn,
        days,
        overBalance: over,
      },
    });
    return { id: row!.id, status: row!.status, days };
  });
}

const decisionSchema = z
  .object({
    approve: z.boolean(),
    note: z.preprocess(
      blank,
      z.string().trim().max(300, "Use 300 characters or fewer.").nullable().optional(),
    ),
    confirmOverBalance: z.boolean().default(false),
  })
  .refine((v) => v.approve || v.note, { message: "Say why, for the person asking.", path: ["note"] });

/** Approves or declines a waiting request, once, by an approver who is not the person on leave. */
export async function decideLeave(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "leave.approve");
  const data = decisionSchema.parse(input);
  if (!UUID.safeParse(requestId).success) throw new DomainError("not_found", "Leave request not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({
        r: leaveRequests,
        membershipUser: memberships.userId,
        campusId: staff.campusId,
        type: leaveTypes,
      })
      .from(leaveRequests)
      .innerJoin(staff, eq(staff.id, leaveRequests.staffId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .leftJoin(memberships, eq(memberships.id, staff.membershipId))
      .where(and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.id, requestId)))
      .for("update", { of: leaveRequests });
    if (!row || (ctx.campusIds !== null && row.campusId && !ctx.campusIds.includes(row.campusId)))
      throw new DomainError("not_found", "Leave request not found.");
    if (row.r.status !== "pending")
      throw new DomainError("leave_decided", "This request was already decided.");
    if (row.membershipUser === ctx.userId)
      throw new DomainError("own_leave", "Someone else must decide your own leave.");
    if (data.approve) {
      const over = await overBalance(tx, ctx.tenant.id, row.r.staffId, row.type, row.r, row.r.id);
      if (over !== null && !data.confirmOverBalance)
        throw new DomainError(
          "over_balance",
          `This is ${over} ${over === 1 ? "day" : "days"} more than the year's ${row.type.name.toLowerCase()} allows. Tick to confirm.`,
          "confirmOverBalance",
        );
    }
    await tx
      .update(leaveRequests)
      .set({
        status: data.approve ? "approved" : "declined",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: data.note ?? null,
      })
      .where(eq(leaveRequests.id, requestId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: data.approve ? "leave.approved" : "leave.declined",
      entityType: "leave_request",
      entityId: requestId,
      metadata: { staffId: row.r.staffId, note: data.note ?? null },
    });
  });
}

/**
 * Cancels leave: the person asking while it waits or before it starts; an approver at any time (for example
 * someone called back early: the days are returned, and the record shows who cancelled it).
 */
export async function cancelLeave(database: Database, ctx: TenantContext, requestId: string): Promise<void> {
  if (!UUID.safeParse(requestId).success) throw new DomainError("not_found", "Leave request not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const own = await readOwnStaff(tx, ctx);
    const [row] = await tx
      .select({ r: leaveRequests, campusId: staff.campusId })
      .from(leaveRequests)
      .innerJoin(staff, eq(staff.id, leaveRequests.staffId))
      .where(and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.id, requestId)))
      .for("update", { of: leaveRequests });
    if (!row) throw new DomainError("not_found", "Leave request not found.");
    const mine = own?.id === row.r.staffId;
    const approver =
      allowed(ctx, "leave.approve") &&
      !(ctx.campusIds !== null && row.campusId && !ctx.campusIds.includes(row.campusId));
    if (mine) assertAllowed(ctx, "leave.request");
    else if (!approver) throw new DomainError("not_found", "Leave request not found.");
    if (row.r.status !== "pending" && row.r.status !== "approved")
      throw new DomainError("leave_closed", "This request can no longer be cancelled.");
    if (!approver && row.r.status === "approved" && row.r.startsOn <= todayFor(ctx))
      throw new DomainError("leave_started", "Leave that has started is cancelled by an approver.");
    await tx
      .update(leaveRequests)
      .set({ status: "cancelled", cancelledByUserId: ctx.userId, cancelledAt: new Date() })
      .where(eq(leaveRequests.id, requestId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "leave.cancelled",
      entityType: "leave_request",
      entityId: requestId,
      metadata: { staffId: row.r.staffId, was: row.r.status },
    });
  });
}

// ——— Views ———

export interface LeaveRow {
  id: string;
  staffId: string;
  staffName: string;
  type: string;
  startsOn: string;
  endsOn: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  requestedBy: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** Days beyond the year's allowance if approved (waiting requests only). */
  overBalance: number | null;
}

async function leaveRows(tx: Transaction, ctx: TenantContext, where: ReturnType<typeof and>, limit = 200) {
  const rows = await tx
    .select({
      r: leaveRequests,
      firstName: staff.firstName,
      lastName: staff.lastName,
      type: leaveTypes,
      by: users.name,
    })
    .from(leaveRequests)
    .innerJoin(staff, eq(staff.id, leaveRequests.staffId))
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(users, eq(users.id, leaveRequests.requestedByUserId))
    .where(where)
    .orderBy(desc(leaveRequests.startsOn), desc(leaveRequests.createdAt))
    .limit(limit);
  const out: LeaveRow[] = [];
  for (const { r, firstName, lastName, type, by } of rows)
    out.push({
      id: r.id,
      staffId: r.staffId,
      staffName: `${firstName} ${lastName}`,
      type: type.name,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      days: r.days,
      reason: r.reason,
      status: r.status,
      requestedBy: by,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      overBalance:
        r.status === "pending" ? await overBalance(tx, ctx.tenant.id, r.staffId, type, r, r.id) : null,
    });
  return out;
}

async function balancesFor(tx: Transaction, ctx: TenantContext, staffId: string, year: number) {
  const types = (await readTypes(tx, ctx.tenant.id)).filter((t) => !t.archived);
  const approved = await tx
    .select({
      leaveTypeId: leaveRequests.leaveTypeId,
      startsOn: leaveRequests.startsOn,
      endsOn: leaveRequests.endsOn,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenantId, ctx.tenant.id),
        eq(leaveRequests.staffId, staffId),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.startsOn, `${year}-12-31`),
        gte(leaveRequests.endsOn, `${year}-01-01`),
      ),
    );
  return leaveBalances(
    types,
    approved,
    year,
    await holidaySet(tx, ctx.tenant.id, `${year}-01-01`, `${year}-12-31`),
  );
}

export interface MyLeave {
  staff: { id: string; name: string } | null;
  types: LeaveType[];
  year: number;
  balances: LeaveBalance[];
  requests: LeaveRow[];
}

/** The signed-in member's own leave: balances this year and requests. */
export async function getMyLeave(database: Database, ctx: TenantContext): Promise<MyLeave> {
  assertAllowed(ctx, "leave.request");
  const year = Number(todayFor(ctx).slice(0, 4));
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const own = await readOwnStaff(tx, ctx);
    const types = await readTypes(tx, ctx.tenant.id);
    if (!own) return { staff: null, types, year, balances: [], requests: [] };
    return {
      staff: { id: own.id, name: `${own.firstName} ${own.lastName}` },
      types,
      year,
      balances: await balancesFor(tx, ctx, own.id, year),
      requests: await leaveRows(
        tx,
        ctx,
        and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.staffId, own.id)),
        50,
      ),
    };
  });
}

/** Approvers: requests waiting, and who is away today (campus scope applies). */
export async function getLeaveOverview(
  database: Database,
  ctx: TenantContext,
): Promise<{ waiting: LeaveRow[]; awayToday: LeaveRow[]; upcoming: LeaveRow[] }> {
  assertAllowed(ctx, "leave.approve");
  const today = todayFor(ctx);
  const scope =
    ctx.campusIds === null ? undefined : or(isNull(staff.campusId), inArray(staff.campusId, ctx.campusIds));
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const base = (extra: ReturnType<typeof and>) =>
      and(eq(leaveRequests.tenantId, ctx.tenant.id), scope, extra);
    return {
      waiting: (await leaveRows(tx, ctx, base(eq(leaveRequests.status, "pending")))).reverse(),
      awayToday: await leaveRows(
        tx,
        ctx,
        base(
          and(
            eq(leaveRequests.status, "approved"),
            lte(leaveRequests.startsOn, today),
            gte(leaveRequests.endsOn, today),
          ),
        ),
      ),
      upcoming: (
        await leaveRows(
          tx,
          ctx,
          base(
            and(
              eq(leaveRequests.status, "approved"),
              sql`${leaveRequests.startsOn} > ${today}`,
              lte(leaveRequests.startsOn, addDays(today, 30)),
            ),
          ),
        )
      ).reverse(),
    };
  });
}

/** One person's leave and balances, for their staff page. */
export async function getStaffLeave(
  database: Database,
  ctx: TenantContext,
  staffId: string,
): Promise<{ year: number; balances: LeaveBalance[]; requests: LeaveRow[] }> {
  assertAllowed(ctx, "staff.view");
  if (!UUID.safeParse(staffId).success) throw new DomainError("not_found", "Staff member not found.");
  const year = Number(todayFor(ctx).slice(0, 4));
  return withTenant(database, scopeOf(ctx), async (tx) => ({
    year,
    balances: await balancesFor(tx, ctx, staffId, year),
    requests: await leaveRows(
      tx,
      ctx,
      and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.staffId, staffId)),
      50,
    ),
  }));
}

/** Approved leave covering a date, by staff id (for staff attendance). */
export async function approvedLeaveOn(
  tx: Transaction,
  tenantId: string,
  date: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ staffId: leaveRequests.staffId, type: leaveTypes.name })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .where(
      and(
        eq(leaveRequests.tenantId, tenantId),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.startsOn, date),
        gte(leaveRequests.endsOn, date),
      ),
    );
  return new Map(rows.map((r) => [r.staffId, r.type]));
}
