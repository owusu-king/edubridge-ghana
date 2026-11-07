import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  defaultDestination,
  parseDestination,
  planMove,
  type Destination,
  type MoveClass,
  type MovePlan,
} from "../../lib/term-move";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  assessmentScores,
  attendanceMarks,
  attendanceRegisters,
  classes,
  enrolments,
  ledgerEntries,
  levels,
  reportCards,
  students,
  termMoveEnrolments,
  termMoves,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { assertStudentCapacity } from "../students/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Moving students into the next term's classes (ACS-04): the same classes within a year, or up a level at
 * the start of a new year, with the last level graduating. Shown as a preview first; one transaction when
 * confirmed; undone in one step while nothing has been recorded against the new placements.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

function assertWholeSchool(ctx: TenantContext) {
  assertAllowed(ctx, "academics.manage");
  if (ctx.campusIds !== null)
    throw new DomainError(
      "campus_restricted",
      "Moving students affects the whole school. Ask a colleague with access to every campus.",
    );
}

export interface MoveTerm {
  id: string;
  name: string;
  yearId: string;
  yearName: string;
  startsOn: string;
  isCurrent: boolean;
}

async function readTerms(tx: Transaction, tenantId: string): Promise<MoveTerm[]> {
  return tx
    .select({
      id: terms.id,
      name: terms.name,
      yearId: terms.academicYearId,
      yearName: academicYears.name,
      startsOn: terms.startsOn,
      isCurrent: terms.isCurrent,
    })
    .from(terms)
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(eq(terms.tenantId, tenantId))
    .orderBy(asc(terms.startsOn));
}

async function readClasses(tx: Transaction, tenantId: string): Promise<MoveClass[]> {
  return tx
    .select({
      id: classes.id,
      name: classes.name,
      levelId: levels.id,
      levelName: levels.name,
      levelSequence: levels.sequence,
      campusId: classes.campusId,
      status: classes.status,
    })
    .from(classes)
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .where(eq(classes.tenantId, tenantId))
    .orderBy(asc(levels.sequence), asc(classes.name));
}

async function readActiveLevels(tx: Transaction, tenantId: string) {
  return tx
    .select({ id: levels.id, name: levels.name, sequence: levels.sequence })
    .from(levels)
    .where(and(eq(levels.tenantId, tenantId), eq(levels.status, "active")));
}

async function readStudents(tx: Transaction, tenantId: string, termId: string) {
  return tx
    .select({
      studentId: students.id,
      classId: enrolments.classId,
      firstName: students.firstName,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
      status: students.status,
    })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.tenantId, tenantId), eq(enrolments.termId, termId)))
    .orderBy(asc(students.lastName), asc(students.firstName));
}

async function placedIn(tx: Transaction, tenantId: string, termId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ studentId: enrolments.studentId })
    .from(enrolments)
    .where(and(eq(enrolments.tenantId, tenantId), eq(enrolments.termId, termId)));
  return new Set(rows.map((r) => r.studentId));
}

const label = (t: MoveTerm) => `${t.name}, ${t.yearName}`;

/** The term to move from (asked for, or the current one) and to (asked for, or the next one). */
function chooseTerms(all: MoveTerm[], fromId?: string, toId?: string) {
  const current = all.find((t) => t.isCurrent);
  const from = all.find((t) => t.id === fromId) ?? current ?? all[0];
  if (!from) return null;
  const later = all.filter((t) => t.startsOn > from.startsOn);
  const to = later.find((t) => t.id === toId) ?? later[0] ?? null;
  return { from, to };
}

export interface MovePreviewClass {
  cls: MoveClass;
  destination: Destination;
  students: { id: string; name: string; admissionNumber: string; alreadyPlaced: boolean }[];
}

export interface MoveRecord {
  id: string;
  from: string;
  to: string;
  newYear: boolean;
  placed: number;
  graduated: number;
  by: string;
  createdAt: Date;
  undoneAt: Date | null;
}

