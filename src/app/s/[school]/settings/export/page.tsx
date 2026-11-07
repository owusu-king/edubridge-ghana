import type { Metadata, Route } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { DATASETS, type Dataset } from "@/server/export/datasets";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Settings · Data export" };

export default async function DataExportPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const available = (Object.keys(DATASETS) as Dataset[]).filter((d) => allowed(ctx, DATASETS[d].permission));
  if (available.length === 0) notFound();
  const slug = ctx.tenant.slug;

  return (
    <Section
      title="Data export"
      description="Your school's records as CSV files, which open in Excel or Google Sheets. Each file covers the whole school and every term. Downloads are recorded in the audit log."
    >
      {ctx.campusIds !== null ? (
        <Alert tone="info">
          Exports cover the whole school, and your access is limited to some campuses. Ask a colleague with
          access to every campus.
        </Alert>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {available.map((dataset) => (
            <li
              key={dataset}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-ink">{DATASETS[dataset].name}</h3>
                <p className="text-sm text-ink-3">{DATASETS[dataset].description}</p>
              </div>
              {/* A plain link: the browser downloads the file. */}
              <a
                href={schoolPath(slug, `settings/export/${dataset}`) as Route}
                download
                aria-label={`Download ${DATASETS[dataset].name} as CSV`}
                className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-accent hover:underline"
              >
                <Download aria-hidden="true" className="size-4" />
                Download CSV
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-3">
        Amounts are in cedis with two decimal places; dates are written as year-month-day. Files contain
        personal information about students and families: store and share them with care.
      </p>
    </Section>
  );
}
