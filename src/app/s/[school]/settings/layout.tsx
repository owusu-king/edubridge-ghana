import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { settingsTabs } from "@/components/shell/navigation";
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
  const items = settingsTabs(ctx.tenant.slug, ctx.roles);
  if (items.length === 0) notFound();
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
