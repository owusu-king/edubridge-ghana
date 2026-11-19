import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import {
  ridesOn,
  TRIP_DIRECTIONS,
  tripState,
  type RideDirection,
  type TripDirection,
  type TripState,
} from "../../lib/transport";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  guardians,
  studentGuardians,
  transportAssignments,
  transportRoutes,
  transportStops,
  transportTripMarks,
  transportTrips,
  transportVehicles,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { enqueue } from "../notifications/outbox";
import { pushSubscriptionsFor } from "../parents/push";
import type { TenantContext } from "../tenancy/service";
import { readAssignments } from "./assignments";
import { currentTermId, readTransportSettings, scopeOf } from "./setup";

/**
 * Trips (R4-5 TRN-03): staff on the bus mark each child boarded and, later, got off, for a route, today and a
 * direction. Each mark is made once and never changed (database). Families get a push notification that says
 * only that there is a bus update (TRN-03b); the parent view shows what happened. No location is recorded.
 */

const UUID = z.string().uuid();

export interface TripRider {
  studentId: string;
  name: string;
  className: string | null;
  stop: string;
  time: string | null;
  ride: RideDirection;
  state: TripState;
  boardedAt: Date | null;
  leftAt: Date | null;
  markedBy: string | null;
}

export interface TripView {
  routeId: string;
  route: string;
  vehicle: string | null;
  driver: string | null;
  date: string;
  direction: TripDirection;
  riders: TripRider[];
}

const direction = (value: string): TripDirection => {
  if (!(TRIP_DIRECTIONS as readonly string[]).includes(value))
    throw new DomainError("not_found", "Choose morning or afternoon.");
  return value as TripDirection;
};

async function loadRoute(tx: Transaction, ctx: TenantContext, routeId: string) {
  if (!UUID.safeParse(routeId).success) throw new DomainError("not_found", "Route not found.");
  const [route] = await tx
    .select({
      id: transportRoutes.id,
      name: transportRoutes.name,
      vehicleId: transportRoutes.vehicleId,
      vehicle: transportVehicles.name,
      driver: transportVehicles.driverName,
    })
    .from(transportRoutes)
    .leftJoin(transportVehicles, eq(transportVehicles.id, transportRoutes.vehicleId))
    .where(
      and(
        eq(transportRoutes.tenantId, ctx.tenant.id),
        eq(transportRoutes.id, routeId),
        eq(transportRoutes.status, "active"),
      ),
    );
  if (!route) throw new DomainError("not_found", "Route not found.");
  return route;
}

/** Today's run of a route in one direction: who rides it and what has been marked. */
export async function getTrip(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  dir: string,
): Promise<TripView> {
  assertAllowed(ctx, "transport.trips");
  const tripDirection = direction(dir);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const route = await loadRoute(tx, ctx, routeId);
    const date = todayIn(ctx.tenant.timezone);
    const termId = await currentTermId(tx, ctx.tenant.id);
    const riders = termId
      ? (await readAssignments(tx, ctx.tenant.id, termId, route.id)).filter((a) =>
          ridesOn(a.direction, tripDirection),
        )
      : [];
    const by = alias(users, "boarded_by");
    const marks = await tx
      .select({ m: transportTripMarks, by: by.name })
      .from(transportTripMarks)
      .innerJoin(transportTrips, eq(transportTrips.id, transportTripMarks.tripId))
      .innerJoin(by, eq(by.id, transportTripMarks.boardedByUserId))
      .where(
        and(
          eq(transportTrips.tenantId, ctx.tenant.id),
          eq(transportTrips.routeId, route.id),
          eq(transportTrips.onDate, date),
          eq(transportTrips.direction, tripDirection),
        ),
      );
    const byStudent = new Map(marks.map((m) => [m.m.studentId, m]));
    return {
      routeId: route.id,
      route: route.name,
      vehicle: route.vehicle,
      driver: route.driver,
      date,
      direction: tripDirection,
      riders: riders.map((a) => {
        const mark = byStudent.get(a.studentId);
        return {
          studentId: a.studentId,
          name: a.student,
          className: a.className,
          stop: a.stop,
          time: tripDirection === "to_school" ? a.morningTime : a.afternoonTime,
          ride: a.direction,
          state: tripState(mark ? { boardedAt: mark.m.boardedAt, leftAt: mark.m.leftAt } : undefined),
          boardedAt: mark?.m.boardedAt ?? null,
          leftAt: mark?.m.leftAt ?? null,
          markedBy: mark?.by ?? null,
        };
      }),
    };
  });
}

