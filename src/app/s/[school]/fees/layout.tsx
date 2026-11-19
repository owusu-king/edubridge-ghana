import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
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
  if (!allowed(ctx, "fees.view")) notFound();
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
            { label: "Owing", href: schoolPath(slug, "fees/owing") },
            { label: "Payments", href: schoolPath(slug, "fees/payments") },
            ...(allowed(ctx, "payments.record")
              ? [{ label: "Take payments offline", href: schoolPath(slug, "fees/offline-payments") }]
              : []),
            { label: "Mobile Money", href: schoolPath(slug, "fees/mobile-money") },
            { label: "Families", href: schoolPath(slug, "fees/families") },
            { label: "Fee items", href: schoolPath(slug, "fees/items") },
            { label: "Reports", href: schoolPath(slug, "fees/reports") },
            ...(allowed(ctx, "forecasting.view")
              ? [{ label: "Forecast", href: schoolPath(slug, "fees/forecast") }]
              : []),
            ...(allowed(ctx, "finance_checks.review")
              ? [{ label: "Checks", href: schoolPath(slug, "fees/checks") }]
              : []),
            { label: "Refunds and approvals", href: schoolPath(slug, "fees/approvals") },
            { label: "Closing", href: schoolPath(slug, "fees/closing") },
          ]}
        />
      </div>
      {children}
    </div>
  );
}
