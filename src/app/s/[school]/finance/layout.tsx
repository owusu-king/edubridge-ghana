import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

/** The school's money beyond fees (2026-11-18): income against spending, expenses, cash to bank, bank statements. */
export default async function FinanceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "finance.view")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-6 print:hidden">
        <PageHeader
          title="Finances"
          description="Money in and out of the school: what it spends, cash taken to the bank, and the bank's own statement."
          bordered={false}
        />
        <SubNav
          label="Finances"
          items={[
            { label: "Income and spending", href: schoolPath(slug, "finance") },
            { label: "Expenses", href: schoolPath(slug, "finance/expenses") },
            { label: "Cash to bank", href: schoolPath(slug, "finance/deposits") },
            { label: "Bank statements", href: schoolPath(slug, "finance/bank") },
            { label: "Accounts", href: schoolPath(slug, "finance/accounts") },
          ]}
        />
      </div>
      {ctx.campusIds !== null ? (
        <p className="text-base text-ink-2">
          The school&apos;s accounts and spending cover every campus, so they are kept by someone with access
          to every campus.
        </p>
      ) : (
        children
      )}
    </div>
  );
}