export interface MovePreview {
  terms: MoveTerm[];
  from: MoveTerm | null;
  to: MoveTerm | null;
  newYear: boolean;
  /** Classes with students in the term moved from, each with its suggested destination. */
  classes: MovePreviewClass[];
  /** Every active class, for choosing destinations. */
  destinations: MoveClass[];
  /** Students already in a class in the term moved into. */
  alreadyPlaced: number;
  moves: MoveRecord[];
}

export async function getMovePreview(
  database: Database,
  ctx: TenantContext,
  requested: { from?: string; to?: string } = {},
): Promise<MovePreview> {
  assertWholeSchool(ctx);
  return withTenant(database, scope(ctx), async (tx) => {
    const all = await readTerms(tx, ctx.tenant.id);
    const chosen = chooseTerms(all, requested.from, requested.to);
    const moves = await readMoves(tx, ctx.tenant.id, all);
    if (!chosen?.to) {
      return {
        terms: all,
        from: chosen?.from ?? null,
        to: null,
        newYear: false,
        classes: [],
        destinations: [],
        alreadyPlaced: 0,
        moves,
      };
    }
    const { from, to } = chosen;
    const newYear = from.yearId !== to.yearId;
    const [allClasses, activeLevels, enrolled, placed] = await Promise.all([
      readClasses(tx, ctx.tenant.id),
      readActiveLevels(tx, ctx.tenant.id),
      readStudents(tx, ctx.tenant.id, from.id),
      placedIn(tx, ctx.tenant.id, to.id),
    ]);
    const active = enrolled.filter((s) => s.status === "active");
    return {
      terms: all,
      from,
      to,
      newYear,
      classes: allClasses
        .filter((c) => active.some((s) => s.classId === c.id))
        .map((cls) => ({
          cls,
          destination: defaultDestination(cls, allClasses, activeLevels, newYear),
          students: active
            .filter((s) => s.classId === cls.id)
            .map((s) => ({
              id: s.studentId,
              name: `${s.firstName} ${s.lastName}`,
              admissionNumber: s.admissionNumber,
              alreadyPlaced: placed.has(s.studentId),
            })),
        })),
      destinations: allClasses.filter((c) => c.status === "active"),
      alreadyPlaced: active.filter((s) => placed.has(s.studentId)).length,
      moves,
    };
  });
}

async function readMoves(tx: Transaction, tenantId: string, all: MoveTerm[]): Promise<MoveRecord[]> {
  const rows = await tx
    .select({ move: termMoves, by: users.name })
    .from(termMoves)
    .innerJoin(users, eq(users.id, termMoves.createdByUserId))
    .where(eq(termMoves.tenantId, tenantId))
    .orderBy(desc(termMoves.createdAt))
    .limit(10);
  const name = (id: string) => {
    const t = all.find((x) => x.id === id);
    return t ? label(t) : "";
  };
  return rows.map(({ move, by }) => ({
    id: move.id,
    from: name(move.fromTermId),
    to: name(move.toTermId),
    newYear: move.newYear,
    placed: move.placed,
    graduated: move.graduatedStudentIds.length,
    by,
    createdAt: move.createdAt,
    undoneAt: move.undoneAt,
  }));
}

const moveSchema = z.object({
  fromTermId: z.string().uuid(),
  toTermId: z.string().uuid(),
  /** Per class moved from: a class id, "graduate" or "none". */
  destinations: z.record(z.string().uuid(), z.string().max(40)),
  /** Students not to move (repeating, leaving, or to place by hand). */
  leaveOut: z.array(z.string().uuid()).max(10_000).default([]),
});

export interface MoveResult extends Pick<MovePlan, "alreadyPlaced" | "leftOut" | "notMoved"> {
  moveId: string;
  placed: number;
  graduated: number;
}

