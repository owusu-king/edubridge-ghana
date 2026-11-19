import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { exeatOverdueDays, fitsHouse, HOUSE_KIND_LABELS } from "../../lib/boarding";
import { assertAllowed } from "../authz/permissions";
import type { Database, Queryable, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  boardingAssignments,
  boardingBeds,
  boardingExeats,
  boardingHouses,
  boardingRooms,
  classes,
  enrolments,
  students,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { audit, optionalText, requiredText, scopeOf, UUID } from "../inventory/common";
import { fullName } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { currentTermId, visibleHouseIds } from "./houses";

/**
 * Boarders (R4-8 BRD-01c, BRD-03): who sleeps in which bed this term, and exeats. One bed per boarder and one
 * boarder per bed per term (database); a move ends the old assignment and keeps it. An exeat is signed back in once.
 */

/** Students at the school this term who are not yet boarders, with their sex and class, for placing them. */
export async function listPlaceableStudents(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "boarding.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx.tenant.id);
    if (!termId) return [];
    const rows = await tx
      .select({ s: students, className: classes.name })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.termId, termId),
          eq(students.status, "active"),
          sql`not exists (select 1 from boarding_assignments a where a.student_id = ${students.id} and a.term_id = ${termId} and a.ended_at is null)`,
        ),
      )
      .orderBy(asc(classes.name), asc(students.firstName), asc(students.lastName));
    return rows.map((r) => ({ id: r.s.id, name: fullName(r.s), sex: r.s.sex, className: r.className }));
  });
}

/**
 * Puts a student in a bed for the current term (BRD-01c). A boarder already in a bed is moved: the old assignment
 * is ended and kept. Billing then charges the boarding item to them (BRD-02).
 */
export async function placeBoarder(database: Database, ctx: TenantContext, input: Record<string, unknown>) {
  assertAllowed(ctx, "boarding.manage");
  const data = z
    .object({
      studentId: z.string({ message: "Choose a student." }).uuid("Choose a student."),
      bedId: z.string({ message: "Choose a bed." }).uuid("Choose a bed."),
    })
    .parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx.tenant.id);
    if (!termId) throw new DomainError("no_term", "Set the current term first, in Settings, Calendar.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`boarding:${data.studentId}:${termId}`}))`);
    const [student] = await tx
      .select({ s: students })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(
        and(
          eq(enrolments.tenantId, ctx.tenant.id),
          eq(enrolments.termId, termId),
          eq(enrolments.studentId, data.studentId),
          eq(students.status, "active"),
        ),
      );
    if (!student)
      throw new DomainError("not_enrolled", "Choose a student in a class this term.", "studentId");
    const [bed] = await tx
      .select({
        id: boardingBeds.id,
        label: boardingBeds.label,
        room: boardingRooms.name,
        house: boardingHouses,
      })
      .from(boardingBeds)
      .innerJoin(boardingRooms, eq(boardingRooms.id, boardingBeds.roomId))
      .innerJoin(boardingHouses, eq(boardingHouses.id, boardingRooms.houseId))
      .where(
        and(
          eq(boardingBeds.tenantId, ctx.tenant.id),
          eq(boardingBeds.id, data.bedId),
          eq(boardingBeds.status, "active"),
          eq(boardingRooms.status, "active"),
          eq(boardingHouses.status, "active"),
        ),
      )
      .for("update", { of: boardingBeds });
    if (!bed) throw new DomainError("not_found", "Choose a bed in use.", "bedId");
    if (!fitsHouse(bed.house.kind, student.s.sex))
      throw new DomainError(
        "wrong_house",
        `${bed.house.name} is a ${HOUSE_KIND_LABELS[bed.house.kind].toLowerCase()}' house.`,
        "bedId",
      );
    const [taken] = await tx
      .select({ studentId: boardingAssignments.studentId })
      .from(boardingAssignments)
      .where(
        and(
          eq(boardingAssignments.bedId, bed.id),
          eq(boardingAssignments.termId, termId),
          isNull(boardingAssignments.endedAt),
        ),
      );
    if (taken && taken.studentId !== data.studentId)
      throw new DomainError("bed_taken", "Someone already sleeps in this bed this term.", "bedId");
    if (taken) return;
    const [open] = await tx
      .select({ id: boardingAssignments.id })
      .from(boardingAssignments)
      .where(
        and(
          eq(boardingAssignments.tenantId, ctx.tenant.id),
          eq(boardingAssignments.studentId, data.studentId),
          eq(boardingAssignments.termId, termId),
          isNull(boardingAssignments.endedAt),
        ),
      )
      .for("update");
    if (open)
      await tx
        .update(boardingAssignments)
        .set({ endedAt: new Date(), endedByUserId: ctx.userId })
        .where(eq(boardingAssignments.id, open.id));
    await tx.insert(boardingAssignments).values({
      tenantId: ctx.tenant.id,
      studentId: data.studentId,
      termId,
      bedId: bed.id,
      createdByUserId: ctx.userId,
    });
    await audit(
      tx,
      ctx,
      open ? "boarding.boarder_moved" : "boarding.boarder_placed",
      "student",
      data.studentId,
      {
        house: bed.house.name,
        room: bed.room,
        bed: bed.label,
      },
    );
  });
}

