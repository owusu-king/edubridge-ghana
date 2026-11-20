import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { IMPORT_FIELDS } from "@/server/imports/students";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { checkAction, importAction, uploadAction } from "./actions";
import { ImportWizard } from "@/components/imports/import-wizard";

export const metadata: Metadata = { title: "Import students" };

export default async function ImportPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "students.manage")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <Link
          href={schoolPath(slug, "students")}
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Students
        </Link>
        <PageHeader
          title="Import students"
          description="Bring in students, their class this term and their primary guardian from a spreadsheet."
        />
      </div>
      <ImportWizard
        fields={IMPORT_FIELDS.map(({ key, label, required }) => ({ key, label, required }))}
        noun={{ one: "student", many: "students" }}
        tips={[
          "One student per row, with a heading row at the top.",
          "First name, surname and sex are needed. Sex can be F or M.",
          "Class names must match the names on your Classes page.",
          "Write dates as day/month/year, e.g. 14/03/2018.",
          "Brothers and sisters with the same guardian phone number are linked automatically.",
        ]}
        templateHref="/templates/students-import.csv"
        done={{ href: schoolPath(slug, "students"), label: "View students" }}
        upload={uploadAction.bind(null, slug)}
        check={checkAction.bind(null, slug)}
        runImport={importAction.bind(null, slug)}
      />
    </div>
  );
}
