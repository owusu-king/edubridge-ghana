import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ScrollText } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listAuditEvents } from "@/server/members/service";
import { auditLabel, auditSummary } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Settings · Audit log" };

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const [{ school }, { before }] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "audit.view")) notFound();
  const { entries, nextCursor } = await listAuditEvents(db(), ctx, before);
  const base = schoolPath(ctx.tenant.slug, "settings/audit");

  return (
    <Section
      title="Audit log"
      description="Sensitive changes at this school, newest first. Entries cannot be edited or deleted."
    >
      {entries.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title="No entries"
          description="Changes to the school, campuses and members appear here."
        />
      ) : (
        <div className="space-y-4">
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Who</TH>
                  <TH>What</TH>
                  <TH className="hidden md:table-cell">Details</TH>
                </tr>
              </THead>
              <TBody>
                {entries.map((entry) => (
                  <TR key={entry.id}>
                    <TD className="whitespace-nowrap">
                      {formatDateTime(entry.occurredAt, ctx.tenant.timezone)}
                    </TD>
                    <TD className="text-ink">
                      {entry.actorName ?? <span className="text-ink-3">System</span>}
                    </TD>
                    <TD className="text-ink">{auditLabel(entry.action)}</TD>
                    <TD
                      className="hidden max-w-md truncate md:table-cell"
                      title={auditSummary(entry.metadata)}
                    >
                      {auditSummary(entry.metadata) || <span className="text-ink-3">—</span>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
          <nav aria-label="Audit log pages" className="flex justify-end gap-2">
            {before && (
              <Link href={base} className={buttonStyles("secondary", "sm")}>
                Newest
              </Link>
            )}
            {nextCursor && (
              <Link
                href={`${base}?before=${encodeURIComponent(nextCursor)}` as Route}
                className={buttonStyles("secondary", "sm")}
              >
                Older entries
              </Link>
            )}
          </nav>
        </div>
      )}
    </Section>
  );
}
