import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parseMoney } from "../../lib/money";
import { normalizePhone } from "../../lib/phone";
import { TIME_OF_DAY } from "../../lib/transport";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Queryable, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  feeItems,
  terms,
  transportAssignments,
  transportRoutes,
  transportSettings,
  transportStops,
  transportVehicles,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Transport set-up (R4-5 TRN-01, TRN-02a; module transport): vehicles, routes and their stops, fares and the
 * school's transport choices. Nothing here is deleted: vehicles, routes and stops are archived. Fares are fees,
 * so they are set by those who manage fees; the charges themselves are made by the term's billing.
 */

const UUID = z.string().uuid();
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable().optional());
const optionalPhone = (country: string) =>
  z.preprocess(
    blank,
    z
      .string()
      .transform((v, c) => {
        const phone = normalizePhone(v, country);
        if (!phone) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
        return phone ?? "";
      })
      .nullable()
      .optional(),
  );
const optionalTime = z.preprocess(
  blank,
  z.string().regex(TIME_OF_DAY, "Use hours and minutes, e.g. 06:45.").nullable().optional(),
);

export const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const audit = (
  tx: Transaction,
  ctx: TenantContext,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, unknown>,
) =>
  recordAudit(tx, {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action,
    entityType,
    entityId,
    metadata,
  });

const nameTaken = (what: string) => (error: unknown) => {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
    throw new DomainError("name_taken", `There is already a ${what} with this name.`, "name");
  throw error;
};

// ——— Vehicles (TRN-01a) ———

export interface Vehicle {
  id: string;
  name: string;
  registration: string | null;
  seats: number | null;
  driverName: string | null;
  driverPhone: string | null;
  attendantName: string | null;
  attendantPhone: string | null;
  note: string | null;
  status: "active" | "archived";
}

const vehicleSchema = (country: string) =>
  z.object({
    name: z
      .string({ message: "Name the vehicle, e.g. Bus 1." })
      .trim()
      .min(1, "Name the vehicle, e.g. Bus 1.")
      .max(60, "Use 60 characters or fewer."),
    registration: optionalText(20),
    seats: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
      z.number().int("Use a whole number.").min(1, "Use 1 or more.").max(200, "Use 200 or fewer.").nullable(),
    ),
    driverName: optionalText(120),
    driverPhone: optionalPhone(country),
    attendantName: optionalText(120),
    attendantPhone: optionalPhone(country),
    note: optionalText(300),
  });

export async function listVehicles(database: Database, ctx: TenantContext): Promise<Vehicle[]> {
  if (!allowed(ctx, "transport.trips")) assertAllowed(ctx, "transport.view");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: transportVehicles.id,
        name: transportVehicles.name,
        registration: transportVehicles.registration,
        seats: transportVehicles.seats,
        driverName: transportVehicles.driverName,
        driverPhone: transportVehicles.driverPhone,
        attendantName: transportVehicles.attendantName,
        attendantPhone: transportVehicles.attendantPhone,
        note: transportVehicles.note,
        status: transportVehicles.status,
      })
      .from(transportVehicles)
      .where(eq(transportVehicles.tenantId, ctx.tenant.id))
      .orderBy(asc(transportVehicles.status), asc(transportVehicles.name)),
  );
}

/** Adds a vehicle, or changes one when `vehicleId` is given. */
export async function saveVehicle(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  vehicleId?: string,
): Promise<string> {
  assertAllowed(ctx, "transport.manage");
  const data = vehicleSchema(ctx.tenant.countryCode).parse(input);
  const values = {
    name: data.name,
    registration: data.registration ?? null,
    seats: data.seats,
    driverName: data.driverName ?? null,
    driverPhone: data.driverPhone || null,
    attendantName: data.attendantName ?? null,
    attendantPhone: data.attendantPhone || null,
    note: data.note ?? null,
  };
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (vehicleId) {
      if (!UUID.safeParse(vehicleId).success) throw new DomainError("not_found", "Vehicle not found.");
      const [row] = await tx
        .update(transportVehicles)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(transportVehicles.tenantId, ctx.tenant.id), eq(transportVehicles.id, vehicleId)))
        .returning({ id: transportVehicles.id });
      if (!row) throw new DomainError("not_found", "Vehicle not found.");
      // Field names only: phone numbers stay out of the audit log.
      await audit(tx, ctx, "transport.vehicle_changed", "transport_vehicle", row.id, { name: data.name });
      return row.id;
    }
    const [row] = await tx
      .insert(transportVehicles)
      .values({ tenantId: ctx.tenant.id, ...values })
      .returning({ id: transportVehicles.id });
    await audit(tx, ctx, "transport.vehicle_added", "transport_vehicle", row!.id, { name: data.name });
    return row!.id;
  }).catch(nameTaken("vehicle"));
}

