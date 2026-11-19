import type { ReactNode } from "react";
import { accentStyleSheet, schoolLogoUrl } from "@/lib/branding";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { isPlatformAdmin } from "@/server/platform/service";
import { getLiveSupportGrant } from "@/server/support/access";
import { getBranding } from "@/server/tenancy/branding";
import { listUserSchools, type TenantContext } from "@/server/tenancy/service";
import { signOut } from "@/app/actions/sign-out";
import { AppShell } from "./app-shell";

/**
 * A school's frame: its sidebar, its brand colour, and the notice that belongs above every page (support
 * access, demo school, an overdue EduBridge invoice). Used by the school's own pages and by the account
 * pages, which keep the school the person came from around them.
 */
export async function SchoolShell({
  user,
  ctx,
  children,
}: {
  user: { id: string; name: string; email: string };
  ctx: TenantContext;
  children: ReactNode;
}) {
  const [schools, platformAdmin, supportGrant, branding] = await Promise.all([
    listUserSchools(db(), user.id),
    isPlatformAdmin(db(), user.id),
    getLiveSupportGrant(db(), ctx),
    getBranding(db(), ctx),
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
  // The school's accent colour (contrast-checked when saved) replaces EduBridge blue throughout.
  const accent = accentStyleSheet(branding.brandColor);
  return (
    <>
      {accent && <style>{accent}</style>}
      <AppShell
        area={{
          kind: "school",
          school: {
            slug: ctx.tenant.slug,
            name: ctx.tenant.name,
            logoUrl: schoolLogoUrl(ctx.tenant.slug, branding.logoFileId),
          },
          schools: schools.map(({ slug, name }) => ({ slug, name })),
          roles: ctx.roles,
          features: ctx.features,
          // Read-only modules (ENT-08) keep their pages in the navigation; only the state crosses to the client.
          modules: Object.fromEntries(Object.entries(ctx.modules).map(([id, m]) => [id, { state: m.state }])),
        }}
        user={{ name: user.name, email: user.email }}
        isPlatformAdmin={platformAdmin}
        signOut={signOut}
        notice={notice}
      >
        {children}
      </AppShell>
    </>
  );
}
