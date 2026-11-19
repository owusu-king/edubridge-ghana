import type { ReactNode } from "react";
import { SchoolShell } from "@/components/shell/school-shell";
import { requireTenant } from "@/web/auth";

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { user, ctx } = await requireTenant(school);
  return (
    <SchoolShell user={user} ctx={ctx}>
      {children}
    </SchoolShell>
  );
}
