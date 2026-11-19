import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function TransportLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const view = allowed(ctx, "transport.view");
  const trips = allowed(ctx, "transport.trips");
  if (!view && !trips) notFound();
  const slug = ctx.tenant.slug;
  const items = [
    ...(view ? [{ label: "Routes", href: schoolPath(slug, "transport") }] : []),
    ...(view ? [{ label: "Students", href: schoolPath(slug, "transport/students") }] : []),
    ...(trips ? [{ label: "Trips", href: schoolPath(slug, "transport/trips") }] : []),
    ...(view ? [{ label: "Vehicles", href: schoolPath(slug, "transport/vehicles") }] : []),
    ...(view ? [{ label: "Settings", href: schoolPath(slug, "transport/settings") }] : []),
  ];
  return (
    <div className="space-y-8">
      <PageHeader
        title="Transport"
        description="School buses: routes and stops, who rides them, fares through the term's fees, and each day's trips."
      />
      {ctx.modules.transport?.state === "read_only" && (
        <Alert tone="info">
          Transport has ended for this school. Routes, students and trips can be viewed and exported, but
          nothing can be changed. Ask EduBridge to add it again to carry on.
        </Alert>
      )}
      {items.length > 1 && (
        // In a block of its own: the tab bar's negative margin would otherwise cancel the space below it.
        <div>
          <SubNav label="Transport" items={items} />
        </div>
      )}
      {children}
    </div>
  );
}
