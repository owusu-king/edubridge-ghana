import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { can } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "school.settings.manage")) notFound();
  const items = [
    { label: "Profile", href: schoolPath(ctx.tenant.slug, "settings") },
    ...(can(ctx.roles, "campuses.manage")
      ? [{ label: "Campuses", href: schoolPath(ctx.tenant.slug, "settings/campuses") }]
      : []),
    ...(can(ctx.roles, "plan.view")
      ? [{ label: "Plan", href: schoolPath(ctx.tenant.slug, "settings/plan") }]
      : []),
    ...(can(ctx.roles, "audit.view")
      ? [{ label: "Audit log", href: schoolPath(ctx.tenant.slug, "settings/audit") }]
      : []),
  ];
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <PageHeader title="Settings" description="School profile and configuration." bordered={false} />
        <SubNav label="Settings" items={items} />
      </div>
      {children}
    </div>
  );
}
