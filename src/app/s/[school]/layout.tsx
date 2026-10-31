import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { db } from "@/server/db/client";
import { listUserSchools } from "@/server/tenancy/service";
import { requireTenant } from "@/web/auth";
import { signOut } from "@/app/actions/sign-out";

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { user, ctx } = await requireTenant(school);
  const schools = await listUserSchools(db(), user.id);
  return (
    <AppShell
      school={{ slug: ctx.tenant.slug, name: ctx.tenant.name }}
      schools={schools.map(({ slug, name }) => ({ slug, name }))}
      roles={ctx.roles}
      user={{ name: user.name, email: user.email }}
      signOut={signOut}
    >
      {children}
    </AppShell>
  );
}
