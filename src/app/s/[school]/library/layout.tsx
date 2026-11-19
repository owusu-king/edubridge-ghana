import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function LibraryLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "library.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "library.manage");
  const items = [
    { label: "Catalogue", href: schoolPath(slug, "library") },
    { label: "Loans", href: schoolPath(slug, "library/loans") },
    ...(manage || allowed(ctx, "fees.manage")
      ? [{ label: "Settings", href: schoolPath(slug, "library/settings") }]
      : []),
  ];
  return (
    <div className="space-y-8">
      <PageHeader
        title="Library"
        description="The school's books and their copies, who has what and until when, and who is waiting for a book."
      />
      {ctx.modules.library?.state === "read_only" && (
        <Alert tone="info">
          The library has ended for this school. Books and loans can be viewed and exported, but nothing can
          be changed. Ask EduBridge to add it again to carry on.
        </Alert>
      )}
      {/* In a block of its own: the tab bar's negative margin would otherwise cancel the space below it. */}
      <div>
        <SubNav label="Library" items={items} />
      </div>
      {children}
    </div>
  );
}