/** A student stops boarding this term; the assignment is kept as ended. */
export async function endPlacement(database: Database, ctx: TenantContext, assignmentId: string) {
  assertAllowed(ctx, "boarding.manage");
  if (!UUID.safeParse(assignmentId).success) throw new DomainError("not_found", "Not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(boardingAssignments)
      .set({ endedAt: new Date(), endedByUserId: ctx.userId })
      .where(
        and(
          eq(boardingAssignments.tenantId, ctx.tenant.id),
          eq(boardingAssignments.id, assignmentId),
          isNull(boardingAssignments.endedAt),
        ),
      )
      .returning({ studentId: boardingAssignments.studentId });
    if (!row) throw new DomainError("not_found", "This student is no longer in that bed.");
    await audit(tx, ctx, "boarding.boarder_removed", "student", row.studentId);
  });
}

// ——— Exeats (BRD-03) ———

/** This term's boarders in the houses this member looks after, for signing them out. */
export async function listBoarders(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "boarding.exeat");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const visible = await visibleHouseIds(tx, ctx);
    const termId = await currentTermId(tx, ctx.tenant.id);
    if (!termId || (visible && !visible.length)) return [];
    const rows = await tx
      .select({ s: students, house: boardingHouses.name, houseId: boardingHouses.id })
      .from(boardingAssignments)
      .innerJoin(students, eq(students.id, boardingAssignments.studentId))
      .innerJoin(boardingBeds, eq(boardingBeds.id, boardingAssignments.bedId))
      .innerJoin(boardingRooms, eq(boardingRooms.id, boardingBeds.roomId))
      .innerJoin(boardingHouses, eq(boardingHouses.id, boardingRooms.houseId))
      .where(
        and(
          eq(boardingAssignments.tenantId, ctx.tenant.id),
          eq(boardingAssignments.termId, termId),
          isNull(boardingAssignments.endedAt),
          visible ? inArray(boardingHouses.id, visible) : undefined,
        ),
      )
      .orderBy(asc(boardingHouses.name), asc(students.firstName), asc(students.lastName));
    return rows.map((r) => ({ id: r.s.id, name: fullName(r.s), house: r.house, houseId: r.houseId }));
  });
}

async function boarderHouse(tx: Transaction, ctx: TenantContext, studentId: string) {
  const termId = await currentTermId(tx, ctx.tenant.id);
  const visible = await visibleHouseIds(tx, ctx);
  const [row] = termId
    ? await tx
        .select({ houseId: boardingRooms.houseId, s: students })
        .from(boardingAssignments)
        .innerJoin(students, eq(students.id, boardingAssignments.studentId))
        .innerJoin(boardingBeds, eq(boardingBeds.id, boardingAssignments.bedId))
        .innerJoin(boardingRooms, eq(boardingRooms.id, boardingBeds.roomId))
        .where(
          and(
            eq(boardingAssignments.tenantId, ctx.tenant.id),
            eq(boardingAssignments.studentId, studentId),
            eq(boardingAssignments.termId, termId),
            isNull(boardingAssignments.endedAt),
          ),
        )
    : [];
  if (!row || (visible && !visible.includes(row.houseId)))
    throw new DomainError("not_found", "Choose a boarder in your house.", "studentId");
  return { houseId: row.houseId, name: fullName(row.s) };
}

const exeatSchema = (today: string) =>
  z.object({
    studentId: z.string({ message: "Choose a boarder." }).uuid("Choose a boarder."),
    reason: requiredText(3, 300, "Say why, e.g. a family wedding or to see a doctor."),
    collectedBy: requiredText(2, 120, "Say who collected them."),
    expectedBackOn: z
      .string({ message: "Choose the day they are due back." })
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the day they are due back.")
      .refine((v) => v >= today, "Choose today or a later day."),
    note: optionalText(300),
  });

/** Signs a boarder out on exeat (BRD-03); one open exeat per boarder (database). */
export async function signOutBoarder(database: Database, ctx: TenantContext, input: Record<string, unknown>) {
  assertAllowed(ctx, "boarding.exeat");
  const data = exeatSchema(todayIn(ctx.tenant.timezone)).parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const boarder = await boarderHouse(tx, ctx, data.studentId);
    const inserted = await tx
      .insert(boardingExeats)
      .values({
        tenantId: ctx.tenant.id,
        studentId: data.studentId,
        houseId: boarder.houseId,
        reason: data.reason,
        collectedBy: data.collectedBy,
        expectedBackOn: data.expectedBackOn,
        outByUserId: ctx.userId,
        note: data.note ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: boardingExeats.id });
    if (!inserted.length)
      throw new DomainError("already_out", `${boarder.name} is already out on exeat.`, "studentId");
    await audit(tx, ctx, "boarding.signed_out", "student", data.studentId, {
      expectedBackOn: data.expectedBackOn,
    });
  });
}

