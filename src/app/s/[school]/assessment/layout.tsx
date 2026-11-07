import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function AssessmentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "assessment.enter")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-6 print:hidden">
        <PageHeader
          title="Assessment"
          description="Scores, report cards and printing, class by class."
          bordered={false}
        />
        <SubNav
          label="Assessment"
          items={[
            { label: "Classes", href: schoolPath(slug, "assessment") },
            { label: "Print runs", href: schoolPath(slug, "assessment/prints") },
            ...(allowed(ctx, "academics.manage")
              ? [{ label: "Setup", href: schoolPath(slug, "assessment/setup") }]
              : []),
          ]}
        />
      </div>
      {children}
    </div>
  );
}
