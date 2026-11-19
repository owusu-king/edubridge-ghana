import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function BoardingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "boarding.view")) notFound();
  const slug = ctx.tenant.slug;
  const items = [
    { label: "Houses", href: schoolPath(slug, "boarding") },
    { label: "Exeats", href: schoolPath(slug, "boarding/exeats") },
    ...(allowed(ctx, "fees.manage")
      ? [{ label: "Settings", href: schoolPath(slug, "boarding/settings") }]
      : []),
  ];
  return (
    <div className="space-y-8">
      <PageHeader
        title="Boarding"
        description="Houses, rooms and beds, who sleeps where this term, and boarders away on exeat."
      />
      {ctx.modules.boarding?.state === "read_only" && (
        <Alert tone="info">
          Boarding has ended for this school. Houses, boarders and exeats can be viewed and exported, but
          nothing can be changed. Ask EduBridge to add it again to carry on.
        </Alert>
      )}
      {/* In a block of its own: the tab bar's negative margin would otherwise cancel the space below it. */}
      <div>
        <SubNav label="Boarding" items={items} />
      </div>
      {children}
    </div>
  );
}
