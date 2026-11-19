import type { Metadata, Route } from "next";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { admissionOptions, listApplications } from "@/server/admissions/service";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import {
  APPLICATION_SOURCE_LABELS,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUSES,
  OPEN_APPLICATION_STATUSES,
  type ApplicationStatus,
} from "@/lib/admissions";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { createApplicationAction } from "./actions";
import { NewApplicationDialog } from "./admission-controls";
import { ExpandingSearch } from "@/components/ui/expanding-search";

export const metadata: Metadata = { title: "Admissions" };

const TONE: Record<ApplicationStatus, "neutral" | "caution" | "positive" | "critical"> = {
  inquiry: "neutral",
  applied: "neutral",
  assessment: "caution",
  offered: "caution",
  enrolled: "positive",
  declined: "critical",
  withdrawn: "neutral",
};

/** The pipeline (ADM-03): open applications by default, then each stage. */
export default async function AdmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const status =
    search.status && (APPLICATION_STATUSES as readonly string[]).includes(search.status)
      ? search.status
      : "open";
  const [list, options] = await Promise.all([
    listApplications(db(), ctx, { status, q: search.q }),
    admissionOptions(db(), ctx),
  ]);
  const base = schoolPath(slug, "admissions");
  const open = OPEN_APPLICATION_STATUSES.reduce((n, s) => n + list.counts[s], 0);
  const tabs: { key: string; label: string; n: number }[] = [
    { key: "open", label: "Open", n: open },
    ...APPLICATION_STATUSES.map((s) => ({
      key: s,
      label: APPLICATION_STATUS_LABELS[s].split(" by ")[0]!,
      n: list.counts[s],
    })),
  ];
  const canManage = allowed(ctx, "admissions.manage");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form id="admission-filters" method="get" className="hidden" aria-label="Find an application">
          <input type="hidden" name="status" value={status} />
        </form>
        <div className="ml-auto flex items-center gap-2">
          <ExpandingSearch
            form="admission-filters"
            defaultValue={search.q}
            placeholder="Name, phone or reference"
            label="Search by name, phone or reference"
            buttonLabel="Find applications"
          />
          {canManage && (
            <NewApplicationDialog
              action={createApplicationAction.bind(null, slug)}
              levels={options.levels}
              terms={options.terms}
            />
          )}
        </div>
      </div>

      <nav aria-label="Stages" className="flex flex-wrap gap-1 border-b border-line pb-1">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`${base}?status=${t.key}` as Route}
            aria-current={status === t.key ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors",
              status === t.key
                ? "bg-subtle font-medium text-ink"
                : "text-ink-2 hover:bg-subtle/60 hover:text-ink",
            )}
          >
            {t.label}
            <span className="text-ink-3 tabular-nums">{t.n}</span>
          </Link>
        ))}
      </nav>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={<UserPlus />}
          title={search.q ? "No matching applications" : "Nothing here"}
          description={
            status === "open"
              ? "Record an inquiry when a family asks about a place, or turn on online applications under Settings."
              : "No applications at this stage."
          }
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Applications</caption>
            <THead>
              <tr>
                <TH>Child</TH>
                <TH>Stage</TH>
                <TH className="hidden md:table-cell">Parent</TH>
                <TH className="hidden lg:table-cell">Source</TH>
                <TH className="hidden sm:table-cell">Updated</TH>
              </tr>
            </THead>
            <TBody>
              {list.rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={`${base}/${r.id}` as Route}
                      className="font-medium text-ink hover:text-accent hover:underline"
                    >
                      {r.childName}
                    </Link>
                    <span className="block text-sm text-ink-3">
                      {r.reference} · {r.levelName}
                      {r.entryTermName ? `, ${r.entryTermName}` : ""}
                    </span>
                  </TD>
                  <TD>
                    <StatusText tone={TONE[r.status]}>{APPLICATION_STATUS_LABELS[r.status]}</StatusText>
                    {r.status === "assessment" && r.assessmentAt && (
                      <span className="block text-sm text-ink-3">
                        {formatDateTime(r.assessmentAt, ctx.tenant.timezone)}
                      </span>
                    )}
                  </TD>
                  <TD className="hidden md:table-cell">
                    {r.guardianName ?? "—"}
                    {r.guardianPhone && (
                      <span className="block text-sm text-ink-3">{formatPhone(r.guardianPhone)}</span>
                    )}
                  </TD>
                  <TD className="hidden lg:table-cell">{APPLICATION_SOURCE_LABELS[r.source]}</TD>
                  <TD className="hidden text-sm text-ink-2 sm:table-cell">
                    {formatDateTime(r.updatedAt, ctx.tenant.timezone)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </div>
  );
}
