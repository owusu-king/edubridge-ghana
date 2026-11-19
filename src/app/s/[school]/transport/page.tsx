import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bus } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getTransportSettings, listRoutes, listVehicles } from "@/server/transport/setup";
import { formatMoney } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveRouteAction } from "./actions";
import { RouteDialog } from "./transport-controls";

export const metadata: Metadata = { title: "Transport" };

/** The school's bus routes (TRN-01b): vehicle, stops, who rides this term and the fare. */
export default async function TransportRoutesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transport.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "transport.manage");
  const [routes, vehicles, settings] = await Promise.all([
    listRoutes(db(), ctx),
    listVehicles(db(), ctx),
    getTransportSettings(db(), ctx),
  ]);
  const active = vehicles.filter((v) => v.status === "active");

  return (
    <Section
      title="Routes"
      description={
        settings.feeItemId
          ? "Fares are charged when the term is billed, under Fees."
          : "Fares are not billed yet: choose the transport fee item under Settings."
      }
      aside={
        manage ? <RouteDialog action={saveRouteAction.bind(null, slug, null)} vehicles={active} /> : undefined
      }
    >
      {routes.length === 0 ? (
        <EmptyState
          icon={<Bus />}
          title="No routes yet"
          description="Add a route, then its stops in order. Students are put on a stop under Students."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Bus routes</caption>
            <THead>
              <tr>
                <TH>Route</TH>
                <TH className="hidden sm:table-cell">Vehicle</TH>
                <TH className="text-right">Stops</TH>
                <TH className="text-right">Students</TH>
                <TH className="hidden text-right md:table-cell">Fare per term</TH>
              </tr>
            </THead>
            <TBody>
              {routes.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `transport/routes/${r.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.status === "archived" && (
                      <span className="block">
                        <StatusText tone="neutral">Archived</StatusText>
                      </span>
                    )}
                  </TD>
                  <TD className="hidden sm:table-cell">
                    {r.vehicle ?? <span className="text-ink-3">Not chosen</span>}
                  </TD>
                  <TD className="text-right tabular-nums">{r.stops}</TD>
                  <TD className="text-right tabular-nums">{r.riders}</TD>
                  <TD className="hidden text-right tabular-nums md:table-cell">
                    {r.farePesewas === null ? (
                      <span className="text-ink-3">Not set</span>
                    ) : (
                      formatMoney(r.farePesewas, ctx.tenant.currencyCode)
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
