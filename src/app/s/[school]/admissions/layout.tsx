import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function AdmissionsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "admissions.view")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <PageHeader
          title="Admissions"
          description="Families asking about a place, through applications and offers to enrolment."
          bordered={false}
        />
        <SubNav
          label="Admissions"
          items={[
            { label: "Applications", href: schoolPath(slug, "admissions") },
            { label: "Report", href: schoolPath(slug, "admissions/report") },
            ...(allowed(ctx, "admissions.manage") || allowed(ctx, "fees.manage")
              ? [{ label: "Settings", href: schoolPath(slug, "admissions/settings") }]
              : []),
          ]}
        />
      </div>
      {children}
    </div>
  );
}
