import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listVehicles } from "@/server/transport/setup";
import { formatPhone } from "@/lib/phone";
import { requireTenant } from "@/web/auth";
import { saveVehicleAction, setVehicleArchivedAction } from "../actions";
import { VehicleDialog } from "../transport-controls";

export const metadata: Metadata = { title: "Transport · Vehicles" };

/** The school's vehicles, drivers and attendants (TRN-01a). */
export default async function TransportVehiclesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transport.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "transport.manage");
  const vehicles = await listVehicles(db(), ctx);
  const person = (name: string | null, phone: string | null) =>
    [name, phone && formatPhone(phone)].filter(Boolean).join(", ") || "—";

  return (
    <Section
      title="Vehicles"
      description="Drivers and attendants do not need an EduBridge account."
      aside={manage ? <VehicleDialog action={saveVehicleAction.bind(null, slug, null)} /> : undefined}
    >
      {vehicles.length === 0 ? (
        <p className="text-base text-ink-3">No vehicles yet.</p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Vehicles</caption>
            <THead>
              <tr>
                <TH>Vehicle</TH>
                <TH className="hidden sm:table-cell">Driver</TH>
                <TH className="hidden md:table-cell">Attendant</TH>
                {manage && (
                  <TH>
                    <span className="sr-only">Change</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {vehicles.map((v) => (
                <TR key={v.id}>
                  <TD>
                    <span className="font-medium text-ink">{v.name}</span>
                    <span className="block text-sm text-ink-3">
                      {[v.registration, v.seats && `${v.seats} seats`].filter(Boolean).join(" · ") || " "}
                    </span>
                    {v.status === "archived" && <StatusText tone="neutral">Archived</StatusText>}
                  </TD>
                  <TD className="hidden sm:table-cell">{person(v.driverName, v.driverPhone)}</TD>
                  <TD className="hidden md:table-cell">{person(v.attendantName, v.attendantPhone)}</TD>
                  {manage && (
                    <TD className="text-right">
                      <div className="inline-flex flex-wrap justify-end gap-2">
                        {v.status === "active" && (
                          <VehicleDialog
                            action={saveVehicleAction.bind(null, slug, v.id)}
                            vehicle={{
                              ...v,
                              displayPhone: {
                                driver: v.driverPhone ? formatPhone(v.driverPhone) : "",
                                attendant: v.attendantPhone ? formatPhone(v.attendantPhone) : "",
                              },
                            }}
                          />
                        )}
                        <ActionButton
                          action={setVehicleArchivedAction.bind(null, slug, v.id, v.status === "active")}
                          label={v.status === "active" ? "Archive" : "Restore"}
                          variant={v.status === "active" ? "danger-outline" : "secondary"}
                          ariaLabel={`${v.status === "active" ? "Archive" : "Restore"} ${v.name}`}
                        />
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
