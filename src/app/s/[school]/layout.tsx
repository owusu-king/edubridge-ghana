import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { db } from "@/server/db/client";
import { isPlatformAdmin } from "@/server/platform/service";
import { listUserSchools } from "@/server/tenancy/service";
import { allowed } from "@/server/authz/permissions";
import { getLiveSupportGrant } from "@/server/support/access";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
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
  const [schools, platformAdmin, supportGrant] = await Promise.all([
    listUserSchools(db(), user.id),
    isPlatformAdmin(db(), user.id),
    getLiveSupportGrant(db(), ctx),
  ]);
  const until = (date: Date) => formatDateTime(date, ctx.tenant.timezone);
  const seesBilling = allowed(ctx, "plan.view") || allowed(ctx, "fees.view");
  const notice = ctx.support ? (
    <>
      <strong className="font-semibold">You are here as EduBridge support</strong> until{" "}
      {until(ctx.support.expiresAt)}. Every page you open and every change you make is recorded and shown to
      the Proprietor.
    </>
  ) : supportGrant ? (
    <>
      <strong className="font-semibold">EduBridge support can open this school</strong> until{" "}
      {until(supportGrant.expiresAt)}. You can end it at any time under Settings, Support access.
    </>
  ) : ctx.tenant.isDemo ? (
    <>
      <strong className="font-semibold">Demo school.</strong> Every name, number and figure here is made up.
      Messages are recorded but never sent, and families cannot sign in.
    </>
  ) : seesBilling && ctx.billing.state === "limited" ? (
    <>
      <strong className="font-semibold">SMS to families are paused.</strong> An EduBridge invoice is overdue.
      Everything else works as usual, and SMS resume as soon as it is paid.
    </>
  ) : seesBilling && ctx.billing.state === "grace" && ctx.billing.graceEndsOn ? (
    <>
      <strong className="font-semibold">An EduBridge invoice is overdue.</strong> SMS to families will pause
      after {formatCalendarDate(ctx.billing.graceEndsOn)} unless it is paid.
    </>
  ) : undefined;
  return (
    <AppShell
      area={{
        kind: "school",
        school: { slug: ctx.tenant.slug, name: ctx.tenant.name },
        schools: schools.map(({ slug, name }) => ({ slug, name })),
        roles: ctx.roles,
        features: ctx.features,
      }}
      user={{ name: user.name, email: user.email }}
      isPlatformAdmin={platformAdmin}
      signOut={signOut}
      notice={notice}
    >
      {children}
    </AppShell>
  );
}
