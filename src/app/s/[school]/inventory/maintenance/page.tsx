import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Wrench } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listAssetChoices } from "@/server/inventory/assets";
import { listMaintenance } from "@/server/inventory/maintenance";
import { formatDateTime } from "@/lib/format";
import { MAINTENANCE_STATUS_LABELS, PRIORITY_LABELS } from "@/lib/inventory";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { reportMaintenanceAction } from "../actions";
import { MaintenanceDialog } from "../inventory-controls";

export const metadata: Metadata = { title: "Maintenance" };

const STATUS_TONE = {
  open: "caution",
  in_progress: "caution",
  done: "positive",
  cancelled: "neutral",
} as const;

/** Repairs (INV-02c): every member of staff reports; the office sees all, reporters their own. */
export default async function MaintenancePage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "maintenance.report")) notFound();
  const slug = ctx.tenant.slug;
  const all = allowed(ctx, "maintenance.manage") || allowed(ctx, "inventory.view");
  const [requests, assets] = await Promise.all([listMaintenance(db(), ctx), listAssetChoices(db(), ctx)]);
  const open = requests.filter((r) => r.status === "open" || r.status === "in_progress").length;

  return (
    <Section
      title={all ? "Maintenance" : "Your reports"}
      description={requests.length ? (open ? `${open} not done yet.` : "All done.") : undefined}
      aside={
        <MaintenanceDialog
          action={reportMaintenanceAction.bind(null, slug)}
          assets={assets.map((a) => ({
            id: a.id,
            label: [`${a.tag} · ${a.name}`, a.location].filter(Boolean).join(", "),
          }))}
        />
      }
    >
      {requests.length === 0 ? (
        <EmptyState
          icon={<Wrench />}
          title="Nothing reported"
          description="Report a broken window, a leaking tap or a faulty projector, and follow it until it is fixed."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Maintenance requests</caption>
            <THead>
              <tr>
                <TH>Request</TH>
                <TH>Status</TH>
                <TH className="hidden sm:table-cell">Urgency</TH>
                <TH className="hidden md:table-cell">Reported</TH>
              </tr>
            </THead>
            <TBody>
              {requests.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `inventory/maintenance/${r.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {r.reference} · {r.title}
                    </Link>
                    <span className="block text-sm text-ink-3">
                      {[r.location, r.asset].filter(Boolean).join(" · ") || " "}
                    </span>
                  </TD>
                  <TD>
                    <StatusText tone={STATUS_TONE[r.status]}>
                      {MAINTENANCE_STATUS_LABELS[r.status]}
                    </StatusText>
                    {r.assignedTo && <span className="block text-sm text-ink-3">With {r.assignedTo}</span>}
                  </TD>
                  <TD className="hidden sm:table-cell">
                    {r.priority === "urgent" ? (
                      <StatusText tone="critical">{PRIORITY_LABELS[r.priority]}</StatusText>
                    ) : (
                      PRIORITY_LABELS[r.priority]
                    )}
                  </TD>
                  <TD className="hidden md:table-cell">
                    {r.reportedBy}
                    <span className="block text-sm text-ink-3">
                      {formatDateTime(r.reportedAt, ctx.tenant.timezone)}
                    </span>
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
