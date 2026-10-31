import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { db } from "@/server/db/client";
import { isPlatformAdmin } from "@/server/platform/service";
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
  const [schools, platformAdmin] = await Promise.all([
    listUserSchools(db(), user.id),
    isPlatformAdmin(db(), user.id),
  ]);
  return (
    <AppShell
      area={{
        kind: "school",
        school: { slug: ctx.tenant.slug, name: ctx.tenant.name },
        schools: schools.map(({ slug, name }) => ({ slug, name })),
        roles: ctx.roles,
      }}
      user={{ name: user.name, email: user.email }}
      isPlatformAdmin={platformAdmin}
      signOut={signOut}
    >
      {children}
    </AppShell>
  );
}
