import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

/** Early warning (R5-3): indicators, support plans and the school's rules. */
export default async function EarlyWarningLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "early_warning.view")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <PageHeader
          title="Early warning"
          description="Students who may need support, from this term's registers and report cards. The records show what happened; a teacher decides what it means. Never shown to families or students."
          bordered={false}
        />
        <div>
          <SubNav
            label="Early warning"
            items={[
              { label: "Indicators", href: schoolPath(slug, "early-warning") },
              { label: "Support plans", href: schoolPath(slug, "early-warning/plans") },
              { label: "Rules", href: schoolPath(slug, "early-warning/rules") },
            ]}
          />
        </div>
      </div>
      {children}
    </div>
  );
}