export async function setVehicleArchived(
  database: Database,
  ctx: TenantContext,
  vehicleId: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "transport.manage");
  if (!UUID.safeParse(vehicleId).success) throw new DomainError("not_found", "Vehicle not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(transportVehicles)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(and(eq(transportVehicles.tenantId, ctx.tenant.id), eq(transportVehicles.id, vehicleId)))
      .returning({ id: transportVehicles.id });
    if (!row) throw new DomainError("not_found", "Vehicle not found.");
    await audit(
      tx,
      ctx,
      archived ? "transport.vehicle_archived" : "transport.vehicle_restored",
      "transport_vehicle",
      row.id,
    );
  });
}

// ——— Routes and stops (TRN-01b) ———

export interface Stop {
  id: string;
  name: string;
  sequence: number;
  morningTime: string | null;
  afternoonTime: string | null;
  farePesewas: number | null;
  status: "active" | "archived";
}

export interface RouteSummary {
  id: string;
  name: string;
  vehicleId: string | null;
  vehicle: string | null;
  farePesewas: number | null;
  status: "active" | "archived";
  stops: number;
  /** Students riding it this term. */
  riders: number;
}

async function currentTermId(tx: Queryable, tenantId: string): Promise<string | null> {
  const [term] = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.isCurrent, true)));
  return term?.id ?? null;
}

export async function listRoutes(database: Database, ctx: TenantContext): Promise<RouteSummary[]> {
  if (!allowed(ctx, "transport.trips")) assertAllowed(ctx, "transport.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx.tenant.id);
    return tx
      .select({
        id: transportRoutes.id,
        name: transportRoutes.name,
        vehicleId: transportRoutes.vehicleId,
        vehicle: transportVehicles.name,
        farePesewas: transportRoutes.farePesewas,
        status: transportRoutes.status,
        stops: sql<number>`(select count(*)::int from transport_stops s where s.route_id = ${transportRoutes.id} and s.status = 'active')`,
        riders: termId
          ? sql<number>`(select count(*)::int from transport_assignments a where a.route_id = ${transportRoutes.id} and a.term_id = ${termId} and a.ended_at is null)`
          : sql<number>`0`,
      })
      .from(transportRoutes)
      .leftJoin(transportVehicles, eq(transportVehicles.id, transportRoutes.vehicleId))
      .where(eq(transportRoutes.tenantId, ctx.tenant.id))
      .orderBy(asc(transportRoutes.status), asc(transportRoutes.name));
  });
}

const routeSchema = z.object({
  name: z
    .string({ message: "Name the route." })
    .trim()
    .min(1, "Name the route.")
    .max(60, "Use 60 characters or fewer."),
  vehicleId: z.preprocess(blank, UUID.nullable().optional()),
});

async function assertVehicle(tx: Transaction, ctx: TenantContext, vehicleId: string | null | undefined) {
  if (!vehicleId) return;
  const [v] = await tx
    .select({ id: transportVehicles.id })
    .from(transportVehicles)
    .where(
      and(
        eq(transportVehicles.tenantId, ctx.tenant.id),
        eq(transportVehicles.id, vehicleId),
        eq(transportVehicles.status, "active"),
      ),
    );
  if (!v) throw new DomainError("not_found", "Choose a vehicle in use.", "vehicleId");
}

