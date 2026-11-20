import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listAssignments } from "@/server/transport/assignments";
import { getRoute, listVehicles } from "@/server/transport/setup";
import { formatMoney, minorToInput } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { RIDE_DIRECTION_LABELS, fareFor } from "@/lib/transport";
import { requireTenant } from "@/web/auth";
import {
  saveRouteAction,
  saveStopAction,
  setFaresAction,
  setRouteArchivedAction,
  setStopArchivedAction,
} from "../../actions";
import { FaresForm, RouteDialog, StopDialog } from "../../transport-controls";

export const metadata: Metadata = { title: "Transport · Route" };

/** One route: its stops in order with times and fares, and who rides it this term. */
export default async function TransportRoutePage({
  params,
}: {
  params: Promise<{ school: string; routeId: string }>;
}) {
  const { school, routeId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transport.view")) notFound();
  const route = await getRoute(db(), ctx, routeId);
  if (!route) notFound();
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const manage = allowed(ctx, "transport.manage");
  const fares = allowed(ctx, "fees.manage");
  const [vehicles, { assignments }] = await Promise.all([
    manage ? listVehicles(db(), ctx) : Promise.resolve([]),
    listAssignments(db(), ctx, route.id),
  ]);
  const stops = route.stopList.filter((s) => s.status === "active");
  const archivedStops = route.stopList.filter((s) => s.status === "archived");

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "transport")}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Routes
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">{route.name}</h2>
          <p className="mt-1 text-base text-ink-2">
            {[
              route.vehicle ?? "No vehicle chosen",
              `${route.riders} ${route.riders === 1 ? "student" : "students"} this term`,
              route.status === "archived" && "archived",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap items-center gap-2">
            <RouteDialog
              action={saveRouteAction.bind(null, slug, route.id)}
              vehicles={vehicles.filter((v) => v.status === "active" || v.id === route.vehicleId)}
              route={{ name: route.name, vehicleId: route.vehicleId }}
            />
            <ActionButton
              action={setRouteArchivedAction.bind(null, slug, route.id, route.status === "active")}
              label={route.status === "active" ? "Archive" : "Restore"}
              variant={route.status === "active" ? "danger-outline" : "secondary"}
              ariaLabel={`${route.status === "active" ? "Archive" : "Restore"} ${route.name}`}
            />
          </div>
        )}
      </div>

      <Section
        title="Stops"
        description="In the order the bus passes them in the morning."
        aside={manage ? <StopDialog action={saveStopAction.bind(null, slug, route.id, null)} /> : undefined}
      >
        {stops.length === 0 ? (
          <p className="text-base text-ink-3">No stops yet. Students are put on a stop, so add one first.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Stops on {route.name}</caption>
              <THead>
                <tr>
                  <TH className="w-10">#</TH>
                  <TH>Stop</TH>
                  <TH>Morning</TH>
                  <TH>Afternoon</TH>
                  <TH className="hidden text-right sm:table-cell">Fare</TH>
                  {manage && (
                    <TH>
                      <span className="sr-only">Change</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {stops.map((s) => {
                  const fare = fareFor(route.farePesewas, s.farePesewas);
                  return (
                    <TR key={s.id}>
                      <TD className="text-ink-3 tabular-nums">{s.sequence}</TD>
                      <TD className="font-medium text-ink">{s.name}</TD>
                      <TD className="tabular-nums">{s.morningTime ?? "—"}</TD>
                      <TD className="tabular-nums">{s.afternoonTime ?? "—"}</TD>
                      <TD className="hidden text-right tabular-nums sm:table-cell">
                        {fare === null ? (
                          <span className="text-ink-3">Not set</span>
                        ) : (
                          formatMoney(fare, currency)
                        )}
                      </TD>
                      {manage && (
                        <TD className="text-right">
                          <div className="inline-flex flex-wrap justify-end gap-2">
                            <StopDialog action={saveStopAction.bind(null, slug, route.id, s.id)} stop={s} />
                            <ActionButton
                              action={setStopArchivedAction.bind(null, slug, route.id, s.id, true)}
                              label="Archive"
                              variant="danger-outline"
                              ariaLabel={`Archive ${s.name}`}
                            />
                          </div>
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableFrame>
        )}
        {archivedStops.length > 0 && (
          <ul className="space-y-2 text-sm text-ink-3">
            {archivedStops.map((s) => (
              <li key={s.id} className="flex items-center gap-3">
                <span>Archived: {s.name}</span>
                {manage && (
                  <ActionButton
                    action={setStopArchivedAction.bind(null, slug, route.id, s.id, false)}
                    label="Restore"
                    ariaLabel={`Restore ${s.name}`}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {fares && (
        <Section
          title="Fares"
          description="Per term. A new fare applies to students not yet billed; billed students show as differences under Fees, Billing."
        >
          <FaresForm
            action={setFaresAction.bind(null, slug, route.id)}
            currency={currency}
            routeFare={minorToInput(route.farePesewas, currency)}
            stops={stops.map((s) => ({
              id: s.id,
              name: s.name,
              fare: minorToInput(s.farePesewas, currency),
            }))}
          />
        </Section>
      )}

      <Section title="Students this term">
        {assignments.length === 0 ? (
          <p className="text-base text-ink-3">Nobody yet. Put students on a stop under Students.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {assignments.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2.5 text-base">
                <span className="text-ink">
                  {a.student}
                  <span className="block text-sm text-ink-3">{a.className ?? "No class this term"}</span>
                </span>
                <span className="text-right text-sm text-ink-2">
                  {a.stop}
                  <span className="block text-ink-3">{RIDE_DIRECTION_LABELS[a.direction]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
