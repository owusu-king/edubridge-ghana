import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { requireTenant } from "@/web/auth";

export default async function AttendanceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "attendance.take")) notFound();
  return (
    <div className="space-y-8">
      <PageHeader
        title="Attendance"
        description="Class registers, day by day. They work without a connection too."
      />
      {children}
    </div>
  );
}