/** Signs a boarder back in, once. */
export async function signInBoarder(database: Database, ctx: TenantContext, exeatId: string) {
  assertAllowed(ctx, "boarding.exeat");
  if (!UUID.safeParse(exeatId).success) throw new DomainError("not_found", "Exeat not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const visible = await visibleHouseIds(tx, ctx);
    const [row] = await tx
      .update(boardingExeats)
      .set({ backAt: new Date(), backByUserId: ctx.userId })
      .where(
        and(
          eq(boardingExeats.tenantId, ctx.tenant.id),
          eq(boardingExeats.id, exeatId),
          isNull(boardingExeats.backAt),
          visible
            ? inArray(
                boardingExeats.houseId,
                visible.length ? visible : ["00000000-0000-0000-0000-000000000000"],
              )
            : undefined,
        ),
      )
      .returning({ studentId: boardingExeats.studentId });
    if (!row) throw new DomainError("not_found", "This boarder is already back.");
    await audit(tx, ctx, "boarding.signed_in", "student", row.studentId);
  });
}

export interface Exeat {
  id: string;
  studentId: string;
  student: string;
  house: string;
  reason: string;
  collectedBy: string;
  expectedBackOn: string;
  outAt: Date;
  outBy: string;
  backAt: Date | null;
  overdueDays: number;
}

/** Boarders out now (overdue first), and the last 30 days of exeats, in the houses this member looks after. */
export async function listExeats(
  database: Database,
  ctx: TenantContext,
): Promise<{ out: Exeat[]; recent: Exeat[] }> {
  assertAllowed(ctx, "boarding.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const visible = await visibleHouseIds(tx, ctx);
    if (visible && !visible.length) return { out: [], recent: [] };
    const rows = await tx
      .select({ e: boardingExeats, s: students, house: boardingHouses.name, outBy: users.name })
      .from(boardingExeats)
      .innerJoin(students, eq(students.id, boardingExeats.studentId))
      .innerJoin(boardingHouses, eq(boardingHouses.id, boardingExeats.houseId))
      .innerJoin(users, eq(users.id, boardingExeats.outByUserId))
      .where(
        and(
          eq(boardingExeats.tenantId, ctx.tenant.id),
          sql`(${boardingExeats.backAt} is null or ${boardingExeats.outAt} > now() - interval '30 days')`,
          visible ? inArray(boardingExeats.houseId, visible) : undefined,
        ),
      )
      .orderBy(desc(boardingExeats.outAt))
      .limit(300);
    const on = todayIn(ctx.tenant.timezone);
    const all = rows.map((r) => ({
      id: r.e.id,
      studentId: r.e.studentId,
      student: fullName(r.s),
      house: r.house,
      reason: r.e.reason,
      collectedBy: r.e.collectedBy,
      expectedBackOn: r.e.expectedBackOn,
      outAt: r.e.outAt,
      outBy: r.outBy,
      backAt: r.e.backAt,
      overdueDays: exeatOverdueDays(r.e.expectedBackOn, on, r.e.backAt),
    }));
    return {
      out: all
        .filter((e) => !e.backAt)
        .sort((a, b) => b.overdueDays - a.overdueDays || a.expectedBackOn.localeCompare(b.expectedBackOn)),
      recent: all.filter((e) => e.backAt),
    };
  });
}

// ——— Billing (BRD-02) and the parent view ———

/** Students with a bed in a term: billing charges them the boarding item, and nobody else. */
export async function readBoarders(tx: Queryable, tenantId: string, termId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ studentId: boardingAssignments.studentId })
    .from(boardingAssignments)
    .where(
      and(
        eq(boardingAssignments.tenantId, tenantId),
        eq(boardingAssignments.termId, termId),
        isNull(boardingAssignments.endedAt),
      ),
    );
  return new Set(rows.map((r) => r.studentId));
}

/** A child's house, room and bed this term, and an open exeat, for the parent view. */
export async function readParentBoarding(tx: Transaction, tenantId: string, studentId: string) {
  const termId = await currentTermId(tx, tenantId);
  if (!termId) return null;
  const [row] = await tx
    .select({ house: boardingHouses.name, room: boardingRooms.name, bed: boardingBeds.label })
    .from(boardingAssignments)
    .innerJoin(boardingBeds, eq(boardingBeds.id, boardingAssignments.bedId))
    .innerJoin(boardingRooms, eq(boardingRooms.id, boardingBeds.roomId))
    .innerJoin(boardingHouses, eq(boardingHouses.id, boardingRooms.houseId))
    .where(
      and(
        eq(boardingAssignments.tenantId, tenantId),
        eq(boardingAssignments.studentId, studentId),
        eq(boardingAssignments.termId, termId),
        isNull(boardingAssignments.endedAt),
      ),
    );
  if (!row) return null;
  const [exeat] = await tx
    .select({ expectedBackOn: boardingExeats.expectedBackOn, outAt: boardingExeats.outAt })
    .from(boardingExeats)
    .where(
      and(
        eq(boardingExeats.tenantId, tenantId),
        eq(boardingExeats.studentId, studentId),
        isNull(boardingExeats.backAt),
      ),
    );
  return { ...row, exeat: exeat ?? null };
}
