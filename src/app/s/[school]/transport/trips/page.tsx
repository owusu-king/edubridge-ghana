import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Bus } from "lucide-react";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listRoutes } from "@/server/transport/setup";
import { getTrip, listRecentTrips } from "@/server/transport/trips";
import { formatCalendarDate, formatTime } from "@/lib/format";
import { directionAt, TRIP_DIRECTIONS, TRIP_DIRECTION_LABELS, type TripDirection } from "@/lib/transport";
import { requireTenant } from "@/web/auth";
import { markBoardedAction, markLeftAction } from "../actions";

export const metadata: Metadata = { title: "Transport · Trips" };

/** Today's run of a route (TRN-03a): mark each child on the bus, then off it. */
export default async function TransportTripsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ route?: string; direction?: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transport.trips")) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const routes = (await listRoutes(db(), ctx)).filter((r) => r.status === "active");
  const asked = await searchParams;
  const routeId = routes.some((r) => r.id === asked.route) ? asked.route! : (routes[0]?.id ?? null);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()),
  );
  const direction: TripDirection = (TRIP_DIRECTIONS as readonly string[]).includes(asked.direction ?? "")
    ? (asked.direction as TripDirection)
    : directionAt(hour);
  const [trip, recent] = await Promise.all([
    routeId ? getTrip(db(), ctx, routeId, direction) : null,
    allowed(ctx, "transport.view") ? listRecentTrips(db(), ctx, 10) : Promise.resolve([]),
  ]);
  const onBoard = trip?.riders.filter((r) => r.state === "on_board").length ?? 0;
  const off = trip?.riders.filter((r) => r.state === "off").length ?? 0;
  const offLabel = direction === "to_school" ? "At school" : "Got off";

  return (
    <div className="space-y-10">
      {routes.length === 0 || !trip ? (
        <EmptyState
          icon={<Bus />}
          title="No routes"
          description="Routes appear here once the office has set them up."
        />
      ) : (
        <Section
          title={`${trip.route} · ${TRIP_DIRECTION_LABELS[trip.direction]}`}
          description={[
            formatCalendarDate(trip.date),
            trip.vehicle && `${trip.vehicle}${trip.driver ? `, ${trip.driver}` : ""}`,
            `${onBoard} on the bus, ${off} ${direction === "to_school" ? "at school" : "off"}, of ${trip.riders.length}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Choose trip">
            <div className="space-y-1.5">
              <label htmlFor="trip-route" className="block text-sm font-medium text-ink">
                Route
              </label>
              <Select id="trip-route" name="route" defaultValue={routeId!} className="w-52">
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="trip-direction" className="block text-sm font-medium text-ink">
                Trip
              </label>
              <Select id="trip-direction" name="direction" defaultValue={direction} className="w-52">
                {TRIP_DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {TRIP_DIRECTION_LABELS[d]}
                  </option>
                ))}
              </Select>
            </div>
            <button type="submit" className={buttonStyles("secondary")}>
              Show
            </button>
          </form>
          {trip.riders.length === 0 ? (
            <p className="text-base text-ink-3">Nobody rides this route this way this term.</p>
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">Children on this trip</caption>
                <THead>
                  <tr>
                    <TH>Child</TH>
                    <TH>Now</TH>
                    <TH>
                      <span className="sr-only">Mark</span>
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {trip.riders.map((r) => (
                    <TR key={r.studentId}>
                      <TD>
                        <span className="font-medium text-ink">{r.name}</span>
                        <span className="block text-sm text-ink-3">
                          {[r.stop, r.time, r.className].filter(Boolean).join(" · ")}
                        </span>
                      </TD>
                      <TD>
                        {r.state === "waiting" && <span className="text-ink-3">Not on yet</span>}
                        {r.state === "on_board" && (
                          <>
                            <StatusText tone="caution">On the bus</StatusText>
                            <span className="block text-sm text-ink-3">
                              since {formatTime(r.boardedAt!, tz)}
                            </span>
                          </>
                        )}
                        {r.state === "off" && (
                          <>
                            <StatusText tone="positive">{offLabel}</StatusText>
                            <span className="block text-sm text-ink-3">{formatTime(r.leftAt!, tz)}</span>
                          </>
                        )}
                      </TD>
                      <TD className="text-right">
                        {r.state === "waiting" && (
                          <ActionButton
                            action={markBoardedAction.bind(
                              null,
                              slug,
                              trip.routeId,
                              trip.direction,
                              r.studentId,
                            )}
                            label="On the bus"
                            ariaLabel={`${r.name} is on the bus`}
                            variant="primary"
                          />
                        )}
                        {r.state === "on_board" && (
                          <ActionButton
                            action={markLeftAction.bind(
                              null,
                              slug,
                              trip.routeId,
                              trip.direction,
                              r.studentId,
                            )}
                            label={direction === "to_school" ? "At school" : "Got off"}
                            ariaLabel={`${r.name} ${direction === "to_school" ? "is at school" : "got off"}`}
                          />
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
          <p className="text-sm text-ink-3">
            Each mark is kept as made and tells the child&apos;s family, if the school has it on. Mark
            carefully.
          </p>
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Recent trips">
          <ul className="divide-y divide-line border-y border-line">
            {recent.map((t) => (
              <li key={t.id} className="flex flex-wrap justify-between gap-2 py-2.5 text-base text-ink">
                <span>
                  {t.route} · {TRIP_DIRECTION_LABELS[t.direction]}
                  <span className="block text-sm text-ink-3">{formatCalendarDate(t.onDate)}</span>
                </span>
                <span className="text-sm text-ink-2 tabular-nums">
                  {t.boarded} on, {t.off} off
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
