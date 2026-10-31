import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { can } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function FeesLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "fees.view")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-6 print:hidden">
        <PageHeader
          title="Fees"
          description="Fee structures, billing, payments and balances."
          bordered={false}
        />
        <SubNav
          label="Fees"
          items={[
            { label: "Fee structure", href: schoolPath(slug, "fees") },
            { label: "Accounts", href: schoolPath(slug, "fees/accounts") },
            { label: "Payments", href: schoolPath(slug, "fees/payments") },
            { label: "Fee items", href: schoolPath(slug, "fees/items") },
          ]}
        />
      </div>
      {children}
    </div>
  );
}
