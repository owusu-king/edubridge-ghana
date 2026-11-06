import type { Metadata } from "next";
import { FileDown, Printer } from "lucide-react";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Badge, StatusText } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/layout";
import { listReportCardBatches } from "@/server/assessment/batches";
import { db } from "@/server/db/client";
import { formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Print runs" };

const STATUS = {
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Preparing", tone: "caution" },
  done: { label: "Ready", tone: "positive" },
  failed: { label: "Failed", tone: "critical" },
} as const;

function size(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export default async function PrintRunsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const batches = await listReportCardBatches(db(), ctx);
  const working = batches.some((b) => b.status === "queued" || b.status === "running");

  if (batches.length === 0) {
    return (
      <EmptyState
        icon={<Printer />}
        title="No print runs yet"
        description="Open a class with published report cards and choose Print report cards. The PDFs appear here, one per class, and are kept for 7 days."
      />
    );
  }

  return (
    <div className="space-y-4">
      {working && <AutoRefresh everyMs={3000} />}
      <p className="text-sm text-ink-3">
        One PDF per class, a page per student. Print runs are removed after 7 days.
      </p>
      <ul className="space-y-4">
        {batches.map((batch) => (
          <li key={batch.id} className="rounded-lg border border-line bg-surface shadow-raised">
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5">
              <div>
                <p className="font-medium text-ink">
                  {batch.termName} · {batch.classCount} {batch.classCount === 1 ? "class" : "classes"}
                </p>
                <p className="text-sm text-ink-3">
                  {formatDateTime(batch.createdAt, ctx.tenant.timezone)}
                  {batch.requestedBy ? ` · ${batch.requestedBy}` : ""}
                </p>
              </div>
              <StatusText tone={STATUS[batch.status].tone}>
                {batch.status === "running" || batch.status === "queued"
                  ? `${STATUS[batch.status].label}: ${batch.files.length} of ${batch.classCount} classes`
                  : STATUS[batch.status].label}
              </StatusText>
            </div>
            {batch.files.length > 0 && (
              <ul className="divide-y divide-line">
                {batch.files.map((file) => (
                  <li key={file.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <div>
                      <p className="text-base text-ink">{file.className}</p>
                      <p className="text-sm text-ink-3">
                        {file.reportCount === 0
                          ? "No published report cards"
                          : `${file.reportCount} ${file.reportCount === 1 ? "report card" : "report cards"} · ${size(file.byteSize)}`}
                      </p>
                    </div>
                    {file.reportCount > 0 ? (
                      <a
                        href={`${schoolPath(slug, `assessment/prints/${file.id}`)}`}
                        className="-mr-2 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent-soft"
                        aria-label={`Download ${file.className} report cards (PDF)`}
                      >
                        <FileDown aria-hidden="true" className="size-4" />
                        PDF
                      </a>
                    ) : (
                      <Badge>Skipped</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {batch.status === "failed" && (
              <p className="px-5 py-3 text-sm text-critical">
                This print run stopped after repeated errors. Try again from the class page.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