/** Adds a route, or renames it and changes its vehicle when `routeId` is given. */
export async function saveRoute(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  routeId?: string,
): Promise<string> {
  assertAllowed(ctx, "transport.manage");
  const data = routeSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    await assertVehicle(tx, ctx, data.vehicleId);
    const values = { name: data.name, vehicleId: data.vehicleId ?? null };
    if (routeId) {
      if (!UUID.safeParse(routeId).success) throw new DomainError("not_found", "Route not found.");
      const [row] = await tx
        .update(transportRoutes)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(transportRoutes.tenantId, ctx.tenant.id), eq(transportRoutes.id, routeId)))
        .returning({ id: transportRoutes.id });
      if (!row) throw new DomainError("not_found", "Route not found.");
      await audit(tx, ctx, "transport.route_changed", "transport_route", row.id, values);
      return row.id;
    }
    const [row] = await tx
      .insert(transportRoutes)
      .values({ tenantId: ctx.tenant.id, ...values })
      .returning({ id: transportRoutes.id });
    await audit(tx, ctx, "transport.route_added", "transport_route", row!.id, values);
    return row!.id;
  }).catch(nameTaken("route"));
}

export async function setRouteArchived(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "transport.manage");
  if (!UUID.safeParse(routeId).success) throw new DomainError("not_found", "Route not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    if (archived) {
      const termId = await currentTermId(tx, ctx.tenant.id);
      const [riding] = termId
        ? await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(transportAssignments)
            .where(
              and(
                eq(transportAssignments.tenantId, ctx.tenant.id),
                eq(transportAssignments.routeId, routeId),
                eq(transportAssignments.termId, termId),
                sql`${transportAssignments.endedAt} is null`,
              ),
            )
        : [{ n: 0 }];
      if (riding!.n > 0)
        throw new DomainError(
          "route_in_use",
          `${riding!.n} ${riding!.n === 1 ? "student rides" : "students ride"} this route this term. Move them first.`,
        );
    }
    const [row] = await tx
      .update(transportRoutes)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(and(eq(transportRoutes.tenantId, ctx.tenant.id), eq(transportRoutes.id, routeId)))
      .returning({ id: transportRoutes.id });
    if (!row) throw new DomainError("not_found", "Route not found.");
    await audit(
      tx,
      ctx,
      archived ? "transport.route_archived" : "transport.route_restored",
      "transport_route",
      row.id,
    );
  });
}

export interface RouteDetail extends RouteSummary {
  stopList: Stop[];
}

export async function getRoute(
  database: Database,
  ctx: TenantContext,
  routeId: string,
): Promise<RouteDetail | null> {
  if (!allowed(ctx, "transport.trips")) assertAllowed(ctx, "transport.view");
  if (!UUID.safeParse(routeId).success) return null;
  const [summary] = (await listRoutes(database, ctx)).filter((r) => r.id === routeId);
  if (!summary) return null;
  const stopList = await withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: transportStops.id,
        name: transportStops.name,
        sequence: transportStops.sequence,
        morningTime: transportStops.morningTime,
        afternoonTime: transportStops.afternoonTime,
        farePesewas: transportStops.farePesewas,
        status: transportStops.status,
      })
      .from(transportStops)
      .where(and(eq(transportStops.tenantId, ctx.tenant.id), eq(transportStops.routeId, routeId)))
      .orderBy(asc(transportStops.status), asc(transportStops.sequence), asc(transportStops.name)),
  );
  return { ...summary, stopList };
}

const stopSchema = z.object({
  name: z
    .string({ message: "Name the stop." })
    .trim()
    .min(1, "Name the stop.")
    .max(80, "Use 80 characters or fewer."),
  sequence: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int("Use a whole number.").min(1, "Use 1 or more.").max(200, "Use 200 or fewer.").nullable(),
  ),
  morningTime: optionalTime,
  afternoonTime: optionalTime,
});