export async function moveStudents(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<MoveResult> {
  assertWholeSchool(ctx);
  const data = moveSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    // One move at a time per school, so two people cannot place the same students twice.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"term-move:" + ctx.tenant.id}, 0))`);
    const all = await readTerms(tx, ctx.tenant.id);
    const from = all.find((t) => t.id === data.fromTermId);
    const to = all.find((t) => t.id === data.toTermId);
    if (!from || !to) throw new DomainError("term_not_found", "Choose the terms again.");
    if (to.startsOn <= from.startsOn)
      throw new DomainError("move_backwards", "Students can only be moved into a later term.", "toTermId");
    const newYear = from.yearId !== to.yearId;
    const allClasses = await readClasses(tx, ctx.tenant.id);
    const activeIds = new Set(allClasses.filter((c) => c.status === "active").map((c) => c.id));
    const destinations = new Map(
      Object.entries(data.destinations).map(([classId, value]) => [
        classId,
        parseDestination(value, activeIds),
      ]),
    );
    if (!newYear && [...destinations.values()].some((d) => d.kind === "graduate"))
      throw new DomainError(
        "graduate_within_year",
        "Students graduate only when moving into a new academic year.",
      );
    const enrolled = await readStudents(tx, ctx.tenant.id, from.id);
    const plan = planMove({
      students: enrolled.map((s) => ({
        studentId: s.studentId,
        classId: s.classId,
        active: s.status === "active",
      })),
      destinations,
      alreadyPlaced: await placedIn(tx, ctx.tenant.id, to.id),
      leftOut: new Set(data.leaveOut),
    });
    if (plan.place.length === 0 && plan.graduate.length === 0)
      throw new DomainError("nothing_to_move", "Nobody would be moved. Choose where each class goes.");

    const created = plan.place.length
      ? await tx
          .insert(enrolments)
          .values(
            plan.place.map((p) => ({
              tenantId: ctx.tenant.id,
              studentId: p.studentId,
              termId: to.id,
              classId: p.classId,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: enrolments.id })
      : [];
    const graduated = plan.graduate.length
      ? await tx
          .update(students)
          .set({ status: "graduated", updatedAt: new Date() })
          .where(
            and(
              eq(students.tenantId, ctx.tenant.id),
              inArray(students.id, plan.graduate),
              eq(students.status, "active"),
            ),
          )
          .returning({ id: students.id })
      : [];
    const [move] = await tx
      .insert(termMoves)
      .values({
        tenantId: ctx.tenant.id,
        fromTermId: from.id,
        toTermId: to.id,
        newYear,
        placed: created.length,
        graduatedStudentIds: graduated.map((g) => g.id),
        createdByUserId: ctx.userId,
      })
      .returning({ id: termMoves.id });
    if (created.length)
      await tx
        .insert(termMoveEnrolments)
        .values(created.map((e) => ({ tenantId: ctx.tenant.id, moveId: move!.id, enrolmentId: e.id })));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "students.moved",
      entityType: "term_move",
      entityId: move!.id,
      metadata: {
        from: label(from),
        to: label(to),
        placed: created.length,
        graduated: graduated.length,
        leftOut: plan.leftOut.length,
        alreadyPlaced: plan.alreadyPlaced.length,
      },
    });
    return {
      moveId: move!.id,
      placed: created.length,
      graduated: graduated.length,
      alreadyPlaced: plan.alreadyPlaced,
      leftOut: plan.leftOut,
      notMoved: plan.notMoved,
    };
  });
}

/**
 * Undoes a move: removes the placements it created and sets students it graduated back to active. Refused
 * once anything has been recorded for those students in the new term (fees, registers, marks, report
 * cards), because those records would lose their class.
 */