/** Tells the child's families' phones (notifications on) that there is a bus update, if the school wants it. */
async function notify(tx: Transaction, ctx: TenantContext, studentId: string, key: string) {
  if (ctx.tenant.isDemo) return;
  const settings = await readTransportSettings(tx, ctx.tenant.id);
  if (!settings.notifyFamilies) return;
  const phones = (
    await tx
      .select({ phone: guardians.phone })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenant.id),
          eq(studentGuardians.studentId, studentId),
          isNull(guardians.portalBlockedAt),
        ),
      )
  )
    .map((g) => g.phone)
    .filter((p): p is string => !!p);
  for (const device of await pushSubscriptionsFor(tx, phones))
    await enqueue(tx, {
      channel: "push",
      recipient: device.id,
      template: "transport_push",
      payload: { schoolName: ctx.tenant.name, schoolSlug: ctx.tenant.slug, studentId },
      idempotencyKey: `${key}:${device.id}`,
    });
}

/** The child must ride this route, this way, this term. */
async function assertRider(
  tx: Transaction,
  ctx: TenantContext,
  routeId: string,
  tripDirection: TripDirection,
  studentId: string,
) {
  if (!UUID.safeParse(studentId).success) throw new DomainError("not_found", "Student not found.");
  const termId = await currentTermId(tx, ctx.tenant.id);
  const [a] = termId
    ? await tx
        .select({ stopId: transportAssignments.stopId, direction: transportAssignments.direction })
        .from(transportAssignments)
        .where(
          and(
            eq(transportAssignments.tenantId, ctx.tenant.id),
            eq(transportAssignments.termId, termId),
            eq(transportAssignments.routeId, routeId),
            eq(transportAssignments.studentId, studentId),
            isNull(transportAssignments.endedAt),
          ),
        )
    : [];
  if (!a || !ridesOn(a.direction, tripDirection))
    throw new DomainError("not_on_route", "This child does not ride this route this way. Ask the office.");
  return a;
}

/** Marks a child boarded (once), starting the day's trip if it is the first mark. */
export async function markBoarded(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  dir: string,
  studentId: string,
): Promise<void> {
  assertAllowed(ctx, "transport.trips");
  const tripDirection = direction(dir);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const route = await loadRoute(tx, ctx, routeId);
    const rider = await assertRider(tx, ctx, route.id, tripDirection, studentId);
    const onDate = todayIn(ctx.tenant.timezone);
    await tx
      .insert(transportTrips)
      .values({
        tenantId: ctx.tenant.id,
        routeId: route.id,
        onDate,
        direction: tripDirection,
        vehicleId: route.vehicleId,
        startedByUserId: ctx.userId,
      })
      .onConflictDoNothing();
    const [trip] = await tx
      .select({ id: transportTrips.id })
      .from(transportTrips)
      .where(
        and(
          eq(transportTrips.tenantId, ctx.tenant.id),
          eq(transportTrips.routeId, route.id),
          eq(transportTrips.onDate, onDate),
          eq(transportTrips.direction, tripDirection),
        ),
      );
    const inserted = await tx
      .insert(transportTripMarks)
      .values({
        tenantId: ctx.tenant.id,
        tripId: trip!.id,
        studentId,
        stopId: rider.stopId,
        boardedByUserId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ studentId: transportTripMarks.studentId });
    if (!inserted.length) throw new DomainError("already_marked", "Already marked as on the bus.");
    await notify(tx, ctx, studentId, `trip:${trip!.id}:${studentId}:boarded`);
  });
}

