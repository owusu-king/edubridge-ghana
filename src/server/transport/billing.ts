import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { fareFor } from "../../lib/transport";
import type { Queryable } from "../db/client";
import { transportAssignments, transportRoutes, transportStops } from "../db/schema";
import type { TenantContext } from "../tenancy/service";
import { readTransportSettings } from "./setup";

/** What term billing charges for transport (TRN-02b): the transport fee item and each assigned student's fare. */
export interface TransportCharges {
  feeItemId: string;
  /** Student → fare for the term, in minor units. Students not here are not charged the item. */
  fares: Map<string, number>;
}

/**
 * The transport item and fares for a term, or null when the school does not use Transport for fees (module not
 * active, or no transport fee item chosen): then the item is billed like any optional item.
 */
export async function readTransportCharges(
  tx: Queryable,
  ctx: Pick<TenantContext, "tenant" | "features">,
  termId: string,
): Promise<TransportCharges | null> {
  if (!ctx.features.includes("transport")) return null;
  const { feeItemId } = await readTransportSettings(tx, ctx.tenant.id);
  if (!feeItemId) return null;
  const rows = await tx
    .select({
      studentId: transportAssignments.studentId,
      routeFare: transportRoutes.farePesewas,
      stopFare: transportStops.farePesewas,
    })
    .from(transportAssignments)
    .innerJoin(transportRoutes, eq(transportRoutes.id, transportAssignments.routeId))
    .innerJoin(transportStops, eq(transportStops.id, transportAssignments.stopId))
    .where(
      and(
        eq(transportAssignments.tenantId, ctx.tenant.id),
        eq(transportAssignments.termId, termId),
        isNull(transportAssignments.endedAt),
      ),
    );
  const fares = new Map<string, number>();
  for (const r of rows) {
    const fare = fareFor(r.routeFare, r.stopFare);
    if (fare && fare > 0) fares.set(r.studentId, fare);
  }
  return { feeItemId, fares };
}

/** The transport fee item while Transport sets who pays it (students choose it there, not on their fee page). */
export async function transportFeeItemId(
  tx: Queryable,
  ctx: Pick<TenantContext, "tenant" | "features">,
): Promise<string | null> {
  if (!ctx.features.includes("transport")) return null;
  return (await readTransportSettings(tx, ctx.tenant.id)).feeItemId;
}