export async function undoMove(database: Database, ctx: TenantContext, moveId: string): Promise<void> {
  assertWholeSchool(ctx);
  if (!z.string().uuid().safeParse(moveId).success) throw new DomainError("not_found", "Move not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"term-move:" + ctx.tenant.id}, 0))`);
    const [move] = await tx
      .select()
      .from(termMoves)
      .where(and(eq(termMoves.tenantId, ctx.tenant.id), eq(termMoves.id, moveId)))
      .for("update");
    if (!move) throw new DomainError("not_found", "Move not found.");
    if (move.undoneAt) throw new DomainError("already_undone", "This move has already been undone.");
    const placements = await tx
      .select({ id: enrolments.id, studentId: enrolments.studentId })
      .from(termMoveEnrolments)
      .innerJoin(enrolments, eq(enrolments.id, termMoveEnrolments.enrolmentId))
      .where(eq(termMoveEnrolments.moveId, move.id));
    const ids = placements.map((p) => p.studentId);
    if (ids.length) {
      const count = async (table: "fees" | "registers" | "marks" | "cards") => {
        const query =
          table === "fees"
            ? tx
                .select({ n: sql<number>`count(distinct ${ledgerEntries.studentId})::int` })
                .from(ledgerEntries)
                .where(and(eq(ledgerEntries.termId, move.toTermId), inArray(ledgerEntries.studentId, ids)))
            : table === "registers"
              ? tx
                  .select({ n: sql<number>`count(distinct ${attendanceMarks.studentId})::int` })
                  .from(attendanceMarks)
                  .innerJoin(attendanceRegisters, eq(attendanceRegisters.id, attendanceMarks.registerId))
                  .where(
                    and(
                      eq(attendanceRegisters.termId, move.toTermId),
                      inArray(attendanceMarks.studentId, ids),
                    ),
                  )
              : table === "marks"
                ? tx
                    .select({ n: sql<number>`count(distinct ${assessmentScores.studentId})::int` })
                    .from(assessmentScores)
                    .where(
                      and(
                        eq(assessmentScores.termId, move.toTermId),
                        inArray(assessmentScores.studentId, ids),
                      ),
                    )
                : tx
                    .select({ n: sql<number>`count(distinct ${reportCards.studentId})::int` })
                    .from(reportCards)
                    .where(and(eq(reportCards.termId, move.toTermId), inArray(reportCards.studentId, ids)));
        const [row] = await query;
        return row?.n ?? 0;
      };
      const blockers = [
        [await count("fees"), "have fees billed"],
        [await count("registers"), "are on registers"],
        [await count("marks"), "have marks"],
        [await count("cards"), "have report cards"],
      ].filter(([n]) => (n as number) > 0) as [number, string][];
      if (blockers.length)
        throw new DomainError(
          "move_in_use",
          `This move can no longer be undone: in the new term, ${blockers
            .map(([n, what]) => `${n} of these students ${what}`)
            .join("; ")}. Change classes one student at a time instead.`,
        );
      await tx.delete(enrolments).where(
        inArray(
          enrolments.id,
          placements.map((p) => p.id),
        ),
      );
    }
    if (move.graduatedStudentIds.length) {
      const back = await tx
        .select({ id: students.id })
        .from(students)
        .where(and(inArray(students.id, move.graduatedStudentIds), eq(students.status, "graduated")));
      await assertStudentCapacity(tx, ctx.tenant.id, back.length);
      if (back.length)
        await tx
          .update(students)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            inArray(
              students.id,
              back.map((b) => b.id),
            ),
          );
    }
    await tx
      .update(termMoves)
      .set({ undoneAt: new Date(), undoneByUserId: ctx.userId })
      .where(eq(termMoves.id, move.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "students.move_undone",
      entityType: "term_move",
      entityId: move.id,
      metadata: { removed: placements.length, reactivated: move.graduatedStudentIds.length },
    });
  });
}

/**
 * When the current term has nobody in classes but the term before it did: the school has changed term and
 * still needs to move students across (shown as a prompt on the overview and classes page).
 */
export async function pendingMove(
  database: Database,
  ctx: TenantContext,
): Promise<{ from: MoveTerm; to: MoveTerm } | null> {
  return withTenant(database, scope(ctx), async (tx) => {
    const all = await readTerms(tx, ctx.tenant.id);
    const to = all.find((t) => t.isCurrent);
    if (!to) return null;
    const before = all.filter((t) => t.startsOn < to.startsOn);
    const from = before[before.length - 1];
    if (!from) return null;
    const count = async (termId: string) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(enrolments)
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .where(
          and(
            eq(enrolments.tenantId, ctx.tenant.id),
            eq(enrolments.termId, termId),
            eq(students.status, "active"),
          ),
        );
      return row?.n ?? 0;
    };
    if ((await count(to.id)) > 0 || (await count(from.id)) === 0) return null;
    return { from, to };
  });
}
