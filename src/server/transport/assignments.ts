import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { fareFor, RIDE_DIRECTIONS, type RideDirection } from "../../lib/transport";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Queryable } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  students,
  transportAssignments,
  transportRoutes,
  transportStops,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { fullName } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { currentTermId, scopeOf } from "./setup";

/**
 * Who rides which route this term (R4-5 TRN-01c). One open assignment per student and term (unique index); a
 * change ends the old one and starts a new one in one transaction, so the history is kept. Billing reads the
 * open assignments of a term to charge the transport fee item (TRN-02b).
 */

const UUID = z.string().uuid();

export interface Assignment {
  id: string;
  studentId: string;
  student: string;
  admissionNumber: string;
  className: string | null;
  routeId: string;
  route: string;
  stopId: string;
  stop: string;
  stopSequence: number;
  morningTime: string | null;
  afternoonTime: string | null;
  direction: RideDirection;
  /** The fare that billing would charge: the stop's, else the route's (null: none set). */
  farePesewas: number | null;
  since: Date;
  by: string;
}

/** Open assignments of a term (the current term by default), optionally for one route. */
export async function readAssignments(
  tx: Queryable,
  tenantId: string,
  termId: string,
  routeId?: string,
): Promise<Assignment[]> {
  const by = alias(users, "assigned_by");
  const rows = await tx
    .select({
      a: transportAssignments,
      s: students,
      className: classes.name,
      route: transportRoutes.name,
      routeFare: transportRoutes.farePesewas,
      stop: transportStops.name,
      stopSequence: transportStops.sequence,
      morningTime: transportStops.morningTime,
      afternoonTime: transportStops.afternoonTime,
      stopFare: transportStops.farePesewas,
      by: by.name,
    })
    .from(transportAssignments)
    .innerJoin(students, eq(students.id, transportAssignments.studentId))
    .innerJoin(transportRoutes, eq(transportRoutes.id, transportAssignments.routeId))
    .innerJoin(transportStops, eq(transportStops.id, transportAssignments.stopId))
    .innerJoin(by, eq(by.id, transportAssignments.createdByUserId))
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, transportAssignments.studentId),
        eq(enrolments.termId, transportAssignments.termId),
      ),
    )
    .leftJoin(classes, eq(classes.id, enrolments.classId))
    .where(
      and(
        eq(transportAssignments.tenantId, tenantId),
        eq(transportAssignments.termId, termId),
        isNull(transportAssignments.endedAt),
        routeId ? eq(transportAssignments.routeId, routeId) : undefined,
      ),
    )
    .orderBy(
      asc(transportRoutes.name),
      asc(transportStops.sequence),
      asc(students.firstName),
      asc(students.lastName),
    );
  return rows.map((r) => ({
    id: r.a.id,
    studentId: r.a.studentId,
    student: fullName(r.s),
    admissionNumber: r.s.admissionNumber,
    className: r.className,
    routeId: r.a.routeId,
    route: r.route,
    stopId: r.a.stopId,
    stop: r.stop,
    stopSequence: r.stopSequence,
    morningTime: r.morningTime,
    afternoonTime: r.afternoonTime,
    direction: r.a.direction,
    farePesewas: fareFor(r.routeFare, r.stopFare),
    since: r.a.createdAt,
    by: r.by,
  }));
}

export async function listAssignments(
  database: Database,
  ctx: TenantContext,
  routeId?: string,
): Promise<{ termId: string | null; assignments: Assignment[] }> {
  if (!allowed(ctx, "transport.trips")) assertAllowed(ctx, "transport.view");
  if (routeId && !UUID.safeParse(routeId).success) return { termId: null, assignments: [] };
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx.tenant.id);
    return { termId, assignments: termId ? await readAssignments(tx, ctx.tenant.id, termId, routeId) : [] };
  });
}

/** Students at the school this term, with their class, for the assignment picker. */
export async function listAssignableStudents(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; name: string; className: string }[]> {
  assertAllowed(ctx, "transport.manage");
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
        ),
      )
      .orderBy(asc(classes.name), asc(students.firstName), asc(students.lastName));
    return rows.map((r) => ({ id: r.s.id, name: fullName(r.s), className: r.className }));
  });
}

