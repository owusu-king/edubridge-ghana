import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function EventsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "events.view")) notFound();
  const slug = ctx.tenant.slug;
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <PageHeader
          title="Events"
          description="What is coming up for the school, a campus, a level or a class, and the consent forms families answer."
          bordered={false}
        />
        <SubNav
          label="Events"
          items={[
            { label: "Coming", href: schoolPath(slug, "events") },
            { label: "Past", href: schoolPath(slug, "events/past") },
            ...(allowed(ctx, "consent.view")
              ? [{ label: "Consent forms", href: schoolPath(slug, "events/forms") }]
              : []),
          ]}
        />
      </div>
      {children}
    </div>
  );
}
