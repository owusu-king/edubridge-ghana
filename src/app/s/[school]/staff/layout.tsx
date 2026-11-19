import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function StaffLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "staff.view")) notFound();
  const slug = ctx.tenant.slug;
  const readOnly = ctx.modules.staff_hr?.state === "read_only";
  return (
    <div className="space-y-8">
      <PageHeader
        title="Staff"
        description="Everyone who works at the school, with or without an EduBridge account: records, employment, leave and attendance."
      />
      {readOnly && (
        <Alert tone="info">
          Staff and HR has ended for this school. Records can be viewed and documents downloaded, but nothing
          can be changed. Ask EduBridge to add it again to carry on.
        </Alert>
      )}
      <div>
        <SubNav
          label="Staff"
          items={[
            { label: "People", href: schoolPath(slug, "staff") },
            ...(allowed(ctx, "staff.attendance")
              ? [{ label: "Attendance", href: schoolPath(slug, "staff/attendance") }]
              : []),
            ...(allowed(ctx, "staff.manage")
              ? [{ label: "Settings", href: schoolPath(slug, "staff/settings") }]
              : []),
          ]}
        />
      </div>
      {children}
    </div>
  );
}