/** Marks a child off the bus (once), at school in the morning or at their stop in the afternoon. */
export async function markLeft(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  dir: string,
  studentId: string,
): Promise<void> {
  assertAllowed(ctx, "transport.trips");
  const tripDirection = direction(dir);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const route = await loadRoute(tx, ctx, routeId);
    await assertRider(tx, ctx, route.id, tripDirection, studentId);
    const onDate = todayIn(ctx.tenant.timezone);
    const [trip] = await tx
      .select({ id: transportTrips.id })
      .from(transportTrips)
      .where(
        and(
          eq(transportTrips.tenantId, ctx.tenant.id),
          eq(transportTrips.routeId, route.id),
          eq(transportTrips.onDate, onDate),
          eq(transportTrips.direction, tripDirection),
        ),
      );
    const updated = trip
      ? await tx
          .update(transportTripMarks)
          .set({ leftAt: new Date(), leftByUserId: ctx.userId })
          .where(
            and(
              eq(transportTripMarks.tripId, trip.id),
              eq(transportTripMarks.studentId, studentId),
              isNull(transportTripMarks.leftAt),
            ),
          )
          .returning({ studentId: transportTripMarks.studentId })
      : [];
    if (!updated.length)
      throw new DomainError("not_on_board", "Mark the child as on the bus first, or they are already off.");
    await notify(tx, ctx, studentId, `trip:${trip!.id}:${studentId}:left`);
  });
}

// ——— The parent view (TRN-03b) ———

export interface ParentTransport {
  route: string;
  stop: string;
  morningTime: string | null;
  afternoonTime: string | null;
  ride: RideDirection;
  /** Today's runs with any mark, morning first. */
  today: { direction: TripDirection; boardedAt: Date; leftAt: Date | null }[];
}

/** A child's route and today's trips, for the parent view (no user: the tenant transaction is the parent's). */
export async function readParentTransport(
  tx: Transaction,
  tenantId: string,
  studentId: string,
  today: string,
): Promise<ParentTransport | null> {
  const termId = await currentTermId(tx, tenantId);
  if (!termId) return null;
  const [a] = await tx
    .select({
      route: transportRoutes.name,
      stop: transportStops.name,
      morningTime: transportStops.morningTime,
      afternoonTime: transportStops.afternoonTime,
      ride: transportAssignments.direction,
    })
    .from(transportAssignments)
    .innerJoin(transportRoutes, eq(transportRoutes.id, transportAssignments.routeId))
    .innerJoin(transportStops, eq(transportStops.id, transportAssignments.stopId))
    .where(
      and(
        eq(transportAssignments.tenantId, tenantId),
        eq(transportAssignments.termId, termId),
        eq(transportAssignments.studentId, studentId),
        isNull(transportAssignments.endedAt),
      ),
    );
  if (!a) return null;
  const marks = await tx
    .select({
      direction: transportTrips.direction,
      boardedAt: transportTripMarks.boardedAt,
      leftAt: transportTripMarks.leftAt,
    })
    .from(transportTripMarks)
    .innerJoin(transportTrips, eq(transportTrips.id, transportTripMarks.tripId))
    .where(
      and(
        eq(transportTripMarks.tenantId, tenantId),
        eq(transportTripMarks.studentId, studentId),
        eq(transportTrips.onDate, today),
      ),
    )
    .orderBy(desc(sql`${transportTrips.direction} = 'to_school'`), asc(transportTripMarks.boardedAt));
  return { ...a, today: marks };
}

/** Recent trips of the school (newest first), for staff: route, day, direction and how many boarded. */
export async function listRecentTrips(database: Database, ctx: TenantContext, limit = 30) {
  assertAllowed(ctx, "transport.view");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: transportTrips.id,
        route: transportRoutes.name,
        onDate: transportTrips.onDate,
        direction: transportTrips.direction,
        boarded: sql<number>`(select count(*)::int from transport_trip_marks m where m.trip_id = ${transportTrips.id})`,
        off: sql<number>`(select count(*)::int from transport_trip_marks m where m.trip_id = ${transportTrips.id} and m.left_at is not null)`,
      })
      .from(transportTrips)
      .innerJoin(transportRoutes, eq(transportRoutes.id, transportTrips.routeId))
      .where(eq(transportTrips.tenantId, ctx.tenant.id))
      .orderBy(desc(transportTrips.onDate), asc(transportRoutes.name), asc(transportTrips.direction))
      .limit(limit),
  );
}
