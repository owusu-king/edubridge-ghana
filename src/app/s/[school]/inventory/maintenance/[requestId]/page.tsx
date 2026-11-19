import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getMaintenance } from "@/server/inventory/maintenance";
import { formatDateTime } from "@/lib/format";
import { MAINTENANCE_NEXT, MAINTENANCE_STATUS_LABELS, PRIORITY_LABELS } from "@/lib/inventory";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { updateMaintenanceAction } from "../../actions";
import { MaintenanceUpdateDialog } from "../../inventory-controls";

export const metadata: Metadata = { title: "Maintenance request" };

/** One maintenance request and every change to it (INV-02c). */
export default async function MaintenanceRequestPage({
  params,
}: {
  params: Promise<{ school: string; requestId: string }>;
}) {
  const { school, requestId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "maintenance.report")) notFound();
  const r = await getMaintenance(db(), ctx, requestId);
  if (!r) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const canUpdate = allowed(ctx, "maintenance.manage") && MAINTENANCE_NEXT[r.status].length > 0;

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "inventory/maintenance") as Route}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Maintenance
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">
            {r.reference} · {r.title}
          </h2>
          <p className="mt-1 text-base text-ink-2">
            {[r.location, r.asset, `${PRIORITY_LABELS[r.priority]} urgency`].filter(Boolean).join(" · ")}
          </p>
          <StatusText
            tone={r.status === "done" ? "positive" : r.status === "cancelled" ? "neutral" : "caution"}
          >
            {MAINTENANCE_STATUS_LABELS[r.status]}
            {r.assignedTo ? `, with ${r.assignedTo}` : ""}
          </StatusText>
        </div>
        {canUpdate && (
          <MaintenanceUpdateDialog
            action={updateMaintenanceAction.bind(null, slug, r.id)}
            status={r.status}
            assignedTo={r.assignedTo}
          />
        )}
      </div>

      {r.description && <p className="max-w-2xl text-base text-ink-2">{r.description}</p>}

      <Section title="History">
        <ul className="divide-y divide-line border-y border-line">
          {r.updates.map((u) => (
            <li key={u.id} className="py-3 text-base text-ink">
              {[u.status && MAINTENANCE_STATUS_LABELS[u.status], u.assignedTo && `with ${u.assignedTo}`]
                .filter(Boolean)
                .join(", ") || "Note"}
              {u.note && <span className="block text-ink-2">{u.note}</span>}
              <span className="block text-sm text-ink-3">
                {formatDateTime(u.at, tz)} · {u.by}
              </span>
            </li>
          ))}
          <li className="py-3 text-base text-ink">
            Reported by {r.reportedBy}
            <span className="block text-sm text-ink-3">{formatDateTime(r.reportedAt, tz)}</span>
          </li>
        </ul>
      </Section>
    </div>
  );
}