/** Every active stop of every active route, for the assignment picker. */
export async function listStopChoices(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; routeId: string; route: string; name: string }[]> {
  assertAllowed(ctx, "transport.manage");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: transportStops.id,
        routeId: transportRoutes.id,
        route: transportRoutes.name,
        name: transportStops.name,
      })
      .from(transportStops)
      .innerJoin(transportRoutes, eq(transportRoutes.id, transportStops.routeId))
      .where(
        and(
          eq(transportStops.tenantId, ctx.tenant.id),
          eq(transportStops.status, "active"),
          eq(transportRoutes.status, "active"),
        ),
      )
      .orderBy(asc(transportRoutes.name), asc(transportStops.sequence)),
  );
}

const assignSchema = z.object({
  studentId: z.string({ message: "Choose a student." }).uuid("Choose a student."),
  stopId: z.string({ message: "Choose a stop." }).uuid("Choose a stop."),
  direction: z.enum(RIDE_DIRECTIONS, { message: "Choose which way they ride." }),
});

/**
 * Puts a student on a route and stop for the current term. A student already on a route is moved: the old
 * assignment is ended and kept. Billing picks it up; if the term is already billed, a different fare shows as
 * a difference for the Accountant (TRN-02b).
 */
export async function assignStudent(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "transport.manage");
  const data = assignSchema.parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx.tenant.id);
    if (!termId) throw new DomainError("no_term", "Set the current term first, in Settings, Calendar.");
    // One change per student at a time.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`transport:${data.studentId}:${termId}`}))`);
    const [enrolled] = await tx
      .select({ id: students.id })
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
    if (!enrolled)
      throw new DomainError("not_enrolled", "Choose a student in a class this term.", "studentId");
    const [stop] = await tx
      .select({ routeId: transportStops.routeId, stop: transportStops.name, route: transportRoutes.name })
      .from(transportStops)
      .innerJoin(transportRoutes, eq(transportRoutes.id, transportStops.routeId))
      .where(
        and(
          eq(transportStops.tenantId, ctx.tenant.id),
          eq(transportStops.id, data.stopId),
          eq(transportStops.status, "active"),
          eq(transportRoutes.status, "active"),
        ),
      );
    if (!stop) throw new DomainError("not_found", "Choose a stop on a route in use.", "stopId");
    const [open] = await tx
      .select()
      .from(transportAssignments)
      .where(
        and(
          eq(transportAssignments.tenantId, ctx.tenant.id),
          eq(transportAssignments.studentId, data.studentId),
          eq(transportAssignments.termId, termId),
          isNull(transportAssignments.endedAt),
        ),
      )
      .for("update");
    if (open?.stopId === data.stopId && open.direction === data.direction) return;
    if (open)
      await tx
        .update(transportAssignments)
        .set({ endedAt: new Date(), endedByUserId: ctx.userId })
        .where(eq(transportAssignments.id, open.id));
    await tx.insert(transportAssignments).values({
      tenantId: ctx.tenant.id,
      studentId: data.studentId,
      termId,
      routeId: stop.routeId,
      stopId: data.stopId,
      direction: data.direction,
      createdByUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: open ? "transport.student_moved" : "transport.student_assigned",
      entityType: "student",
      entityId: data.studentId,
      metadata: { route: stop.route, stop: stop.stop, direction: data.direction },
    });
  });
}

/** Takes a student off transport for the current term; the assignment is kept as ended. */
export async function endAssignment(
  database: Database,
  ctx: TenantContext,
  assignmentId: string,
): Promise<void> {
  assertAllowed(ctx, "transport.manage");
  if (!UUID.safeParse(assignmentId).success) throw new DomainError("not_found", "Not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(transportAssignments)
      .set({ endedAt: new Date(), endedByUserId: ctx.userId })
      .where(
        and(
          eq(transportAssignments.tenantId, ctx.tenant.id),
          eq(transportAssignments.id, assignmentId),
          isNull(transportAssignments.endedAt),
        ),
      )
      .returning({ studentId: transportAssignments.studentId });
    if (!row) throw new DomainError("not_found", "This student is no longer on that route.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "transport.student_removed",
      entityType: "student",
      entityId: row.studentId,
    });
  });
}