/** Adds a stop to a route (at the end unless placed), or changes one when `stopId` is given. */
export async function saveStop(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  input: Record<string, unknown>,
  stopId?: string,
): Promise<string> {
  assertAllowed(ctx, "transport.manage");
  const data = stopSchema.parse(input);
  if (!UUID.safeParse(routeId).success) throw new DomainError("not_found", "Route not found.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [route] = await tx
      .select({ id: transportRoutes.id })
      .from(transportRoutes)
      .where(and(eq(transportRoutes.tenantId, ctx.tenant.id), eq(transportRoutes.id, routeId)))
      .for("update");
    if (!route) throw new DomainError("not_found", "Route not found.");
    const values = {
      name: data.name,
      morningTime: data.morningTime ?? null,
      afternoonTime: data.afternoonTime ?? null,
    };
    if (stopId) {
      if (!UUID.safeParse(stopId).success) throw new DomainError("not_found", "Stop not found.");
      const [row] = await tx
        .update(transportStops)
        .set({ ...values, ...(data.sequence ? { sequence: data.sequence } : {}), updatedAt: new Date() })
        .where(
          and(
            eq(transportStops.tenantId, ctx.tenant.id),
            eq(transportStops.routeId, routeId),
            eq(transportStops.id, stopId),
          ),
        )
        .returning({ id: transportStops.id });
      if (!row) throw new DomainError("not_found", "Stop not found.");
      await audit(tx, ctx, "transport.stop_changed", "transport_route", routeId, { stop: data.name });
      return row.id;
    }
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${transportStops.sequence}), 0)::int` })
      .from(transportStops)
      .where(and(eq(transportStops.tenantId, ctx.tenant.id), eq(transportStops.routeId, routeId)));
    const [row] = await tx
      .insert(transportStops)
      .values({ tenantId: ctx.tenant.id, routeId, sequence: data.sequence ?? last!.n + 1, ...values })
      .returning({ id: transportStops.id });
    await audit(tx, ctx, "transport.stop_added", "transport_route", routeId, { stop: data.name });
    return row!.id;
  });
}

export async function setStopArchived(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  stopId: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "transport.manage");
  if (!UUID.safeParse(stopId).success || !UUID.safeParse(routeId).success)
    throw new DomainError("not_found", "Stop not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    if (archived) {
      const termId = await currentTermId(tx, ctx.tenant.id);
      const [riding] = termId
        ? await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(transportAssignments)
            .where(
              and(
                eq(transportAssignments.tenantId, ctx.tenant.id),
                eq(transportAssignments.stopId, stopId),
                eq(transportAssignments.termId, termId),
                sql`${transportAssignments.endedAt} is null`,
              ),
            )
        : [{ n: 0 }];
      if (riding!.n > 0)
        throw new DomainError(
          "stop_in_use",
          `${riding!.n} ${riding!.n === 1 ? "student uses" : "students use"} this stop this term. Move them first.`,
        );
    }
    const [row] = await tx
      .update(transportStops)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(
        and(
          eq(transportStops.tenantId, ctx.tenant.id),
          eq(transportStops.routeId, routeId),
          eq(transportStops.id, stopId),
        ),
      )
      .returning({ name: transportStops.name });
    if (!row) throw new DomainError("not_found", "Stop not found.");
    await audit(
      tx,
      ctx,
      archived ? "transport.stop_archived" : "transport.stop_restored",
      "transport_route",
      routeId,
      {
        stop: row.name,
      },
    );
  });
}

// ——— Fares (TRN-02a) ———

const fare = (currency: string) =>
  z.preprocess(blank, z.string().nullable().optional()).transform((v, c) => {
    if (v === null || v === undefined) return null;
    const minor = parseMoney(v, currency);
    if (minor === null || minor < 0) {
      c.addIssue({ code: "custom", message: "Enter an amount, e.g. 450.00." });
      return z.NEVER;
    }
    return minor;
  });

/** The fare per term for a route (blank: none), and per stop where it differs (blank: the route's). */
export async function setFares(
  database: Database,
  ctx: TenantContext,
  routeId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "fees.manage");
  assertAllowed(ctx, "transport.view");
  if (!UUID.safeParse(routeId).success) throw new DomainError("not_found", "Route not found.");
  const currency = ctx.tenant.currencyCode;
  const routeFare = fare(currency).safeParse(input.fare);
  if (!routeFare.success) throw new DomainError("invalid_amount", "Enter an amount, e.g. 450.00.", "fare");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [route] = await tx
      .update(transportRoutes)
      .set({ farePesewas: routeFare.data, updatedAt: new Date() })
      .where(and(eq(transportRoutes.tenantId, ctx.tenant.id), eq(transportRoutes.id, routeId)))
      .returning({ id: transportRoutes.id });
    if (!route) throw new DomainError("not_found", "Route not found.");
    const stops = await tx
      .select({ id: transportStops.id, name: transportStops.name })
      .from(transportStops)
      .where(and(eq(transportStops.tenantId, ctx.tenant.id), eq(transportStops.routeId, routeId)));
    const changes: Record<string, number | null> = { route: routeFare.data };
    for (const stop of stops) {
      const key = `stop:${stop.id}`;
      if (!(key in input)) continue;
      const parsed = fare(currency).safeParse(input[key]);
      if (!parsed.success) throw new DomainError("invalid_amount", "Enter an amount, e.g. 450.00.", key);
      await tx
        .update(transportStops)
        .set({ farePesewas: parsed.data, updatedAt: new Date() })
        .where(eq(transportStops.id, stop.id));
      changes[stop.name] = parsed.data;
    }
    await audit(tx, ctx, "transport.fares_set", "transport_route", routeId, { fares: changes, currency });
  });
}

// ——— Settings ———

export interface TransportSettings {
  feeItemId: string | null;
  notifyFamilies: boolean;
  /** Optional fee items the school can choose as transport. */
  optionalItems: { id: string; name: string }[];
}

export async function readTransportSettings(tx: Queryable, tenantId: string) {
  const [row] = await tx
    .select({ feeItemId: transportSettings.feeItemId, notifyFamilies: transportSettings.notifyFamilies })
    .from(transportSettings)
    .where(eq(transportSettings.tenantId, tenantId));
  return row ?? { feeItemId: null, notifyFamilies: true };
}

export async function getTransportSettings(
  database: Database,
  ctx: TenantContext,
): Promise<TransportSettings> {
  assertAllowed(ctx, "transport.view");
  return withTenant(database, scopeOf(ctx), async (tx) => ({
    ...(await readTransportSettings(tx, ctx.tenant.id)),
    optionalItems: await tx
      .select({ id: feeItems.id, name: feeItems.name })
      .from(feeItems)
      .where(
        and(eq(feeItems.tenantId, ctx.tenant.id), eq(feeItems.optional, true), eq(feeItems.status, "active")),
      )
      .orderBy(asc(feeItems.sequence)),
  }));
}

/** Which optional fee item transport is billed as (TRN-02a); for those who manage fees. */
export async function setTransportFeeItem(
  database: Database,
  ctx: TenantContext,
  feeItemIdInput: unknown,
): Promise<void> {
  assertAllowed(ctx, "fees.manage");
  assertAllowed(ctx, "transport.view");
  const parsed = z.preprocess(blank, UUID.nullable()).safeParse(feeItemIdInput ?? null);
  if (!parsed.success) throw new DomainError("not_found", "Choose an optional fee item.", "feeItemId");
  const feeItemId = parsed.data;
  await withTenant(database, scopeOf(ctx), async (tx) => {
    let name: string | null = null;
    if (feeItemId) {
      const [item] = await tx
        .select({ name: feeItems.name })
        .from(feeItems)
        .where(
          and(
            eq(feeItems.tenantId, ctx.tenant.id),
            eq(feeItems.id, feeItemId),
            eq(feeItems.optional, true),
            eq(feeItems.status, "active"),
          ),
        );
      if (!item) throw new DomainError("not_optional", "Choose an optional fee item.", "feeItemId");
      name = item.name;
    }
    const values = { feeItemId, updatedByUserId: ctx.userId, updatedAt: new Date() };
    await tx
      .insert(transportSettings)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: transportSettings.tenantId, set: values });
    await audit(tx, ctx, "transport.fee_item_set", "tenant", ctx.tenant.id, { item: name });
  });
}

export async function setNotifyFamilies(
  database: Database,
  ctx: TenantContext,
  notify: boolean,
): Promise<void> {
  assertAllowed(ctx, "transport.manage");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const values = { notifyFamilies: notify, updatedByUserId: ctx.userId, updatedAt: new Date() };
    await tx
      .insert(transportSettings)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: transportSettings.tenantId, set: values });
    await audit(tx, ctx, "transport.notifications_set", "tenant", ctx.tenant.id, { notify });
  });
}

export { currentTermId };
