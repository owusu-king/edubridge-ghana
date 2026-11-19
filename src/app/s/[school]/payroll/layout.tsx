import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function PayrollLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const staffView = allowed(ctx, "payroll.view");
  if (!staffView && !allowed(ctx, "payroll.own")) notFound();
  const slug = ctx.tenant.slug;
  const readOnly = ctx.modules.payroll?.state === "read_only";
  return (
    <div className="space-y-8">
      <PageHeader
        title={staffView ? "Payroll" : "Payslips"}
        description={
          staffView
            ? "Salaries, each month's payroll and payslips. EduBridge keeps the record; it does not pay anyone."
            : "Your payslips from each approved month."
        }
      />
      {readOnly && (
        <Alert tone="info">
          Payroll records have ended for this school. Payroll can be viewed and exported, but nothing can be
          changed. Ask EduBridge to add it again to carry on.
        </Alert>
      )}
      {staffView && (
        <SubNav
          label="Payroll"
          items={[
            { label: "Months", href: schoolPath(slug, "payroll") },
            { label: "Salaries", href: schoolPath(slug, "payroll/people") },
            { label: "Components", href: schoolPath(slug, "payroll/components") },
          ]}
        />
      )}
      {children}
    </div>
  );
}
