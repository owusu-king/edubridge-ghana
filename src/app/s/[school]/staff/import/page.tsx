import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ImportWizard } from "@/components/imports/import-wizard";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { STAFF_FIELDS } from "@/server/imports/staff";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { checkStaffAction, importStaffAction, uploadStaffAction } from "./actions";

export const metadata: Metadata = { title: "Import staff" };

/** Bringing a school's staff list in from a spreadsheet (2026-11-19): staff records, not accounts. */
export default async function ImportStaffPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "staff.manage") || ctx.campusIds !== null) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <Link
          href={schoolPath(slug, "staff")}
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Staff
        </Link>
        <PageHeader
          title="Import staff"
          description="Bring in your staff list from a spreadsheet: names, contacts, positions, departments and when each person started. This adds staff records; invite the people who will sign in from Members."
        />
      </div>
      <ImportWizard
        fields={STAFF_FIELDS.map(({ key, label, required }) => ({ key, label, required }))}
        noun={{ one: "staff member", many: "staff members" }}
        tips={[
          "One person per row, with a heading row at the top. Only first name and surname are needed.",
          "Teaching and support staff alike: cooks, drivers and security staff can be imported too.",
          "Staff numbers from your old system are kept; people without one get the next number.",
          "Positions and departments not yet on your lists are added, and you see which before importing.",
          "Write dates as day/month/year. Without a start date, today's date is used.",
        ]}
        templateHref="/templates/staff-import.csv"
        done={{ href: schoolPath(slug, "staff"), label: "View staff" }}
        upload={uploadStaffAction.bind(null, slug)}
        check={checkStaffAction.bind(null, slug)}
        runImport={importStaffAction.bind(null, slug)}
      />
    </div>
  );
}
