import type { ReactNode } from "react";
import type { Route } from "next";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { Alert } from "@/components/ui/alert";
import { hasMfa } from "@/server/auth/mfa";
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
  const [schools, platformAdmin, mfaOn] = await Promise.all([
    listUserSchools(db(), user.id),
    isPlatformAdmin(db(), user.id),
    hasMfa(db(), user.id),
  ]);
  // D-03: owners and bursars must use two-step verification; financial features will enforce it.
  const mfaExpected = ctx.roles.includes("owner") || ctx.roles.includes("bursar");
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
      notice={
        mfaExpected && !mfaOn ? (
          <Alert tone="info">
            Owners and bursars must use two-step verification.{" "}
            <Link href={"/account/security" as Route} className="font-medium underline">
              Set it up now
            </Link>
            .
          </Alert>
        ) : undefined
      }
    >
      {children}
    </AppShell>
  );
}
